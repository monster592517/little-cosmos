#!/usr/bin/env node
/**
 * 本星系群成员表抓取器 —— VizieR TAP（CDS Strasbourg）
 *
 * 目的：把「本星系群」这一层从**手写目录**升级成**真实编目**。
 *   这一层原有 20 条手写条目（`web/js/data/deep-sky.js::GALAXIES`），
 *   是逐个查资料填的 —— 覆盖了大麦哲伦云、M31、M33 这些主角，
 *   但整层只有 20 个天体，而真实的本星系群成员有**一百多个**。
 *   用户的要求是「星系群下精确到星系」⇒ 这一层必须由**星表**说话。
 *
 *  数据源：VizieR J/AJ/144/4/catalog
 *          = McConnachie A. W. 2012, AJ 144, 4
 *            《The observed properties of dwarf galaxies in and around the Local Group》
 *          https://vizier.cds.unistra.fr/viz-bin/cat/J/AJ/144/4
 *          doi:10.26093/cds/vizier.51440004  （2012 年发表，2025-11-24 定稿入 CDS）
 *
 *  产物：  data/raw/localgroup/*.tsv（原始应答，便于离线重跑）
 *          data/local-group.json（归一化 + 三维坐标 + 元数据）
 *
 * 用法：node tools/fetch-localgroup.mjs [--force]
 *   --force  忽略本地缓存，强制重新抓取
 *
 * 仅使用 Node 内置模块（含 Node 22 自带 fetch），无第三方依赖。
 *
 * ── 为什么用 TAP 而不是 VizieR 的 ASU 网页接口 ──────────────────
 * ASU-TSV（`viz-bin/asu-tsv`）也能取到同一张表，但应答前面带 100 多行
 * `#` 元数据块（含列定义、单位），正文里还有「列名行 / 单位行 / 破折线行」三层表头。
 * ⇒ 解析器要多写一套「跳 `#` + 跳三层表头」的逻辑，而**表头层数一旦变化就会静默错位**
 *   （把单位行当数据行读，得到 105 条而实际只有 102 条 —— 本工具开发时就先踩了这个）。
 * TAP 的 `FORMAT=tsv` 应答**第一行就是列名**，干净得多，且与 `tools/fetch-quasars.mjs`
 * 同一条技术路线（同一个上游、同一套重试与落盘口径）。
 *
 * ── 距离口径（这一条最容易搞错）────────────────────────────────
 * 表里的 `D` 是**日心距离、单位 kpc、整数位**（列定义原文：
 *   "Heliocentric distance"）。
 *   · 不能拿红移去算：本星系群成员多数是**负视向速度**（在接近我们），
 *     哈勃定律在这里没有意义（项目里 IC 10 / NGC 6822 已有前例）。
 *   · 不能用「与银心距离」代替：那是另一套口径，同一张表里叫 `D(MW)`。
 * ⇒ 一律取 `D`，换算 1 kpc = 3.261563777e-3 Mly。
 *   与 `web/js/data/deep-sky.js` 的手写值交叉核对过：
 *   M31 星表 783 kpc → 2.554 Mly（手写 2.537）、LMC 51 kpc → 0.166（手写 0.163）、
 *   Fornax 147 kpc → 0.479（手写 0.460）—— 同一量级、差值来自不同文献测量，不是口径错。
 *
 * ── 尺寸口径（`diameterLy`）──────────────────────────────────────
 * 星表给两个半径：`R1` = 沿长轴的半光半径（**角分**），`R2` = 半光半径（**秒差距**）。
 * 本工具取 `diameterLy = 2 × R2(pc) × 3.261563777`。
 * ⚠️ 这是**半光直径**，不是等光度直径 —— 对大星系会小于它的光学直径
 *    （M31 的可见盘 ~22 万光年，而 2×r_h 只有几万光年）。
 *    对矮星系够准；而这一层新增的正是矮星系。所以**手写条目里的 `diameterLy`
 *    一律优先**（M31/M33/LMC 那些是查过资料的整盘直径，见合并规则）。
 * 顺带把 `R1` 和 `R2` 做成**互相校验**：R1(角分) × D(kpc) 应当 ≈ R2(pc)，
 *    这两列来自不同测量途径，对得上才说明解析没错（见 meta.r1r2Consistency）。
 *
 * ── 倾角口径（`incl` 为什么故意留空）──────────────────────────────
 * 星表有 `Ell` = 1 − b/a。对**有盘的星系**，ε = 1 − cos i ⇒ 能反解出倾角。
 * 但这一层新增的成员绝大多数是 **dSph（矮椭球星系）**——它们没有盘，
 * 「倾角」对它们是没有定义的量，把 ε 反解成倾角会得到**一个看着像数字的假信息**。
 * ⇒ 只对**手写条目里有实测出处**的（M31 i=77/PA=38、M33 i=49/PA=21、LMC i=35/PA=123）
 *   保留 `incl`；其余一律 `incl: null`，由 `galaxyDiscQuaternion` 按 id 派生一个
 *   **确定性**示意角度（代码里已标注为示意）。`ell` 作为**原始观测量**照实带出，
 *   但明确不是倾角。
 *
 * ── 颜色口径 ─────────────────────────────────────────────────────
 * 星表没有颜色。新增条目按**形态类型**给一个示意色（沿用文件里既有的那套约定：
 * 矮椭球偏暖黄、不规则偏冷蓝、螺旋偏白蓝），并在 meta 里标明
 * **是示意色、不是观测结论**。手写条目的 color 优先。
 */
