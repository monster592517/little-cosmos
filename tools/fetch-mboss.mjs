#!/usr/bin/env node
/* ==============================================================================
   fetch-mboss.mjs —— 抓 MBOSS-2 外太阳系测光汇编，解析成 data/photometry.json

   上游
   ──────────────────────────────────────────────────────────────────────────────
     O. R. Hainaut, H. Boehnhardt & S. Protopapa (2012),
     "Colours of minor bodies in the outer solar system II", A&A 546, A115
     冻结版 ASCII：https://www.eso.org/~ohainaut/MBOSS/MBOSS2.dat
     许可：CC BY 3.0 Unported（ESO 页面明示，使用时须引用原文）
     活表（~723 天体，2020-04 更新）只在网页上，**没有 ASCII 版** —— 见 note。

   这份数据用来干什么
   ──────────────────────────────────────────────────────────────────────────────
     外太阳系天体的**宽带测光**（B−V / V−R / R−I / V−J / J−H / H−K）
     加上作者从色指数反解出的可见光反射率斜率 `Grt`（%/100 nm）。
     ⇒ `web/js/color/photometric-colors.js` 靠它把「有测光、无光谱」的天体
       算成真彩，而不是手写一个"看着差不多"的 hex。

   ⚠️ 本脚本**只写 data/ 下的数据文件，绝不碰 web/js/data/ 下的人工整理表** ——
      那是 updatePolicy.caution 里写死的纪律。由测光推颜色、再写回目录表，
      走的是**人工复核**的 tools/apply-dwarf-colors.mjs，不是自动管线。

   用法
   ──────────────────────────────────────────────────────────────────────────────
     node tools/fetch-mboss.mjs               # 下载并重建 data/photometry.json
     node tools/fetch-mboss.mjs --offline     # 不联网，只用本地 data/raw/mboss2.dat
     node tools/fetch-mboss.mjs --check       # 只校验本地派生文件与其源是否一致

   格式（固定列，2026-09-11 实测确认）
   ──────────────────────────────────────────────────────────────────────────────
     列 0–23   对象名（**会被上游截断到 24 字符**，如 `C/1984K1-Shoemak`）
     其后      Class 名（不含空格）· 观测历元数 Epo
     再其后    8 组 `<值>/<σ>/<离散度>`，顺序固定为
               M11 Grt B−V V−R R−I V−J J−H H−K
     缺失值一律写作 `------`
   ⚠️ 三值之间**空格数不一致**（`0.376/------` 无空格、`14.851/ 0.376/` 有空格），
      所以不能用 split(' ') 切 —— 用正则匹配三连。曾经按空白切过，切出来的
      子串数在不同行之间不一致，是个只能靠"结果怪怪的"才发现的坑。
   ============================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const URL_RAW = 'https://www.eso.org/~ohainaut/MBOSS/MBOSS2.dat';
const RAW = path.join(ROOT, 'data/raw/mboss2.dat');
const OUT = path.join(ROOT, 'data/photometry.json');

/** 8 组测光量的固定顺序 —— 与上游列顺序一一对应，不许改 */
const FIELDS = ['m11', 'grt', 'bv', 'vr', 'ri', 'vj', 'jh', 'hk'];

const FIELD_LABEL = {
  m11: 'R(1,1) 绝对星等', grt: '可见光反射率斜率 %/100nm',
  bv: 'B−V', vr: 'V−R', ri: 'R−I', vj: 'V−J', jh: 'J−H', hk: 'H−K',
};

/** 一个 `值/σ/离散度` 三连。缺失值 = 6 个减号。 */
const TRIPLE = /(-?\d+\.\d+|------)\s*\/\s*(-?\d+\.\d+|------)\s*\/\s*(-?\d+\.\d+|------)/g;

const num = (s) => (s === '------' ? null : Number(s));

const argv = process.argv.slice(2);
const OFFLINE = argv.includes('--offline');
const CHECK = argv.includes('--check');

