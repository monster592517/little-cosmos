#!/usr/bin/env node
/**
 * 致密天体抓取器 —— SIMBAD TAP（CDS Strasbourg）
 *
 * 抓取黑洞 / 中子星 / 脉冲星 / 白矮星，以及补充的星云与超新星遗迹，
 * 供「邻近恒星系」与「银河系」两个尺度层级渲染。
 *
 *  数据源：https://simbad.cds.unistra.fr/simbad/sim-tap/sync
 *         （IVOA TAP，ADQL 查询，返回 JSON；无需密钥）
 *  产物：  data/raw/compact/*.json（原始应答，便于离线重跑）
 *         data/compact-objects.json（归一化）
 *
 * 用法：node tools/fetch-compact.mjs [--force] [--only=bh,ns,wd]
 *   --force  忽略本地缓存，强制重新抓取
 *   --only   只抓其中几类（调试用）
 *
 * 仅使用 Node 内置模块（含 Node 22 自带 fetch），无第三方依赖。
 *
 * ── 为什么用 SIMBAD 而不是 ATNF ──────────────────────────────
 * ATNF Pulsar Catalogue 是 HTML 表单，没有机器可读接口，且只有脉冲星一类。
 * SIMBAD 一个 TAP 端点在同一个 schema 下覆盖脉冲星(Psr, 3981) / 白矮星(WD*, 12.9 万)
 * / 行星状星云(PN, 13216) / 超新星遗迹(SNR, 2082) / 星云(Neb, 1847)，
 * 且带 plx_value 视差字段，可算出与 HYG 口径一致的距离。
 *
 * ── 距离口径 ────────────────────────────────────────────────
 * 与 HYG 星表保持同一套算法：d(pc) = 1000 / plx(mas)，再换算成光年。
 * 校验锚点：天狼星 B（* alf CMa B）plx=374.4896 mas → 2.671 pc → 8.71 光年，
 * 与实测 8.6 光年吻合（误差来自视差测量本身）。
 * 视差不正或缺失的记录一律不带距离 —— 宁缺毋滥，不编造位置。
 */
import { mkdir, writeFile, rename, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLogger } from '../server/lib/log.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW_DIR = path.join(ROOT, 'data', 'raw', 'compact');
const OUT_FILE = path.join(ROOT, 'data', 'compact-objects.json');
const LOG = createLogger(ROOT, { scope: 'fetch-compact', mirrorConsole: false });

const argv = process.argv.slice(2);
const force = argv.includes('--force');
const onlyArg = (argv.find((a) => a.startsWith('--only=')) || '').slice(7);
const ONLY = onlyArg ? new Set(onlyArg.split(',').map((s) => s.trim()).filter(Boolean)) : null;

const UA = 'LittleCosmos/1.2 (local educational project; contact: local user)';
const TAP = 'https://simbad.cds.unistra.fr/simbad/sim-tap/sync';
const PC_TO_LY = 3.261563777;

/* ============================================================
   一、抓取目标定义
   ============================================================ */

/**
 * 每一类目标的 SIMBAD otype 与筛选条件。
 *
 * `limit` 不是「抓这么多」，而是「最多保留这么多」——先按条件收窄，
 * 再按亮度/显著性排序取前 N 条。这是为了控制产物体积：
 * 12.9 万颗白矮星全塞进 JSON 会让首屏多付几 MB 流量，而用户根本看不到。
 *
/**
 * ⚠️ `requireParallax` 的教训（2026-09-11 踩到）：
 * 最初给所有类别都加了 `plx_value > 0`，结果黑洞 0 条、超新星遗迹只剩 9 条（应为 2082）。
 * 原因是三类天体天然测不到视差 —— 黑洞本身不发光；星云是延展源，视差测量对它们几乎无效。
 * **距离不是准入条件，只是排序依据**：没有距离的记录仍然是一座真实的、该被看见的天体，
 * 只是不能落到 3D 场景里的确切位置（前端按「银河系内、方位已知、距离未定」处理）。
 *
 * ⚠️ 第二个更隐蔽的教训 —— **排序规则会悄悄决定数据内容**：
 * 脉冲星按 `plx_value DESC`（视差最大 = 最近）排序时，
 * 蟹状星云脉冲星（6500 ly）、船帆座脉冲星（950 ly）、Geminga（815 ly）
 * 因为距离远、视差小，**永远排不进前 400**，在 3981 颗里被静默丢弃 ——
 * 而它们恰恰是用户唯一叫得出名字的那几颗。整个过程不报任何错。
 * 对策见 `PINNED`：人工点名白名单里的目标无条件优先收进，不参与排序竞争。
 */