import { mkdir, writeFile, rename, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../server/lib/log.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW_DIR = path.join(ROOT, 'data', 'raw', 'localgroup');
const OUT_FILE = path.join(ROOT, 'data', 'local-group.json');
const LOG = createLogger(ROOT, { scope: 'fetch-localgroup', mirrorConsole: false });

const argv = process.argv.slice(2);
const force = argv.includes('--force');

const UA = 'LittleCosmos/1.2 (local educational visualization; contact: local user)';
const TAP = 'https://tapvizier.cds.unistra.fr/TAPVizieR/tap/sync';
const CATALOG_URL = 'https://vizier.cds.unistra.fr/viz-bin/cat/J/AJ/144/4';
const TABLE = 'J/AJ/144/4/catalog';

/* ============================================================
   一、单位换算（全项目只在这里换一次，换完写进变量名）
   ============================================================ */
/** 1 Mpc = 3.261563777 百万光年 ⇒ 1 kpc = 3.261563777e-3 Mly */
const KPC_TO_MLY = 3.261563777e-3;
/** 1 pc = 3.261563777 光年 */
const PC_TO_LY = 3.261563777;

/** 与本星系群层相称的距离上限（Mly）。星表最远成员 DDO 113 = 2951 kpc ≈ 9.63 Mly。 */
const DIST_MAX_MLY = 12;

/* ============================================================
   二、与手写目录的对齐表
   ============================================================
   `web/js/data/deep-sky.js::GALAXIES` 里的 20 条手写条目**不废弃**：
   它们带 `desc/facts/color/mass/incl/pa/diameterLy` 这些星表给不了的东西。
   前端按 **id 取并集**（星表打底、手写覆盖），所以这里必须把星表的
   `Name` 逐个对到已有的手写 id 上，否则同一个天体会出现两次
   （`m31` 与 `andromeda` 各一份），且**不会报任何错**。
   ⚠️ 这张表是**判据的一部分**：下面 `main()` 里会断言这 20 个名字
      在星表里全部命中，少一个就说明上游改名了、该来修这张表。 */
const HANDWRITTEN_IDS = {
  'The Galaxy': 'milkyway',
  'LMC': 'lmc',
  'SMC': 'smc',
  'Andromeda': 'm31',
  'M32': 'm32',
  'NGC 205': 'm110',
  'Triangulum': 'm33',
  'IC 1613': 'ic1613',
  'NGC 6822': 'ngc6822',
  'WLM (Wolf-Lundmark-Melotte)': 'wlm',
  'IC 10': 'ic10',
  'Sagittarius dSph': 'sagittarius-dwarf',
  'Sculptor': 'sculptor-dwarf',
  'Fornax': 'fornax-dwarf',
  'Draco': 'draco-dwarf',
  'Leo I': 'leo1',
  'NGC 3109': 'ngc3109',
  'Sextans A': 'sextans-a',
  'Phoenix': 'phoenix-dwarf',
  'Tucana': 'tucana-dwarf',
};

/* ============================================================
   三、中文名：**只做一条可复述的规则**，不逐条编
   ============================================================
   星表只有英文名。硬翻 82 个矮星系的名字 = 编（用户明确反感「自己瞎搞」）。
   所以只做两件**有据可依**的事：
     ① 星座名 + 编号（罗马数字/A/B）→ 星座中文名 + **原样的编号**。
        这是天文界的标准译法（"Andromeda XXVIII" ↔ 「仙女座 XXVIII」），
        不是新造的名字，且编号原样保留 ⇒ 不存在信息损失。
     ② 剩下的（巡天编号 HIZSS/KKR/KKH/UKS/DDO/UGC/UGCA/GR/ESO、NGC/IC 编号）
        一律**保留英文原名**，不做音译。UGC 4879 就是 UGC 4879。
   每个对象都带 `nameSource` 记录它走的是哪一支，`en` 永远保留。 */
const CONSTELLATION_ZH = {
  Andromeda: '仙女座',
  Antlia: '唧筒座',
  Aquarius: '宝瓶座',
  Bootes: '牧夫座',
  'Canes Venatici': '猎犬座',
  Carina: '船底座',
  Cetus: '鲸鱼座',
  'Coma Berenices': '后发座',
  Draco: '天龙座',
  Fornax: '天炉座',
  Hercules: '武仙座',
  Leo: '狮子座',
  Pegasus: '飞马座',
  Phoenix: '凤凰座',
  Pisces: '双鱼座',
  Sagittarius: '人马座',
  Sculptor: '玉夫座',
  Sextans: '六分仪座',
  Triangulum: '三角座',
  Tucana: '杜鹃座',
  'Ursa Major': '大熊座',
  'Ursa Minor': '小熊座',
};
/**
 * 少数几个**不能走上面那条规则**的名字：它们的「裸星座名」指的是**大星系本身**，
 * 不是以该星座命名的矮星系。规则 ④ 会把 `Andromeda` 说成「仙女座矮星系」——
 * M31 显然不是矮星系。
 * ⚠️ 这 8 个中文名**全部照抄 `web/js/data/deep-sky.js` 里已有的写法**，
 *    不是我新造的名字 —— 目的是让 `data/local-group.json` **单独拿出来也是对的**，
 *    不依赖「反正前端会被手写条目覆盖」。 */
const CURATED_ZH = {
  'The Galaxy': '银河系',
  'Andromeda': '仙女座星系',
  'Triangulum': '三角座星系',
  'LMC': '大麦哲伦云',
  'SMC': '小麦哲伦云',
  'WLM (Wolf-Lundmark-Melotte)': '沃尔夫-伦德马克-梅洛特星系',
  'NGC 6822': '巴纳德星系',
  'Canis Major': '大犬座矮星系',
};

/** 名字 → 中文名。返回 { name, nameSource }，名字不变时 nameSource='en'。 */
function chineseName(raw) {
  const n = raw.replace(/\s+/g, ' ').trim();

  /* ⓪ 单列的几个（见 CURATED_ZH） */
  if (CURATED_ZH[n]) return { name: CURATED_ZH[n], nameSource: 'curated' };

  /* ① `Sagittarius dSph` / `Pegasus dIrr` 这类：星座 + 类型后缀 */
  const mType = /^([A-Za-z ]+?) d(Irr|Sph)\??$/.exec(n);
  if (mType && CONSTELLATION_ZH[mType[1]]) {
    const kind = mType[2] === 'Irr' ? '矮不规则星系' : '矮椭球星系';
    return { name: `${CONSTELLATION_ZH[mType[1]]}${kind}`, nameSource: 'constellation-rule' };
  }

  /* ② `Bootes (I)` / `Canes Venatici (I)` / `Ursa Major (I)` / `Sextans (I)` / `Segue (I)` */
  const mBracket = /^([A-Za-z ]+?) \(([IVX]+)\)$/.exec(n);
  if (mBracket && CONSTELLATION_ZH[mBracket[1]]) {
    return { name: `${CONSTELLATION_ZH[mBracket[1]]} ${mBracket[2]}`, nameSource: 'constellation-rule' };
  }

  /* ③ `Andromeda XXVIII` / `Leo IV` / `Canes Venatici II` —— 星座 + 编号
   *   编号可以是罗马数字，也可以是**单字母**（`Leo A` / `Leo T` / `Sextans B`），
   *   两者都是文献里的标准编号，译法就是把编号原样搬过来。 */
  const mNum = /^([A-Za-z ]+?) ([IVX]+|[A-Z])$/.exec(n);
  if (mNum && CONSTELLATION_ZH[mNum[1]]) {
    return { name: `${CONSTELLATION_ZH[mNum[1]]} ${mNum[2]}`, nameSource: 'constellation-rule' };
  }

  /* ④ 光秃秃一个星座名：`Sculptor` / `Fornax` / `Carina` —— 星系就叫这个星座的名字
   *   （走得到这里说明它不在 CURATED_ZH 里，即确实是个矮星系） */
  if (CONSTELLATION_ZH[n]) {
    return { name: `${CONSTELLATION_ZH[n]}矮星系`, nameSource: 'constellation-rule' };
  }

  /* ⑤ 编号类（NGC/IC/UGC/DDO/KKR/KKH/UKS/HIZSS/GR/ESO/Willman/Segue...）：
   *   **不翻、不音译**，保留原文。UGC 4879 就是 UGC 4879。 */
  return { name: n, nameSource: 'en' };
}

/* ============================================================
   四、类型 / 颜色（示意口径，见文件头）
   ============================================================ */
function typeFromMType(mtype) {
  const t = (mtype || '').trim();
  /* ⚠️ 顺序有意义：`dE/dSph`、`dIrr/dSph` 都含 `dSph`，
   *    必须先判 dSph，否则会被后面的 `dE` / `Irr` 抢走。 */
  if (/dSph/.test(t)) return 'dwarfgalaxy';
  if (/^S[abc]?\(?/.test(t)) return 'spiral';       // Sb / Sc / S(B)bc
  if (/Irr/.test(t)) return 'irregular';            // Irr / dIrr / (d)Irr?
  if (/^(cE|dE|E)/.test(t)) return 'elliptical';    // cE / dE
  return 'dwarfgalaxy';                             // ????（Canis Major）等
}
/** 示意色：与 `deep-sky.js` 里手写那套同口径，**不是观测结论** */
const TYPE_COLOR = {
  spiral: '#cfe0ff',
  elliptical: '#ffe0b8',
  irregular: '#a8c8ff',
  dwarfgalaxy: '#ffe8b0',
};

/** 归属：取 n_Name 的**第一个**标记。星表把主要归属写在前面（实测 20 条手写全对得上）。 */
const GROUP_LABEL = {
  G: '银河系卫星',
  A: '仙女座卫星',
  L: '本星系群',
  N: '近邻星系',
};
function groupOf(nName) {
  const first = String(nName || '').split(',')[0].trim();
  return { key: first || null, label: GROUP_LABEL[first] ?? null, raw: String(nName || '').trim() };
}

/* ============================================================
   五、工具函数（与 fetch-quasars.mjs 同口径）
   ============================================================ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function writeAtomic(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, file);
}

/**
 * TAP 同步查询。只对连接层错误重试（5xx / fetch failed）；
 * 4xx 是查询本身写错了，重试没有意义，必须立刻暴露。
 */
async function tapQuery(adql, format = 'tsv', { attempts = 3 } = {}) {
  const url = `${TAP}?REQUEST=doQuery&LANG=ADQL&FORMAT=${format}&QUERY=${encodeURIComponent(adql)}`;
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      const text = await r.text();
      if (r.status >= 500) throw new Error(`上游 ${r.status}（可重试）: ${text.slice(0, 160)}`);
      if (r.status !== 200) {
        const m = /<INFO name="QUERY_STATUS" value="ERROR">([\s\S]*?)<\/INFO>/.exec(text);
        throw Object.assign(
          new Error(`ADQL 被拒（不可重试）: ${m ? m[1].slice(0, 200) : text.slice(0, 200)}`),
          { fatal: true },
        );
      }
      return text;
    } catch (e) {
      if (e.fatal) throw e;
      lastErr = e;
      if (i < attempts - 1) await sleep(800 * (i + 1));
    }
  }
  throw lastErr;
}

