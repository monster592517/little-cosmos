#!/usr/bin/env node
/**
 * 深空天体目录构建器 —— OpenNGC (Mattia Verga, CC BY-SA 4.0)
 *
 * 抓取并归一化河外星系与银河系内深空天体，供多尺度宇宙图的
 * 「银河系 / 本星系群」层级使用。
 *
 *  原始数据：data/raw/openngc/{NGC.csv, addendum.csv}
 *  产物：    data/deep-sky.json
 *
 * 用法：node tools/build-deepsky.mjs [--force]
 *   --force  强制重新下载原始数据（默认已存在则跳过，便于离线重跑）
 *
 * 仅使用 Node 内置模块（含 Node 22 自带 fetch），无第三方依赖。
 */
import { mkdir, writeFile, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW_DIR = path.join(ROOT, 'data', 'raw', 'openngc');
const OUT_FILE = path.join(ROOT, 'data', 'deep-sky.json');
const force = process.argv.includes('--force');

/* ---------------- 数据源 ---------------- */
const RAW_BASE = 'https://raw.githubusercontent.com/mattiaverga/OpenNGC/master';
const MIRROR_BASE = 'https://github.com/mattiaverga/OpenNGC/raw/master';
const FILES = [
  { name: 'NGC.csv', rel: 'database_files/NGC.csv' },
  { name: 'addendum.csv', rel: 'database_files/addendum.csv' },
  { name: 'LICENSE', rel: 'LICENSES/CC-BY-SA-4.0.txt' },
];

/* ---------------- 常量 ---------------- */
const H0_MLY_PER_Z = 13970; // c/H0 换算：z → Mly（H0 = 70 km/s/Mpc）

// 哈勃流可信下限：z ≥ 0.004 等价于 cz ≥ 1200 km/s。
// 低于此值时星系的本动速度（可达数百 km/s）与哈勃流同量级，红移距离会严重失真；
// 本星系群天体多是蓝移，直接代入哈勃定律会算出「负距离」（M31 得 −13.97 Mly）。
// 这类近距星系不做红移推算，交给前端「近邻星系实测距离表」按真实测量值覆盖。
const HUBBLE_FLOW_MIN_Z = 0.004;

// 河外星系距离：由红移按哈勃定律推算
// 银河系内天体：按类型的代表性距离（Mly）
const MW_DIST_MLY = {
  globular: 0.020,
  opencluster: 0.003,
  nebula: 0.005,
  planetarynebula: 0.005,
  snr: 0.005,
  doublestar: 0.0005,
  star: 0.0005,
};

/**
 * OpenNGC Type → 归一化类型。
 *
 * ⚠️ 未列出的类型会被丢弃，而**丢弃是要记账**的（见下面 led.droppedUnknownType）——
 * 这道台账就是这么发现 `Other` / `Nova` 两类一直在被静默丢掉的：
 *   · `Other` 419 条（IC 目录里只登记了编号与坐标的条目）
 *   · `Nova`  3 条
 * 两者都有精确 RA/Dec，按「有精确位置就该在」的口径收进来。
 * 真正该丢的只有两类，而且现在它们出现在台账里、看得见：
 *   · `Dup`   —— OpenNGC 自己标注的**重复条目**（收进来会让同一天体出现两次）
 *   · `NonEx` —— 已被证认**不存在**的天体（历史上的观测错误 / 底片瑕疵）
 */
const TYPE_MAP = {
  G: 'galaxy',
  GPair: 'galaxy',
  GTrpl: 'galaxy',
  GGroup: 'galaxy',
  GCl: 'globular',
  OCl: 'opencluster',
  '*Ass': 'opencluster',
  PN: 'planetarynebula',
  HII: 'nebula',
  Neb: 'nebula',
  RfN: 'nebula',
  EmN: 'nebula',
  DrkN: 'nebula',
  'Cl+N': 'nebula',
  SNR: 'snr',
  '**': 'doublestar',
  'Y*': 'doublestar',
  '*': 'star',
  // 见 TYPE_MAP 上方的说明：这两类**有位置**，收；Dup / NonEx 才是该丢的
  Other: 'unclassified',
  Nova: 'nova',
};

/* ---------------- 工具函数 ---------------- */
const num = (s) => {
  if (s == null) return null;
  const t = String(s).trim();
  if (t === '') return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
};

const round = (v, n) => (v == null ? null : Number(v.toFixed(n)));

/** 赤经 HH:MM:SS.ss → 十进制度 */
function raToDeg(s) {
  if (!s) return null;
  const p = String(s).trim().split(':');
  if (p.length < 2) return null;
  const h = Number(p[0]);
  const m = Number(p[1]);
  const sec = Number(p[2] ?? 0);
  if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(sec)) return null;
  return (h + m / 60 + sec / 3600) * 15;
}