async function download() {
  if (OFFLINE) {
    if (!fs.existsSync(RAW)) throw new Error(`--offline 但 ${path.relative(ROOT, RAW)} 不存在`);
    console.log(`· --offline：使用本地 ${path.relative(ROOT, RAW)}`);
    return;
  }
  console.log(`▶ 下载 ${URL_RAW}`);
  const res = await fetch(URL_RAW, {
    headers: { 'User-Agent': 'LittleCosmos/1.0 (local educational visualization; mailto:little-cosmos@localhost)' },
  });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 20000) throw new Error(`下载内容只有 ${buf.length} 字节，不像完整表 —— 拒绝覆盖`);
  if (!buf.toString('utf8', 0, 200).includes('MBOSS')) {
    throw new Error('下载内容开头不含 "MBOSS" —— 可能拿到的是错误页面，拒绝覆盖');
  }
  /* 先写临时文件，校验通过再替换（与管线其它步骤同规矩） */
  const tmp = RAW + '.tmp';
  fs.mkdirSync(path.dirname(RAW), { recursive: true });
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, RAW);
  console.log(`  已写入 ${path.relative(ROOT, RAW)}（${buf.length} 字节）`);
}

/**
 * 解析。**格式一变就抛**，不许静默产出空表或半张表。
 * 上一代这类脚本的失败模式就是「返回了一张少一半行的表，但退出码 0」。
 */
function parse(text) {
  const lines = text.split(/\r?\n/);
  const objects = {};
  const hard = [];   // 结构性错误 —— 一条都不许有，有就整表作废
  const soft = [];   // 上游已知瑕疵 —— 容忍但有上限，且必须如实报出来
  let dataLines = 0;

  for (const [i, raw] of lines.entries()) {
    if (!raw || raw[0] === '#') continue;
    dataLines++;

    const name = raw.slice(0, 24).trim();
    const rest = raw.slice(24);

    if (!name) { hard.push(`第 ${i + 1} 行对象名为空`); continue; }

    const tr = [...rest.matchAll(TRIPLE)];
    if (tr.length !== FIELDS.length) {
      hard.push(`第 ${i + 1} 行「${name}」匹配到 ${tr.length} 组测光（应为 ${FIELDS.length}）`);
      continue;
    }

    // Class 与 Epo 在第一个三连之前
    const head = rest.slice(0, tr[0].index).trim().split(/\s+/);
    let cls = null, epo = null;
    if (head.length === 2 && /^\d+$/.test(head[1])) {
      [cls, epo] = [head[0], Number(head[1])];
    } else if (head.length === 1 && /^\d+$/.test(head[0])) {
      // ⚠️ 上游真实缺口：个别天体没有物理-动力学分类（实测 1 个：2004PY42，
      //    该行比别的行短 7 个字符，正好是一个 Class 的宽度）。
      //    不能因此判整表作废，也不必编一个分类出来 —— 记 null 并计数上报。
      epo = Number(head[0]);
      soft.push(`第 ${i + 1} 行「${name}」没有 Class（上游缺口，cls 记为 null）`);
    } else {
      hard.push(`第 ${i + 1} 行「${name}」的 Class/Epo 段无法解析：${JSON.stringify(head)}`);
      continue;
    }

    const rec = { cls, epo };
    FIELDS.forEach((f, k) => {
      const m = tr[k];
      rec[f] = { v: num(m[1]), s: num(m[2]), d: num(m[3]) };
    });

    if (objects[name]) hard.push(`对象名重复：${name}（第 ${i + 1} 行）`);
    else objects[name] = rec;
  }

  return { objects, hard, soft, dataLines };
}

function summarize(objects) {
  const keys = Object.keys(objects);
  const have = (f) => keys.filter((k) => objects[k][f].v != null).length;
  const out = { total: keys.length };
  for (const f of FIELDS) out[f] = have(f);
  return out;
}

/* ============================ 主流程 ============================ */