function parseCount(tsv) {
  const line = tsv.trim().split('\n')[1];
  const n = Number(line);
  return Number.isFinite(n) ? n : null;
}

/** RFC4180 口径的 TSV 解析（VizieR 的字符串字段可能带双引号且保留首尾空格） */
function parseTsv(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.length);
  if (!lines.length) return { cols: [], rows: [] };
  const split = (line) => {
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
        } else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === '\t') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const cols = split(lines[0]).map((c) => c.trim());
  const rows = lines.slice(1).map((l) => {
    const p = split(l);
    const o = {};
    cols.forEach((c, i) => { if (c) o[c] = (p[i] ?? '').trim(); });
    return o;
  });
  return { cols, rows };
}

/**
 * 数值列 → number | null。
 * ⚠️ **不能让 `Number('') === 0` 冒充「测到了 0」**：星表里大量单元格是空的
 *    （矮星系常常没有扁率、没有金属丰度）。直接 `Number(r.Ell)` 会给一个
 *    **看起来正常的 0**，于是「没测到」被静默写成「测到 0 度」——
 *    界面上完全看不出来。所有数值列一律走这里。
 */
function num(v) {
  const s = String(v ?? '').trim();
  if (!s || s === '-' || s === '---') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * 赤经 / 赤纬 → 度。**两种形态都要吃**：
 *   · TAP（`FORMAT=tsv`）：`266.41666666666663` —— 十进制度
 *   · ASU-TSV（`viz-bin/asu-tsv`）：`"17 45 40.0"` —— 时:分:秒
 * ⚠️ 同一张表、同一个列名，**两个接口给的格式不同**，而且都不会报错：
 *    只按一种解析时，另一种会静默变成 null ⇒ 整批天体被当「坐标坏」丢掉，
 *    在产物上只表现为「少了 101 条」。**本工具开发时实测踩到过**
 *    （102 条只剩 1 条 —— 唯一活着的那条走了 `anchor:'home'` 分支，绕开了坐标检查）。
 * 判据：先试十进制，再试时分秒；都失败才返回 null。 */
function parseRa(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const d = Number(s);
    return d >= 0 && d < 360 ? d : null;
  }
  const m = /^(\d+)\s+(\d+)\s+([\d.]+)$/.exec(s);
  if (!m) return null;
  return (+m[1] + +m[2] / 60 + +m[3] / 3600) * 15;
}