const TARGETS = [
  {
    key: 'bh',
    label: '黑洞',
    otype: 'BH',
    // SIMBAD 的 BH 分类极保守（全表仅 3 条），主力名单在 curated 表里补
    requireParallax: false,
    order: 'main_id',
    limit: 50,
    note: 'SIMBAD 的 BH 分类只收录「已由动力学确认」的黑洞，数量极少，主力名单在人工整理表里补。',
  },
  {
    key: 'psr',
    label: '脉冲星',
    otype: 'Psr',
    requireParallax: true,     // 脉冲星距离主要靠色散量，SIMBAD 的视差只有部分记录有；这里取有视差的近距样本
    order: 'plx_value DESC',
    limit: 400,
    note: '中子星中脉动信号被确认的一类。取视差最大的（即最近的）。',
  },
  {
    key: 'wd',
    label: '白矮星',
    otype: 'WD*',
    requireParallax: true,
    order: 'plx_value DESC',
    limit: 600,
    note: '全表 12.9 万颗，这里取视差最大的 600 颗 —— 即离太阳最近的。',
  },
  {
    key: 'pn',
    label: '行星状星云',
    otype: 'PN',
    requireParallax: false,    // 星云是延展源，绝大多数测不出视差；不能拿距离当准入门槛
    order: 'main_id',
    limit: 300,
    note: '补充 OpenNGC（仅 130 条）的覆盖。星云为延展源，视差普遍缺失。',
  },
  {
    key: 'snr',
    label: '超新星遗迹',
    otype: 'SNR',
    requireParallax: false,
    order: 'main_id',
    limit: 300,
    note: '补充 OpenNGC（仅 11 条）的覆盖。星云为延展源，视差普遍缺失。',
  },
];

/** 每类要 SELECT 的字段 */
const COLUMNS = 'main_id, ra, dec, otype, plx_value, sp_type';

/* ============================================================
   二·四、点名白名单（PINNED）
   ============================================================
   人工整理表 web/js/data/compact-known.js 里带 `simbadId` 的代表天体。
   这些目标不参与「按视差排序取前 N」的竞争，而是**单独点名抓取、无条件收录**。

   为什么必须点名：见 TARGETS 上方「排序规则会悄悄决定数据内容」。
   单靠排序，蟹状星云脉冲星这种「远但著名」的天体永远进不来。

   白名单**不在这里复制一份** —— 从人工表里 import 出来。
   复制一份清单 = 两份会各自腐烂的清单，改了一处忘了另一处，且没人会发现。
*/

/** 从人工整理表里读出所有 simbadId（该文件是纯 ESM，无副作用，可直接 import） */
async function loadPinnedIds() {
  const file = path.join(ROOT, 'web', 'js', 'data', 'compact-known.js');
  const mod = await import(pathToFileURL(file).href);
  const list = mod.NOTABLE_COMPACT || [];
  const ids = list.map((o) => o.simbadId).filter(Boolean);
  LOG.info('点名白名单载入', { total: list.length, withSimbadId: ids.length });
  return ids;
}

/**
 * 载入人工表里的「常用名映射」与「著名天体」补充信息。
 *
 * 自动抓取拿到的只有 SIMBAD 机器名（`alf CMa B` / `V* CM Tau` / `Wolf   28`），
 * 直接显示没人看得懂。人工表补中文名、专名、以及距离修正。
 * 返回 { alias, notable } 两个 Map，键均为 SIMBAD main_id。
 */