if (CHECK) {
  if (!fs.existsSync(OUT)) { console.error(`✗ ${path.relative(ROOT, OUT)} 不存在`); process.exit(1); }
  const j = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const src = fs.readFileSync(RAW);
  const sha = createHash('sha1').update(src).digest('hex');
  const ok = j.source?.sha1 === sha;
  console.log(`源文件 sha1 : ${sha}`);
  console.log(`登记表 sha1 : ${j.source?.sha1 || '(无)'}`);
  console.log(ok ? '✅ 派生文件与其源一致' : '❌ 派生文件与其源不一致 —— 重跑 node tools/fetch-mboss.mjs');
  process.exit(ok ? 0 : 1);
}

await download();

const text = fs.readFileSync(RAW, 'utf8');
const { objects, hard, soft, dataLines } = parse(text);

if (dataLines < 300) {
  throw new Error(`只解析到 ${dataLines} 行数据（期望 600+）—— 上游格式可能变了，拒绝写出半张表`);
}
if (hard.length) {
  console.error(`✗ 结构性解析错误 ${hard.length} 处，拒绝写出派生文件：`);
  for (const a of hard.slice(0, 20)) console.error('   ' + a);
  if (hard.length > 20) console.error(`   …另有 ${hard.length - 20} 处`);
  process.exit(1);
}
/* 软异常有上限：一两个是上游瑕疵，几十个就是格式变了 —— 后者必须失败而不是"尽力而为" */
if (soft.length > Math.max(3, dataLines * 0.02)) {
  console.error(`✗ 软异常 ${soft.length} 处，超过容忍上限（${Math.max(3, Math.round(dataLines * 0.02))}）—— 上游格式可能变了`);
  for (const a of soft.slice(0, 20)) console.error('   ' + a);
  process.exit(1);
}
if (soft.length) {
  console.log(`⚠️ 容忍 ${soft.length} 处上游瑕疵（已记入产出物的 dataGaps）：`);
  for (const a of soft) console.log('   ' + a);
}

const s = summarize(objects);
const sha1 = createHash('sha1').update(fs.readFileSync(RAW)).digest('hex');

const doc = {
  schema: 'lc.photometry/1',
  _about:
    'MBOSS-2 外太阳系测光汇编的解析结果。由 tools/fetch-mboss.mjs 生成，**不要手改**。'
    + '每个量的结构是 {v: 值, s: σ, d: 离散度}，缺失为 null。'
    + '色指数是**相对太阳**测的（平反射率天体测出来 B−V≈0.67 而不是 0）——'
    + '消费方必须先减 SOLAR_INDICES 再拟合，见 web/js/color/indices-to-spectrum.js。',
  source: {
    id: 'mboss',
    title: 'Colours of minor bodies in the outer solar system II',
    authors: 'O. R. Hainaut, H. Boehnhardt & S. Protopapa',
    paper: 'A&A 546, A115 (2012)',
    doi: '10.1051/0004-6361/201219566',
    url: URL_RAW,
    license: 'CC BY 3.0 Unported（ESO 页面明示，使用时须引用原文）',
    file: path.relative(ROOT, RAW).replace(/\\/g, '/'),
    sha1,
  },
  coverage: {
    objects: s.total,
    withBv: s.bv, withVr: s.vr, withGrt: s.grt, withRi: s.ri,
    fields: Object.fromEntries(FIELDS.map((f) => [f, FIELD_LABEL[f]])),
  },
  note:
    '这是**冻结版**（A&A 2012 论文的版本，实测 553 个天体）。ESO 的活表（约 723 天体，'
    + '最后更新 2020-04）只在网页上、没有 ASCII 导出 ⇒ 这里大约少了 170 个'
    + '2012 年之后才积累够测光的天体。**已知覆盖缺口**：需要某个天体但没有它的测光时，'
    + '进 watchlist 走人工，不要自己编数。',
  dataGaps: soft,
  objects,
};

const tmp = OUT + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(doc, null, 1), 'utf8');  // 1 空格缩进：可读且不至于翻倍
fs.renameSync(tmp, OUT);

console.log('');
console.log(`✅ ${path.relative(ROOT, OUT)} · ${s.total} 个天体`);
console.log(`   有 B−V 的 ${s.bv} · V−R ${s.vr} · 谱斜率 Grt ${s.grt} · R−I ${s.ri}`);
console.log(`   源文件 sha1 ${sha1.slice(0, 12)}…`);