/** 赤纬 ±DD:MM:SS.s → 十进制度（正确处理负号） */
function decToDeg(s) {
  if (!s) return null;
  let t = String(s).trim();
  if (t === '') return null;
  let sign = 1;
  if (t[0] === '-') {
    sign = -1;
    t = t.slice(1);
  } else if (t[0] === '+') {
    t = t.slice(1);
  }
  const p = t.split(':');
  if (p.length < 2) return null;
  const d = Number(p[0]);
  const m = Number(p[1]);
  const sec = Number(p[2] ?? 0);
  if (!Number.isFinite(d) || !Number.isFinite(m) || !Number.isFinite(sec)) return null;
  return sign * (Math.abs(d) + m / 60 + sec / 3600);
}

/** 去掉数字串的前导零 */
const stripZeros = (digits) => digits.replace(/^0+(?=\d)/, '');

/** OpenNGC 名称 → id：小写、去掉数字段的前导零 */
function nameToId(name) {
  const lower = name.toLowerCase();
  const m = lower.match(/^([a-z]+)0*(\d+)(.*)$/);
  if (!m) return lower;
  return `${m[1]}${m[2]}${m[3]}`;
}

/** OpenNGC 名称 → 规范展示名：补空格、去前导零 */
function nameToDisplay(name) {
  const m = name.match(/^([A-Za-z]+)(\d+)(.*)$/);
  if (!m) return name;
  return `${m[1]} ${stripZeros(m[2])}${m[3]}`;
}

/* ---------------- 分号 CSV 解析（引号感知） ---------------- */
/** 解析分号分隔文本，支持双引号包围、转义 ""、字段内换行 */
function parseDelimited(text) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let fieldStart = true;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"' && fieldStart) {
      inQuotes = true;
      fieldStart = false;
      continue;
    }
    if (c === ';') {
      row.push(field);
      field = '';
      fieldStart = true;
      continue;
    }
    if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      fieldStart = true;
      continue;
    }
    if (c === '\r') continue;
    field += c;
    fieldStart = false;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/* ---------------- 下载（已存在则跳过） ---------------- */
async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

async function ensureRawFiles() {
  await mkdir(RAW_DIR, { recursive: true });
  for (const f of FILES) {
    const dest = path.join(RAW_DIR, f.name);
    if (!force && (await exists(dest))) {
      console.log(`[skip] ${f.name} 已存在`);
      continue;
    }
    let buf = null;
    let used = '';
    for (const base of [RAW_BASE, MIRROR_BASE]) {
      const url = `${base}/${f.rel}`;
      try {
        buf = await download(url);
        used = base.includes('raw.githubusercontent') ? 'raw.githubusercontent.com' : 'github.com/raw';
        break;
      } catch (e) {
        console.warn(`[warn] ${url} 失败: ${e.message}`);
      }
    }
    if (!buf) throw new Error(`无法下载 ${f.name}`);
    await writeFile(dest, buf);
    console.log(`[downloaded] ${f.name} (${buf.length} B) via ${used}`);
  }
}