async function loadCurated() {
  const file = path.join(ROOT, 'web', 'js', 'data', 'compact-known.js');
  const mod = await import(pathToFileURL(file).href);
  const alias = new Map(Object.entries(mod.COMPACT_ALIAS || {}));
  const notable = new Map();
  for (const o of mod.NOTABLE_COMPACT || []) {
    if (o.simbadId) notable.set(o.simbadId, o);
  }
  LOG.info('人工表载入', { alias: alias.size, notable: notable.size });
  if (!alias.size) {
    // 别名表空 = 界面会显示一堆 SIMBAD 机器名。这是会直接影响可用性的问题，必须显式报。
    LOG.warn('COMPACT_ALIAS 为空，界面将显示 SIMBAD 机器名');
    console.warn('  WARN  人工表的 COMPACT_ALIAS 为空 —— 界面会显示 `alf CMa B` 这类机器名');
  }
  return { alias, notable };
}

/** 按 main_id 逐个点名抓取（IN 查询；注意 ADQL 的 IN 写法） */
async function fetchPinned(ids) {
  if (!ids.length) return [];
  const quoted = ids.map((s) => `'${s.replace(/'/g, "''")}'`).join(',');
  const adql = `SELECT ${COLUMNS} FROM basic WHERE main_id IN (${quoted})`;
  LOG.info('点名抓取', { count: ids.length, adql });
  const json = await tapQuery(adql);
  const rows = tapRows(json);
  LOG.info('点名抓取完成', { requested: ids.length, returned: rows.length });
  if (rows.length < ids.length) {
    // 白名单里的 ID 在 SIMBAD 里查不到 —— 说明名字写错了或上游改了。
    // 不能静默：这正是那种「看着成功、其实少收了」的静默故障。
    const got = new Set(rows.map((r) => String(r.main_id || '').trim()));
    const missing = ids.filter((id) => !got.has(id));
    LOG.warn('点名白名单有 ID 在 SIMBAD 查不到', { missing });
    console.warn(`  WARN  白名单里 ${missing.length} 个 ID 在 SIMBAD 查不到：${missing.join(', ')}`);
  }
  return rows;
}

/* ============================================================
   二·五、常用名（专名）
   ============================================================
   SIMBAD 的 main_id 是机器名（`alf CMa B` / `omi02 Eri B` / `Wolf   28`），
  直接显示既难认、又有连续空格之类的脏格式。
  它的 `ids` 表里带 `NAME ` 前缀的条目才是「专名」约定
   （如 `NAME Sirius B`），一并抓来做显示名。
   抓不到专名的（绝大多数脉冲星、白矮星）退回清理过的 main_id。
*/

/**
 * 拉取所有目标的专名，返回 main_id → 常用名 的映射。
 *
 * 一次性 JOIN 出全部专名，比逐个对象查要快两个数量级
 * （逐个查 = 1446 次 HTTP 请求）。
 */
async function fetchProperNames() {
  const adql = `SELECT b.main_id, i.ids FROM ids i JOIN basic b ON i.oidref = b.oid `
    + `WHERE i.ids LIKE 'NAME %' AND b.otype IN ('BH','Psr','WD*','PN','SNR')`;
  LOG.info('抓取专名', { adql });
  const json = await tapQuery(adql);
  const rows = tapRows(json);
  /** main_id → 首个专名（去掉 `NAME ` 前缀） */
  const map = new Map();
  for (const r of rows) {
    const main = String(r.main_id || '').trim();
    if (!main || map.has(main)) continue;
    for (const one of String(r.ids || '').split('|')) {
      const s = one.trim();
      if (s.startsWith('NAME ')) {
        map.set(main, s.slice(5).trim());
        break;
      }
    }
  }
  LOG.info('专名抓取完成', { objects: rows.length, named: map.size });
  return map;
}

/* ============================================================
   二、工具函数
   ============================================================ */

/** 视差(mas) → 距离(光年)。视差 ≤ 0 或不合理一律返回 null。 */
function parallaxToLy(plx) {
  if (!Number.isFinite(plx) || plx <= 0) return null;
  const pc = 1000 / plx;
  // 视差误差会让极小的 plx 算出天文数字的距离；>100 kly 的「近邻天体」必是噪声
  if (!Number.isFinite(pc) || pc > 100000) return null;
  return pc * PC_TO_LY;
}