function parseDec(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/^[+-]?\d+(\.\d+)?$/.test(s)) {
    const d = Number(s);
    return d >= -90 && d <= 90 ? d : null;
  }
  const m = /^([+-]?)(\d+)\s+(\d+)\s+([\d.]+)$/.exec(s);
  if (!m) return null;
  const val = +m[2] + +m[3] / 60 + +m[4] / 3600;
  return m[1] === '-' ? -val : val;
}

/**
 * 赤经/赤纬（度）、距离（Mly）→ 赤道直角坐标。
 * ⚠️ 口径必须与 `web/js/data/deep-sky.js::xyz()` **完全一致**，连 `toFixed(4)` 都一致：
 *    渲染侧按 (x, z, −y) 映射进场景，差一个口径就让整个星系群歪掉。
 */
function xyz(raDeg, decDeg, dist) {
  const ra = (raDeg * Math.PI) / 180;
  const dec = (decDeg * Math.PI) / 180;
  return [
    +(dist * Math.cos(dec) * Math.cos(ra)).toFixed(4),
    +(dist * Math.cos(dec) * Math.sin(ra)).toFixed(4),
    +(dist * Math.sin(dec)).toFixed(4),
  ];
}

/** 名称 → 稳定、可读的 id 片段 */
function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unnamed';
}
/**
 * id 基名：去掉**结尾**的括号补充（`LGS 3 (Local Group Suspect 3)` → `LGS 3`），
 * 否则 id 会长成一整句话。⚠️ 只去结尾的括号，`HIZSS 3(A)` 这种**编号本身带括号**的
 * 要保留 —— 它和 `HIZSS 3B` 靠这个括号区分。判据：括号在**最后**且前面有空格。
 */