/* ---------------- 主流程 ---------------- */
async function main() {
  await ensureRawFiles();

  const inputFiles = ['NGC.csv', 'addendum.csv'].map((n) => path.join(RAW_DIR, n));

  const objects = [];
  const seen = new Set();
  const typeCount = {};
  const scopeCount = {};
  let noDistanceCount = 0;
  let messierCount = 0;
  let unknownNearbyCount = 0;    // 红移过小、无法用哈勃定律定距的近距河外星系
  let negativeRedshiftCount = 0; // 蓝移星系（本动速度主导的直接证据）

  /* ---------- 吸纳台账 ----------
   * 源表里的**每一行**都要有去处：要么变成 objects 里的一条，要么被下面某一项点名丢弃。
   * 这几行不光是为了日志好看 —— 它们会跟着产物进 `meta`，
   * `tools/model-probe.mjs` 的「吸纳率」判据拿它当账本核对（少一行就报红）。
   * 为什么要这样：这套目录原来有一道 `mag > 12.5` 的门槛，把 12,950 条里的
   * 10,507 条（含 9,214 个星系）**静默丢掉了**，而 meta 里只有一个 `count`，
   * 没有任何数字能拿来对照「本来该有多少」。
   */
  /* 丢弃要**分类**记账：「OpenNGC 自己说是重复条目」和「OpenNGC 说是观测错误、天体不存在」
   * 与「这个类型我们不认识」是三件完全不同的事，合成一个数就没法判断"丢得对不对"。
   * `droppedUnknownType` 是这里唯一需要**人看一眼**的数 ——
   * 上游哪天新增一个 Type，它会从 0 变成非零，提醒有人去做决定。 */
  const led = {
    fetchedRows: 0, droppedBlankRow: 0, droppedNoName: 0,
    droppedDuplicate: 0,      // Type=Dup：OpenNGC 标注的重复条目
    droppedNonexistent: 0,    // Type=NonEx：已被证认不存在（观测错误/底片瑕疵）
    droppedUnknownType: 0,    // 认不出来的类型 —— 需要人去决定收还是丢
    droppedDuplicateId: 0,
  };

  for (const file of inputFiles) {
    const text = await readFile(file, 'utf8');
    const rows = parseDelimited(text);
    if (rows.length === 0) continue;
    led.fetchedRows += rows.length - 1;   // 减掉表头

    // 表头 → 列索引
    const header = rows[0];
    const col = {};
    header.forEach((h, i) => {
      col[h.trim()] = i;
    });
    const at = (r, key) => (col[key] != null ? r[col[key]] : undefined);

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (r.length === 1 && r[0] === '') { led.droppedBlankRow++; continue; }

      const rawName = (at(r, 'Name') ?? '').trim();
      if (rawName === '') { led.droppedNoName++; continue; }

      const typeRaw = (at(r, 'Type') ?? '').trim();
      const type = TYPE_MAP[typeRaw];
      if (!type) {
        if (typeRaw === 'Dup') led.droppedDuplicate++;
        else if (typeRaw === 'NonEx') led.droppedNonexistent++;
        else led.droppedUnknownType++;
        continue;
      }

      const id = nameToId(rawName);
      if (seen.has(id)) { led.droppedDuplicateId++; continue; }
      seen.add(id);

      const en = nameToDisplay(rawName);
      const messier = num(at(r, 'M'));
      const name = messier != null ? `M${messier}` : en;

      const commonRaw = (at(r, 'Common names') ?? '').trim();
      const common = commonRaw === '' ? null : commonRaw.split(',')[0].trim() || null;

      const ra = round(raToDeg(at(r, 'RA')), 5);
      const dec = round(decToDeg(at(r, 'Dec')), 5);

      const mag = num(at(r, 'V-Mag')) ?? num(at(r, 'B-Mag'));
      const majorArcmin = num(at(r, 'MajAx'));
      const minorArcmin = num(at(r, 'MinAx'));
      const constellation = (at(r, 'Const') ?? '').trim() || null;
      const hubble = (at(r, 'Hubble') ?? '').trim() || null;
      const redshiftRaw = num(at(r, 'Redshift'));

      // scope：星系类型且有红移 → 河外，否则银河系内
      const scope = type === 'galaxy' && redshiftRaw != null ? 'extragalactic' : 'milkyway';

      // 银河系内天体的「红移」是视线速度/测量噪声，不是宇宙学红移 —— 不带进下游，避免污染
      const redshift = scope === 'extragalactic' ? redshiftRaw : null;

      // 距离（Mly）：见 HUBBLE_FLOW_MIN_Z 的说明
      let distMly = null;
      let distSource = 'unknown';
      if (scope === 'extragalactic') {
        if (redshift != null && redshift >= HUBBLE_FLOW_MIN_Z) {
          distMly = round(redshift * H0_MLY_PER_Z, 3);
          distSource = 'redshift';
        } else {
          // 近距星系（含本星系群）：红移不足以为据，留空等前端实测距离表覆盖
          distMly = null;
          distSource = 'unknown';
          unknownNearbyCount++;
          if (redshift != null && redshift < 0) negativeRedshiftCount++;
        }
      } else {
        distMly = MW_DIST_MLY[type] ?? null;
        distSource = distMly != null ? 'class' : 'unknown';
      }
      if (distMly == null) noDistanceCount++;

      // 赤道 J2000 直角坐标（以太阳为原点，单位 Mly）
      let x = null;
      let y = null;
      let z = null;
      if (distMly != null && ra != null && dec != null) {
        const raR = (ra * Math.PI) / 180;
        const decR = (dec * Math.PI) / 180;
        x = round(distMly * Math.cos(decR) * Math.cos(raR), 4);
        y = round(distMly * Math.cos(decR) * Math.sin(raR), 4);
        z = round(distMly * Math.sin(decR), 4);
      }

      if (messier != null) messierCount++;

      typeCount[type] = (typeCount[type] ?? 0) + 1;
      scopeCount[scope] = (scopeCount[scope] ?? 0) + 1;

      objects.push({
        id,
        name,
        en,
        messier,
        common,
        type,
        typeRaw,
        scope,
        ra,
        dec,
        mag,
        majorArcmin,
        minorArcmin,
        constellation,
        hubble,
        redshift,
        distMly,
        distSource,
        x,
        y,
        z,
        desc: '',
      });
    }
    console.log(`[parsed] ${path.basename(file)} → 累计 ${objects.length} 条`);
  }

  /* 台账必须平：落地条数 + 四项丢弃 === 源表数据行数。
   * 将来有人再加一条 continue 却没加计数，构建立刻红 —— 而不是少收几千条还全绿。 */
  const accounted = objects.length + led.droppedBlankRow + led.droppedNoName
    + led.droppedDuplicate + led.droppedNonexistent + led.droppedUnknownType + led.droppedDuplicateId;
  if (accounted !== led.fetchedRows) {
    throw new Error(`吸纳台账对不上：落地 ${objects.length} + 空行 ${led.droppedBlankRow} + 无名称 ${led.droppedNoName}`
      + ` + 重复条目 ${led.droppedDuplicate} + 不存在 ${led.droppedNonexistent}`
      + ` + 未知类型 ${led.droppedUnknownType} + 重复 id ${led.droppedDuplicateId} = ${accounted}，但源表有 ${led.fetchedRows} 行`);
  }

  const out = {
    meta: {
      source: 'OpenNGC (Mattia Verga, CC BY-SA 4.0)',
      url: 'https://github.com/mattiaverga/OpenNGC',
      count: objects.length,
      /* 吸纳台账（`tools/model-probe.mjs` 的「吸纳率」判据会核对）：
       * 源表行数 = 落地条数 + 四项丢弃。见上面那段注释的由来。 */
      fetchedRows: led.fetchedRows,
      droppedBlankRow: led.droppedBlankRow,
      droppedNoName: led.droppedNoName,
      droppedDuplicate: led.droppedDuplicate,
      droppedNonexistent: led.droppedNonexistent,
      droppedUnknownType: led.droppedUnknownType,
      droppedDuplicateId: led.droppedDuplicateId,
      dropReasons: 'Dup=OpenNGC 标注的重复条目；NonEx=已证认不存在；UnknownType=映射表里没有这个类型（非零就该有人去看一眼）',
      note: '距离为估算：银河系内天体按类型取代表性距离；河外星系仅当 z ≥ 0.004（cz ≥ 1200 km/s）时才按哈勃定律 H0=70 km/s/Mpc 推算，红移不足的近距星系 distMly 留空、由实测距离表覆盖',
      noDistanceCount,
      unknownNearbyCount,
      negativeRedshiftCount,
    },
    objects,
  };

  const json = JSON.stringify(out);
  await writeFile(OUT_FILE, json, 'utf8');

  // ---- 统计汇报 ----
  const size = Buffer.byteLength(json, 'utf8');
  console.log('\n====== 构建完成 ======');
  console.log(`输出文件：${OUT_FILE}`);
  console.log(`文件体积：${(size / 1024 / 1024).toFixed(2)} MB`);
  console.log(`总条目数：${objects.length}`);
  console.log(`吸纳台账：源表 ${led.fetchedRows} = 落地 ${objects.length} + 空行 ${led.droppedBlankRow}`
    + ` + 无名称 ${led.droppedNoName} + 重复条目 ${led.droppedDuplicate} + 不存在 ${led.droppedNonexistent}`
    + ` + 未知类型 ${led.droppedUnknownType} + 重复 id ${led.droppedDuplicateId}`);
  console.log(`Messier 条目：${messierCount}`);
  console.log(`noDistanceCount：${noDistanceCount}`);
  console.log('按 type：', JSON.stringify(typeCount));
  console.log('按 scope：', JSON.stringify(scopeCount));

  const pick = (id) => objects.find((o) => o.id === id);
  for (const id of ['ngc224', 'ngc4486', 'ngc1976']) {
    const o = pick(id);
    console.log(`例子 ${id}:`, o ? JSON.stringify({ name: o.name, type: o.type, scope: o.scope, ra: o.ra, dec: o.dec, distMly: o.distMly, mag: o.mag }) : '未找到');
  }
}

main().catch((e) => {
  console.error('[fatal]', e);
  process.exit(1);
});