/** 视差误差 ~ 距离误差。相对误差 = 视差相对误差。 */
function parallaxToLyErr(plx, plxErr) {
  const d = parallaxToLy(plx);
  if (d == null || !Number.isFinite(plxErr) || plxErr <= 0) return null;
  return d * (plxErr / plx);
}

/**
 * SIMBAD 的 main_id 是「星表前缀 + 编号」的机器名，直接显示不友好。
 * 这里只做轻度清理：去掉前导的 `* ` 标记与常见前缀，保留可辨识的部分。
 */
function cleanName(mainId) {
  return String(mainId || '').replace(/^\*\s+/, '').trim();
}

/** 从名字推断一个稳定的 id */
function makeId(key, name, index) {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug ? `${key}-${slug}` : `${key}-${index}`;
}

/* ============================================================
   三、TAP 查询
   ============================================================ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 发一个 TAP 同步查询。
 * 只对连接层错误重试（ECONNRESET / fetch failed / 5xx）——
 * 4xx 是查询本身写错了，重试没有意义，必须立刻暴露。
 */
async function tapQuery(adql, { attempts = 3 } = {}) {
  const url = `${TAP}?request=doQuery&lang=adql&format=json&query=${encodeURIComponent(adql)}`;
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      const text = await r.text();
      if (r.status >= 500) throw new Error(`上游 ${r.status}（可重试）: ${text.slice(0, 160)}`);
      if (r.status !== 200) {
        const m = /<INFO name="QUERY_STATUS" value="ERROR">([\s\S]*?)<\/INFO>/.exec(text);
        throw Object.assign(new Error(`ADQL 被拒（不可重试）: ${m ? m[1].slice(0, 200) : text.slice(0, 200)}`), { fatal: true });
      }
      return JSON.parse(text);
    } catch (e) {
      if (e.fatal) throw e;
      lastErr = e;
      if (i < attempts - 1) await sleep(800 * (i + 1));
    }
  }
  throw lastErr;
}

/** TAP JSON 应答（metadata + data）→ 对象数组 */
function tapRows(json) {
  const cols = (json.metadata || []).map((m) => m.name);
  return (json.data || []).map((row) => {
    const o = {};
    cols.forEach((c, i) => { o[c] = row[i]; });
    return o;
  });
}

/* ============================================================
   四、抓取
   ============================================================ */

async function fetchTarget(t) {
  // 距离不是准入门槛，只是排序依据 —— 见 TARGETS 上方关于 requireParallax 的说明
  const where = t.requireParallax
    ? `otype='${t.otype}' AND plx_value > 0`
    : `otype='${t.otype}'`;
  const adql = `SELECT TOP ${t.limit} ${COLUMNS} FROM basic WHERE ${where} ORDER BY ${t.order}`;
  LOG.info('抓取开始', { key: t.key, otype: t.otype, limit: t.limit, requireParallax: t.requireParallax });
  const json = await tapQuery(adql);
  const rows = tapRows(json);
  LOG.info('抓取完成', { key: t.key, rows: rows.length });
  return rows;
}

/* ============================================================
   五、归一化
   ============================================================ */