function idBase(name) {
  return String(name).replace(/\s+\([^)]*\)\s*$/, '').trim();
}

/* ============================================================
   六、抓取（带本地缓存）
   ============================================================ */
async function fetchAll() {
  const sampleFile = path.join(RAW_DIR, 'mcconnachie2012-catalog.tsv');
  const metaFile = path.join(RAW_DIR, '_query-meta.json');

  if (!force && await exists(sampleFile) && await exists(metaFile)) {
    return {
      tsv: await readFile(sampleFile, 'utf8'),
      counts: JSON.parse(await readFile(metaFile, 'utf8')),
      cached: true,
    };
  }

  LOG.info('抓取全表');
  /* `SELECT *` 而不是逐列列举：这张表有 93 列，其中 `[Fe/H]`、`M.HI`、`sigma*`、
   * `e_(m-M)` 这些列名在 ADQL 里需要引号转义，写死了极易在**上游列名微调**时静默取空。
   * 取全表拿到的列名直接来自应答表头 ⇒ 少一个可能出错的地方。 */
  const tsv = await tapQuery(`SELECT * FROM "${TABLE}"`, 'tsv');
  await writeAtomic(sampleFile, tsv);
  await sleep(400);

  LOG.info('抓取台账计数');
  const catalogRows = parseCount(await tapQuery(`SELECT COUNT(*) AS n FROM "${TABLE}"`, 'csv'));

  const counts = {
    catalogRows,
    query: `SELECT * FROM "${TABLE}"`,
    countQuery: `SELECT COUNT(*) AS n FROM "${TABLE}"`,
    fetchedAt: new Date().toISOString(),
  };
  await writeAtomic(metaFile, JSON.stringify(counts, null, 2));
  return { tsv, counts, cached: false };
}

/* ============================================================
   七、归一化
   ============================================================ */