function normalize(t, rows, properNames = new Map(), pinnedIds = new Set(), curated = { alias: new Map(), notable: new Map() }) {
  const out = [];
  const seen = new Set();
  let noDistance = 0;
  let named = 0;
  let pinned = 0;
  rows.forEach((r, i) => {
    const mainId = String(r.main_id || '').trim();
    if (!mainId) return;
    const id = makeId(t.key, mainId, i);
    if (seen.has(id)) return;
    seen.add(id);

    const isPinned = pinnedIds.has(mainId);
    if (isPinned) pinned++;

    // 显示名优先级：人工表中文名（最高）> SIMBAD 专名 > 清理过的机器名
    const al = curated.alias.get(mainId);
    const nb = curated.notable.get(mainId);
    const proper = properNames.get(mainId) || null;
    const zh = al?.zh || nb?.name || null;
    if (zh || proper) named++;
    const display = zh || proper || cleanName(mainId);

    // 距离：人工表的实测值优先于视差推算（人工值经过核对，且视差对远天体误差极大）
    const curatedDist = nb?.distLy ?? null;
    const plxDist = parallaxToLy(r.plx_value);
    const distLy = curatedDist ?? plxDist;
    const distSource = curatedDist != null ? 'curated' : plxDist != null ? 'parallax' : null;
    if (distLy == null) noDistance++;

    out.push({
      id,
      name: display,
      zh,
      en: nb?.en || mainId,
      simbadId: mainId,
      properName: proper,
      // 点名收录的代表天体打个标记：前端优先展示、优先给影像
      notable: isPinned,
      type: t.key === 'pn' ? 'planetarynebula' : t.key === 'snr' ? 'snr' : t.key,
      otype: r.otype,
      ra: Number.isFinite(r.ra) ? Number(r.ra.toFixed(6)) : null,
      dec: Number.isFinite(r.dec) ? Number(r.dec.toFixed(6)) : null,
      plxMas: Number.isFinite(r.plx_value) ? Number(r.plx_value.toFixed(4)) : null,
      distLy: distLy == null ? null : Number(distLy.toFixed(3)),
      distSource,
      distIsParallax: distSource === 'parallax',
      spType: r.sp_type || null,
      // ⚠️ desc / facts / src / researchQuery 等长文本**刻意不写进产物**。
      // 它们已经在前端 ESM（compact-known.js）里，按 simbadId 关联即可。
      // 若在这里也存一份，1455 条里只有十几条真的有描述，却要额外背 260 KB 体积 ——
      // 同一份内容存两处，还会各自腐烂。产物只放「数据」，表达归前端。
      catalog: 'SIMBAD',
    });
  });
  return { items: out, noDistance, total: rows.length, named, pinned };
}

/* ============================================================
   六、原子写
   ============================================================ */

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function writeAtomic(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, file);     // 同目录 rename 是原子操作：要么旧文件、要么新文件，不会出现半个
}

/* ============================================================
   七、主流程
   ============================================================ */

async function main() {
  await mkdir(RAW_DIR, { recursive: true });
  const wanted = TARGETS.filter((t) => !ONLY || ONLY.has(t.key));
  if (!wanted.length) {
    LOG.error('--only 没有匹配到任何目标', { only: onlyArg });
    process.exitCode = 1;
    return;
  }

  const sections = [];
  let failed = 0;

  /* ---- 点名白名单：人工表里的代表天体，无条件收录 ---- */
  let pinnedRows = [];
  let pinnedIds = new Set();
  const curated = await loadCurated();
  try {
    const ids = await loadPinnedIds();
    pinnedRows = await fetchPinned(ids);
    pinnedIds = new Set(pinnedRows.map((r) => String(r.main_id || '').trim()));
    if (pinnedIds.size) {
      console.log(`  OK    点名白名单  ${pinnedIds.size} 条（不参与排序竞争，直接收录）`);
    }
  } catch (e) {
    // 白名单是「知名代表」的唯一来源，抓不到必须显式报警 —— 不能静默降级成「只有邻近样本」
    LOG.error('点名白名单抓取失败', { err: e?.message || String(e) });
    console.error(`  FAIL  点名白名单 -- ${e?.message || e}`);
    console.error('         ⚠ 产物将缺少蟹状星云脉冲星等著名天体，请修复后重跑');
    failed++;
  }

  /* ---- 先抓专名（一次 JOIN 拿全，避免上千次单点查询） ---- */
  let properNames = new Map();
  try {
    const cachedNames = path.join(RAW_DIR, '_proper-names.json');
    if (!force && await exists(cachedNames)) {
      const arr = JSON.parse(await readFile(cachedNames, 'utf8'));
      properNames = new Map(arr);
      LOG.info('用本地缓存的专名表', { named: properNames.size });
    } else {
      properNames = await fetchProperNames();
      await writeAtomic(cachedNames, JSON.stringify([...properNames]));
    }
  } catch (e) {
    // 专名是「锦上添花」，抓不到不能拖垮整条管线 —— 退回机器名
    LOG.warn('专名抓取失败，退回 main_id 作显示名', { err: e?.message || String(e) });
    console.warn(`  WARN  专名抓取失败（不致命，将用星表机器名）-- ${e?.message || e}`);
  }

  for (const t of wanted) {
    const rawFile = path.join(RAW_DIR, `${t.key}.json`);
    let rows;
    try {
      if (!force && await exists(rawFile)) {
        rows = JSON.parse(await readFile(rawFile, 'utf8'));
        LOG.info('用本地缓存', { key: t.key, rows: rows.length });
      } else {
        rows = await fetchTarget(t);
        // 先落原始数据再归一化：上游挂了、字段变了，证据都还在
        await writeAtomic(rawFile, JSON.stringify(rows, null, 0));
      }
    } catch (e) {
      failed++;
      LOG.error('这一类抓取失败', { key: t.key, err: e?.message || String(e) });
      console.error(`  FAIL  ${t.label}（${t.otype}）-- ${e?.message || e}`);
      continue;
    }
    const n = normalize(t, rows, properNames, pinnedIds, curated);
    sections.push({ t, n });
    console.log(`  OK    ${t.label.padEnd(6)} ${String(n.items.length).padStart(4)} 条`
      + `（上游 ${n.total}，无距离 ${n.noDistance}，有专名 ${n.named}，白名单并入 ${n.pinned}）`);
    await sleep(300);   // 对公共 TAP 服务友好一点，别把人打挂
  }

  if (!sections.length) {
    LOG.error('一个类别都没抓到，不写产物');
    process.exitCode = 1;
    return;
  }

  /* ---- 汇总 ---- */
  // 点名记录先入表：同一目标若同时被点名和分类抓到，保留点名那条
  // （带 notable 标记；且点名条目来自人工表的 simbadId，可信度更高）
  const pinnedItems = pinnedRows.length
    ? normalize({ key: 'pinned' }, pinnedRows, properNames, pinnedIds, curated).items
    : [];

  /* ---- 人工表的独立注入 ----
     有些著名天体 SIMBAD 里根本没有对应记录（或分类不含它）：
       · 人马座 A*、M87*：SIMBAD 的 BH 分类不收超大质量黑洞
       · 蝎虎座 X-1 已被确认为中子星而非黑洞，SIMBAD 不会标成 BH
       · LP 40-365：连 main_id 都查不到
     这些只能由人工表直接提供。**不做这一步，用户最想看的黑洞一个都不会出现。**
  */
  const curatedItems = [];
  {
    const mod = await import(pathToFileURL(path.join(ROOT, 'web', 'js', 'data', 'compact-known.js')).href);
    for (const o of mod.NOTABLE_COMPACT || []) {
      // 已被 SIMBAD 抓到的（有 simbadId 且在 pinnedIds 里）跳过，避免重复
      if (o.simbadId && pinnedIds.has(o.simbadId)) continue;
      curatedItems.push({
        id: `curated-${o.id}`,
        name: o.name,
        zh: o.name,
        en: o.en,
        simbadId: o.simbadId || null,
        type: o.type,
        otype: null,
        ra: o.ra ?? null,
        dec: o.dec ?? null,
        plxMas: null,
        distLy: o.distLy ?? null,
        distSource: o.distLy != null ? 'curated' : null,
        distIsParallax: false,
        spType: null,
        // 同样只放数据；desc/facts/src 在前端表里，按 id 关联。
        // 但 kind/periodS/massSolar 属于「分类与物理量」，前端渲染要用，保留。
        kind: o.kind ?? null,
        periodS: o.periodS ?? null,
        massSolar: o.massSolar ?? null,
        radiusEarth: o.radiusEarth ?? null,
        notable: true,
        catalog: 'curated',
      });
    }
    if (curatedItems.length) {
      console.log(`  OK    人工注入  ${curatedItems.length} 条（SIMBAD 里没有的著名天体，如人马座 A*、M87*）`);
    }
  }

  const objects = [...pinnedItems, ...curatedItems, ...sections.flatMap((s) => s.n.items)];
  // 去重键必须是 simbadId（天体身份），不是 id（由「类别+机器名」拼出的字符串）。
  // 同一个天狼星 B 会被 pinned 与 wd 两条链路各抓一次，拼出的 id 不同（pinned-* / wd-*），
  // 但 simbadId 都是 `* alf CMa B` —— 按 id 去重会留下两份重复记录与两份天文数据。
  // 顺序已保证点名记录在前，所以「先到先得」保留的是信息更全的那条。
  const byKey = new Map();
  for (const o of objects) {
    const key = o.simbadId || o.id;
    if (!byKey.has(key)) byKey.set(key, o);
  }
  const finalObjects = [...byKey.values()];

  const counts = {};
  for (const o of finalObjects) counts[o.type] = (counts[o.type] || 0) + 1;

  const withDist = finalObjects.filter((o) => o.distLy != null);
  const notableCount = finalObjects.filter((o) => o.notable).length;

  const out = {
    meta: {
      source: 'SIMBAD (CDS, Strasbourg) — IVOA TAP / ADQL',
      url: 'https://simbad.cds.unistra.fr/simbad/sim-tap/sync',
      license: 'CC BY 4.0（CDS 要求署名与引用）',
      count: finalObjects.length,
      /* 吸纳台账（`tools/model-probe.mjs` 的「吸纳率」判据会核对）：
       * 各类型 TAP 抓回的**原始行数之和** = 落地条数 + 按标识符去重丢掉的行。
       * ⚠️ 这只证明「抓回来的都进产物了」，**不证明「抓全了」** ——
       *   每个类型的 `limit`（如白矮星取视差最大的 600 颗）是刻意的抽样，
       *   抽样口径写在下面的 `notes` 里。两件事不要混为一谈：
       *   台账管「不静默少收」，notes 管「抽样是明说的」。 */
      fetchedRows: objects.length,
      droppedDuplicateIdentifiers: objects.length - finalObjects.length,
      countsByType: counts,
      withDistance: withDist.length,
      notable: notableCount,
      distanceMethod: 'd(pc) = 1000 / plx(mas)，与 HYG 星表同口径；视差缺失或非正者不带距离',
      distanceAnchor: '天狼星 B（* alf CMa B）plx=374.4896 mas → 8.71 ly（实测 8.6 ly）',
      pinnedNote: `点名白名单 ${pinnedIds.size} 个 SIMBAD ID 无条件收录（不参与排序竞争），`
        + '避免「远但著名」的天体（如蟹状星云脉冲星）被视差排序静默滤掉。',
      curatedNote: `人工注入 ${curatedItems.length} 条 SIMBAD 里没有的著名天体 `
        + '（超大质量黑洞、被误认为黑洞的中子星等），来自 web/js/data/compact-known.js。',
      generatedAt: new Date().toISOString(),
      notes: TARGETS.map((t) => ({ key: t.key, otype: t.otype, label: t.label, note: t.note })),
      caveat: 'SIMBAD 的 otype 是「编目分类」，不等于物理结论；黑洞计数极少是因为其分类只收动力学确认者，'
        + '超大质量黑洞需人工补充（见 curatedNote）。距离标注来源：curated=人工实测值，parallax=视差推算。',
    },
    objects: finalObjects,
  };

  await writeAtomic(OUT_FILE, JSON.stringify(out));

  const sizeKb = Math.round((Buffer.byteLength(JSON.stringify(out)) / 1024) * 10) / 10;
  console.log('');
  console.log(`  产物  data/compact-objects.json`);
  console.log(`  合计  ${finalObjects.length} 条 · ${sizeKb} KB · 带距离 ${withDist.length} 条 · 点名代表 ${notableCount} 条`);
  console.log(`  分布  ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  ')}`);

  LOG.info('构建完成', { count: finalObjects.length, counts, sizeKb, notable: notableCount, failed });
  if (failed) {
    console.error(`\n  ⚠ ${failed} 个类别失败，产物只包含成功的部分`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  LOG.error('未捕获异常', { err: e?.stack || String(e) });
  console.error('FATAL', e?.stack || e);
  process.exitCode = 1;
});