function normalize(rows) {
  const objects = [];
  const seenIds = new Set();
  const matched = [];
  const dropped = {
    noName: 0, badCoords: 0, noDistance: 0, tooFar: 0, duplicateId: 0,
  };
  /* R1↔R2 交叉校验样本（两列来自不同测量途径） */
  const consistency = [];
  let withR2 = 0, withEll = 0, withPa = 0, withVmag = 0, withFeh = 0, withMass = 0;

  for (const r of rows) {
    const rawName = String(r.Name || '').trim();
    if (!rawName) { dropped.noName++; continue; }

    /* —— 位置 —— */
    const ra = parseRa(r.RAJ2000);
    const dec = parseDec(r.DEJ2000);
    const isHome = rawName === 'The Galaxy';   // 「我们在它里面」：位置是定义，不是缺数据
    if (!isHome && (ra == null || dec == null)) { dropped.badCoords++; continue; }

    /* —— 距离：必须用日心距离 D（kpc），不能用红移 —— */
    const dKpc = num(r.D);
    /* 银河系自己：星表 `D` 为空，而它的位置是**定义**（原点），不是缺数据 */
    const distMly = isHome ? 0 : (dKpc == null ? null : +(dKpc * KPC_TO_MLY).toFixed(4));
    if (!isHome && distMly == null) { dropped.noDistance++; continue; }
    if (distMly != null && distMly > DIST_MAX_MLY) { dropped.tooFar++; continue; }

    /* —— id：先查手写对齐表，再退回 slug —— */
    const id = HANDWRITTEN_IDS[rawName] ?? `lg-${slugify(idBase(rawName))}`;
    if (seenIds.has(id)) { dropped.duplicateId++; continue; }
    seenIds.add(id);
    if (HANDWRITTEN_IDS[rawName]) matched.push(id);

    /* —— 坐标 —— */
    const [x, y, z] = isHome ? [0, 0, 0] : xyz(ra, dec, distMly);

    /* —— 尺寸 —— */
    const r2Pc = num(r.R2);
    const r1Arcmin = num(r.R1);
    const hasR2 = Number.isFinite(r2Pc) && r2Pc > 0;
    const hasR1 = Number.isFinite(r1Arcmin) && r1Arcmin > 0;
    if (hasR2) withR2++;
    const diameterLy = hasR2 ? Math.round(2 * r2Pc * PC_TO_LY) : null;
    /* R1(角分) 换算成同一把尺子：r1_phys = (R1/60)·(π/180)·D(kpc)·1000 [pc] */
    if (hasR1 && hasR2 && dKpc > 0) {
      const r1PhysPc = (r1Arcmin / 60) * (Math.PI / 180) * dKpc * 1000;
      consistency.push({ id, r1PhysPc, r2Pc, ratio: r1PhysPc / r2Pc });
    }

    /* —— 形态 / 归属 / 颜色 —— */
    const mtype = String(r.MType || '').trim();
    const type = typeFromMType(mtype);
    const grp = groupOf(r.n_Name);
    const { name, nameSource } = chineseName(rawName);
    const en = rawName;

    const ell = num(r.Ell);
    if (ell != null) withEll++;
    const paDeg = num(r.PA);
    if (paDeg != null) withPa++;
    const vmag = num(r.Vmag);
    if (vmag != null) withVmag++;
    const feh = num(r['[Fe/H]']);
    if (feh != null) withFeh++;
    /* ⚠️ `Mass` 的单位是 **1e6 太阳质量**（列单位行 `10+6Msun`），不是太阳质量本身。
     *    忘了乘 1e6 会让每个星系的质量小 6 个数量级 —— 而且界面上看不出来。 */
    const massRaw = num(r.Mass);
    const massMsun = massRaw == null ? null : Math.round(massRaw * 1e6);
    if (massMsun != null) withMass++;

    const absMag = num(r.VMag);
    const aliases = String(r.OName || '').split(',').map((s) => s.trim()).filter(Boolean);
    const simbad = String(r.SimbadName || '').trim();
    if (simbad && !aliases.includes(simbad)) aliases.push(simbad);

    /* —— 文案：**每一个数字都能指回一列**，不编 —— */
    const descParts = [];
    if (grp.label) descParts.push(`位于${grp.label}`);
    if (mtype) descParts.push(`形态类型 ${mtype}`);
    if (dKpc != null && !isHome) descParts.push(`日心距 ${dKpc} kpc（${distMly} 百万光年）`);
    if (isHome) descParts.push('我们所在的星系，在本层位于坐标原点');

    const facts = [];
    if (hasR2) facts.push(`半光半径 ${r2Pc} 秒差距${hasR1 ? `（沿长轴 ${r1Arcmin} 角分，两列互校见 meta）` : ''}。`);
    if (ell != null) facts.push(`扁率 ε = 1 − b/a = ${ell.toFixed(2)}。`);
    if (feh != null) facts.push(`平均恒星金属丰度 [Fe/H] = ${feh}（相对太阳）。`);
    if (massMsun != null) facts.push(`恒星质量约 ${massMsun.toExponential(1).replace('e+', '×10^')} 太阳质量。`);
    if (absMag != null) facts.push(`绝对目视星等 M_V = ${absMag}。`);

    objects.push({
      id,
      name,
      en,
      type,
      /* ⚠️ 银河系自己的归属不能按 `n_Name` 推：星表给的是 `G`（银河系子群，
       *    因为整张表是「按子群归类成员」的），照搬会得到「银河系是银河系的卫星」。
       *    它自己就是本星系群的主角，归属写「本星系群」。 */
      group: isHome ? '本星系群' : grp.label,
      subgroup: String(r.SubG || '').trim() || null,
      association: grp.raw || null,
      x, y, z,
      distMly,
      distKpc: dKpc,
      ra: isHome ? 0 : +ra.toFixed(7),
      dec: isHome ? 0 : +dec.toFixed(7),
      /* 尺寸：半光直径（见文件头） */
      diameterLy,
      halfLightRadiusPc: hasR2 ? r2Pc : null,
      halfLightRadiusArcmin: hasR1 ? r1Arcmin : null,
      diameterSource: hasR2 ? '2xR2' : null,
      /* 朝向：平场量照实带出；`incl` 故意不给（见文件头「倾角口径」） */
      ell,
      pa: paDeg,
      incl: null,
      color: TYPE_COLOR[type],
      mag: vmag,
      absMag,
      massSolar: massMsun,
      metallicity: feh,
      mtype: mtype || null,
      aliases,
      nameSource,
      /* `anchor:'home'` —— 我们在它里面，所以它在世界原点是**定义**而不是缺数据。
       * 判据「这一层画了别的层的东西」「无位置却落点」都要认这份声明（见 attrs.js::ANCHOR_KINDS）。 */
      anchor: isHome ? 'home' : undefined,
      desc: descParts.length ? `${descParts.join('，')}。` : null,
      facts,
      /* 出处留痕：这一条是从星表来的，不是手写的 */
      source: 'McConnachie 2012 (J/AJ/144/4)',
      catalogRecno: Number(r.recno) || null,
      researchQuery: en,
    });
  }
  return { objects, matched, dropped, consistency, withR2, withEll, withPa, withVmag, withFeh, withMass };
}

/* ============================================================
   八、主流程
   ============================================================ */
async function main() {
  await mkdir(RAW_DIR, { recursive: true });

  const { tsv, counts, cached } = await fetchAll();
  const { cols, rows } = parseTsv(tsv);
  LOG.info('解析原始 TSV', { cols: cols.length, rows: rows.length, cached });
  console.log(`  ${cached ? '缓存' : '抓取'}  原始 ${rows.length} 行 × ${cols.length} 列`);

  if (!rows.length) {
    LOG.error('样例为空，不写产物');
    console.error('  FAIL  样例为空 —— 不写产物（宁可保持旧数据，也不产出空表）');
    process.exitCode = 1;
    return;
  }

  /* 判据一：行数必须等于台账。星表加了成员而没进管线，这里会立刻响。 */
  if (counts.catalogRows != null && counts.catalogRows !== rows.length) {
    throw new Error(`条数不符：COUNT(*) = ${counts.catalogRows}，实际取回 ${rows.length} 行`);
  }

  const n = normalize(rows);
  if (!n.objects.length) {
    LOG.error('归一化后一条不剩，不写产物');
    console.error('  FAIL  归一化后 0 条 —— 不写产物');
    process.exitCode = 1;
    return;
  }

  /* 判据二：20 个手写条目必须全部命中。上游改名 ⇒ 这里立刻响，
     否则同一个天体在两层里各出现一次（一个 m31、一个 andromeda），且不报错。 */
  const missing = Object.values(HANDWRITTEN_IDS).filter((id) => !n.matched.includes(id));
  if (missing.length) {
    throw new Error(`手写对齐表有 ${missing.length} 个 id 没在星表里命中：${missing.join(', ')}`
      + ' —— 上游可能改过 Name，请核对 HANDWRITTEN_IDS');
  }

  /* 判据三：id 唯一 + 坐标有限。id 撞了就会静默覆盖一个天体。 */
  const ids = n.objects.map((o) => o.id);
  if (new Set(ids).size !== ids.length) throw new Error('id 有重复');
  for (const o of n.objects) {
    if (![o.x, o.y, o.z].every(Number.isFinite)) throw new Error(`${o.id} 坐标非有限：${o.x},${o.y},${o.z}`);
  }

  /* R1↔R2 互校：两列独立测量，比值应集中在 1 附近。偏得太远说明解析/换算错了。 */
  const ratios = n.consistency.map((c) => c.ratio).sort((a, b) => a - b);
  const median = ratios.length ? ratios[Math.floor(ratios.length / 2)] : null;
  const inBand = ratios.filter((r) => r > 0.5 && r < 2).length;

  const dists = n.objects.map((o) => o.distMly);

  const out = {
    meta: {
      source: 'McConnachie A. W. 2012, AJ 144, 4 —— 本星系群及近邻矮星系观测性质汇总表（J/AJ/144/4/catalog）',
      url: CATALOG_URL,
      doi: '10.26093/cds/vizier.51440004',
      citation: 'McConnachie, A. W. 2012, AJ, 144, 4（表 1–5 合集）',
      licence: 'VizieR/CDS 目录页未声明统一许可；ReadMe 要求引用 McConnachie 2012',
      count: n.objects.length,
      catalogRows: counts.catalogRows,
      query: counts.query,
      /* 抽查口径：全表 102 行**全取**，不做抽样、不做稀释。
         本层要的就是「精确到星系」，稀释等于丢成员。 */
      samplingNote: '全表取回，无抽样、无稀释。`data/raw/localgroup/mcconnachie2012-catalog.tsv` '
        + '是原始应答，可离线重跑比对。',
      distanceModel: '日心距离取星表 `D` 列（kpc，整数），换算 1 kpc = 3.261563777e-3 Mly。'
        + '**不用红移** —— 本星系群成员多为负视向速度，哈勃定律在此无意义（项目内 IC 10 / NGC 6822 已有前例）。'
        + '**不用 D(MW)** —— 那是「与银心距离」，是另一套口径。',
      coordModel: 'x=d·cos(dec)·cos(ra), y=d·cos(dec)·sin(ra), z=d·sin(dec)，单位 Mly'
        + '（与 web/js/data/deep-sky.js::xyz 同口径，含 toFixed(4)）',
      sizeModel: 'diameterLy = 2 × R2(pc) × 3.261563777，即**半光直径**（R2 = 半光半径）。'
        + '⚠️ 不是等光度直径：对大星系会偏小（M31 可见盘约 22 万光年，2×r_h 只有几万）。'
        + '对矮星系适用，而本层新增的正是矮星系。手写条目的 diameterLy 优先（查过资料的整盘直径）。',
      inclPolicy: '`incl` 一律 null。新增成员绝大多数是 dSph（矮椭球），**没有盘**，'
        + '把 ε 反解成倾角会得到「看着像数字的假信息」。'
        + '`ell` 是星表原始观测量，照实带出，但**不是倾角**。'
        + 'M31/M33/LMC 的 incl/pa 由手写条目提供（有实测出处），合并时优先。',
      ellPolicy: '`ell` = 1 − b/a，星表原文，未做任何加工。',
      colorPolicy: '**示意色，不是观测结论**：按形态类型给一个约定色'
        + '（矮椭球偏暖黄 / 不规则偏冷蓝 / 螺旋偏白蓝 / 椭圆偏橙），沿用 deep-sky.js 手写那套同口径。'
        + '星表本身没有颜色数据。',
      namePolicy: '星表只有英文名。「星座名 + 编号」按标准译法转写（Andromeda XXVIII ↔ 仙女座 XXVIII），'
        + '**编号原样保留**；巡天编号（UGC/DDO/KKR/KKH/UKS/HIZSS/GR/ESO/NGC/IC）**一律不音译**。'
        + '另有 8 个名字走单列表（m31 仙女座星系、M33 三角座星系、大/小麦哲伦云、银河系、'
        + 'NGC 6822 巴纳德星系、WLM、大犬座矮星系）—— 它们的「裸星座名」指大星系本身，'
        + '机械套规则会得到「仙女座矮星系」这种错名字；这 8 个中文名**照抄仓库里已有的写法**。'
        + '每个对象带 `nameSource`（curated / constellation-rule / en），`en` 永远保留。'
        + '⚠️ 与手写目录对齐的那 20 条，前端合并时由手写条目覆盖名字（手写优先级更高）。',
      r1r2Consistency: {
        pairs: ratios.length,
        medianRatio: median == null ? null : +median.toFixed(4),
        withinHalfToDouble: inBand,
        note: 'R1（沿长轴半光半径，角分）经 D 换算成秒差距后应与 R2（半光半径，秒差距）相当。'
          + '两列来自不同测量途径，比值集中在 1 附近即说明解析与单位换算无误。',
      },
      dropped: {
        noName: n.dropped.noName,
        badCoords: n.dropped.badCoords,
        noDistance: n.dropped.noDistance,
        beyondDistanceLimit: n.dropped.tooFar,
        duplicateId: n.dropped.duplicateId,
      },
      withField: {
        halfLightRadiusR2: n.withR2,
        ellipticity: n.withEll,
        positionAngle: n.withPa,
        apparentVmag: n.withVmag,
        metallicity: n.withFeh,
        stellarMass: n.withMass,
      },
      matchedHandwritten: n.matched.length,
      handwrittenIdMap: HANDWRITTEN_IDS,
      distMlyRange: [+Math.min(...dists).toFixed(4), +Math.max(...dists).toFixed(4)],
      generatedAt: new Date().toISOString(),
    },
    objects: n.objects,
  };

  await writeAtomic(OUT_FILE, JSON.stringify(out));

  const bytes = Buffer.byteLength(JSON.stringify(out));
  const byGroup = {};
  for (const o of n.objects) byGroup[o.group ?? '未归属'] = (byGroup[o.group ?? '未归属'] ?? 0) + 1;

  console.log('');
  console.log(`  产物  data/local-group.json`);
  console.log(`  合计  ${n.objects.length} 条 · ${(bytes / 1024).toFixed(1)} KB`);
  console.log(`  归属  ${Object.entries(byGroup).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  console.log(`  距离  ${Math.min(...dists).toFixed(3)} – ${Math.max(...dists).toFixed(2)} Mly`);
  console.log(`  与手写目录对齐  ${n.matched.length}/${Object.keys(HANDWRITTEN_IDS).length} 命中`);
  console.log(`  字段覆盖  半光半径 ${n.withR2} · 扁率 ${n.withEll} · 位置角 ${n.withPa}`
    + ` · V 星等 ${n.withVmag} · 金属丰度 ${n.withFeh} · 恒星质量 ${n.withMass}`);
  if (median != null) {
    console.log(`  R1↔R2 互校  ${ratios.length} 对 · 中位比 ${median.toFixed(3)} · 落在 0.5–2 的 ${inBand} 对`);
  }
  console.log(`  丢弃  无名 ${n.dropped.noName} · 坐标坏 ${n.dropped.badCoords}`
    + ` · 无距离 ${n.dropped.noDistance} · 超限 ${n.dropped.tooFar} · 重复 id ${n.dropped.duplicateId}`);

  LOG.info('构建完成', {
    count: n.objects.length, bytes, matched: n.matched.length, medianRatio: median,
  });
}

main().catch((e) => {
  LOG.error('未捕获异常', { err: e?.stack || String(e) });
  console.error('FATAL', e?.stack || e);
  process.exitCode = 1;
});
