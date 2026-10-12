#!/usr/bin/env node
/**
 * check-textures.mjs —— 贴图资产一致性 + 显存预算体检
 *
 * 为什么需要它：
 * `engine.js::_texture()` 在贴图 404 时**不报错**，只打一条 `console.warn` 然后把天体
 * 换成 2×2 中灰占位图（见同文件 `_placeholderImage()`）。也就是说：
 *   「贴图文件名写错 / 文件没建出来」 和 「这个天体本来就是灰的」
 * 在界面上**长得一模一样**，只有翻控制台才看得出来 —— 典型静默故障。
 *
 * 四组判据：
 *   A 引用完整性   每个被 `texture:` 家族字段引用的文件，必须真的在 web/textures/ 里
 *   B 登记表诚实    data/texture-manifest.json 声明的条目，磁盘上必须存在且尺寸相符
 *   C 闲置资产      web/textures/ 里存在但没有任何天体引用的文件（可能是漏配，也可能是有意备用）
 *   D 显存预算      按「RGBA + mipmap（×4/3）」估算常驻显存，并给出 4 GB 卡的余量
 *
 * 用法：
 *   node tools/check-textures.mjs            # 人读
 *   node tools/check-textures.mjs --json     # 机读
 *   node tools/check-textures.mjs --quiet    # 只输出结论行
 * 退出码：有 A 类错误 → 1；否则 0。
 *
 * ⚠ 本工具只读，不写盘、不改数据。资产重建走 `py tools/build-textures.py`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARGV = process.argv.slice(2);
const JSON_OUT = ARGV.includes('--json');
const QUIET = ARGV.includes('--quiet');

const DATA_JS = path.join(ROOT, 'web', 'js', 'data');
const TEX_DIR = path.join(ROOT, 'web', 'textures');
const MANIFEST = path.join(ROOT, 'data', 'texture-manifest.json');

/** 所有会指向一张贴图的字段名。新增字段记得加进来，否则会变成「未声明 = 免检」。 */
const TEX_FIELDS = [
  'texture', 'surfaceTexture', 'nightTexture', 'ringTexture',
  'cloudsTexture', 'cloudTexture', 'normalTexture', 'specularTexture',
  'bumpTexture', 'emissiveTexture', 'map',
];

const errors = [];
const warns = [];
const infos = [];

// ---------- 收集引用 ----------
const refs = new Map(); // 文件名 → Set(来源)
const fieldNames = TEX_FIELDS.join('|');
const reRef = new RegExp(`\\b(?:${fieldNames})\\s*:\\s*'([^']+)'`, 'g');
const reRefD = new RegExp(`\\b(?:${fieldNames})\\s*:\\s*"([^"]+)"`, 'g');

let scanned = 0;
for (const f of fs.readdirSync(DATA_JS)) {
  if (!f.endsWith('.js') || f.includes('.bak')) continue;   // 备份文件不是活代码
  const src = fs.readFileSync(path.join(DATA_JS, f), 'utf8');
  scanned++;
  for (const re of [reRef, reRefD]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) {
      const name = m[1].trim();
      if (!name || name.startsWith('http') || name.startsWith('./')) continue;
      if (!refs.has(name)) refs.set(name, new Set());
      refs.get(name).add(f);
    }
  }
}

// ---------- 第二处声明源：data/texture-manifest.json ----------
// ⚠ 漏掉这一处会报出**一整批假「闲置」**：`dataset.js` 会在运行时把
//   `manifest.files[<贴图>].normal` 注入成 `body.normalTexture`，
//   所以这些文件名在 `data/*.js` 里一个字都搜不到，但它们是**在用的**。
//   判据少认一个声明源 ⇒ 把正在使用的东西判成垃圾 ⇒ 会把人派去删 37 个文件。
let manifest = { files: {} };
try { manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); }
catch { warns.push('读不到 data/texture-manifest.json，跳过登记表核对'); }
const manifestKeys = Object.keys(manifest.files || {});
for (const n of manifestKeys) {
  if (!refs.has(n)) refs.set(n, new Set());
  refs.get(n).add('texture-manifest.json');
}
for (const [owner, meta] of Object.entries(manifest.files || {})) {
  for (const [k, v] of Object.entries(meta || {})) {
    if (typeof v !== 'string' || !/\.(jpe?g|png|webp)$/i.test(v)) continue;
    if (!refs.has(v)) refs.set(v, new Set());
    refs.get(v).add(`texture-manifest.json:${owner}.${k}`);
  }
}

// ---------- 磁盘现状 ----------
let onDisk = [];
try { onDisk = fs.readdirSync(TEX_DIR).filter((n) => fs.statSync(path.join(TEX_DIR, n)).isFile()); }
catch { errors.push(`贴图目录不存在：${path.relative(ROOT, TEX_DIR)}`); }
const diskSet = new Set(onDisk);

// ---------- 故障注入自检 ----------
// 「判据不响」和「判据报了但方向反了」是两回事，必须能区分。
// 这里注入一条**一定不存在**的引用，看 A 类判据会不会抓到它。
const SELFTEST = ARGV.includes('--selftest');
const PROBE = '__selftest_missing_probe__.jpg';
if (SELFTEST) refs.set(PROBE, new Set(['selftest(注入)']));

// ---------- A 引用完整性 ----------
const missing = [...refs.keys()].filter((n) => !diskSet.has(n)).sort();
const probeCaught = missing.includes(PROBE);
if (SELFTEST) {
  missing.splice(missing.indexOf(PROBE), 1);      // 注入项不计入真实错误
  for (const k of [...refs.keys()]) if (k === PROBE) refs.delete(k);
}

for (const n of missing) {
  errors.push(`引用了不存在的贴图 ${n}（来源 ${[...refs.get(n)].join(', ')}）→ 界面会静默渲染成灰球`);
}

// ---------- C 闲置资产 ----------
const unused = onDisk.filter((n) => !refs.has(n)).sort();

// ---------- B 登记表诚实 ----------
const declared = Object.keys(manifest.files || {});
const declaredMissing = declared.filter((n) => !diskSet.has(n));
for (const n of declaredMissing) {
  warns.push(`登记表声明了 ${n}，但 web/textures/ 里没有（登记表要改去匹配现实）`);
}
// 尺寸核对：PNG 读 IHDR，JPEG 扫 SOF
function dims(p, ext) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, 65536, 0);
    const b = buf.subarray(0, n);
    if (ext === '.png') {
      if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
      return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    }
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const mk = b[i + 1];
      if (mk === 0xd8 || mk === 0xd9 || (mk >= 0xd0 && mk <= 0xd7) || mk === 0x01) { i += 2; continue; }
      const len = b.readUInt16BE(i + 2);
      if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) {
        return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
    return null;
  } catch { return null; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}
let sizeMismatch = 0;
for (const n of declared) {
  if (!diskSet.has(n)) continue;
  const d = dims(path.join(TEX_DIR, n), path.extname(n).toLowerCase());
  const dcl = manifest.files[n];
  if (d && dcl && dcl.width && d.w !== dcl.width) { sizeMismatch++; warns.push(`登记表写 ${n} 是 ${dcl.width}×${dcl.height}，实际 ${d.w}×${d.h}`); }
}

// ---------- 尺寸分布 + 显存预算 ----------
const REFS = dims; // alias
const buckets = { '≤512': 0, '513–1024': 0, '1025–2048': 0, '2049–4096': 0, '>4096': 0 };
let vramBytes = 0, diskBytes = 0, dimUnknown = 0;
let wSum = 0, wN = 0;
for (const n of onDisk) {
  const p = path.join(TEX_DIR, n);
  let st; try { st = fs.statSync(p); } catch { continue; }
  diskBytes += st.size;
  const d = REFS(p, path.extname(n).toLowerCase());
  if (!d) { dimUnknown++; continue; }
  wSum += d.w; wN++;
  const mx = Math.max(d.w, d.h);
  if (mx <= 512) buckets['≤512']++;
  else if (mx <= 1024) buckets['513–1024']++;
  else if (mx <= 2048) buckets['1025–2048']++;
  else if (mx <= 4096) buckets['2049–4096']++;
  else buckets['>4096']++;
  vramBytes += d.w * d.h * 4 * (4 / 3);   // RGBA8 + mipmap 链 ≈ ×4/3
}

const VRAM_CARD = 4096 * 1024 * 1024;
const vramMB = vramBytes / 1048576;

// ---------- 输出 ----------
const result = {
  scannedFiles: scanned,
  referenced: refs.size,
  onDisk: onDisk.length,
  missing,
  unused,
  declaredMissing,
  sizeMismatch,
  buckets,
  avgWidth: wN ? Math.round(wSum / wN) : 0,
  diskMB: +(diskBytes / 1048576).toFixed(1),
  vramMB: +vramMB.toFixed(0),
  vramPct: +((vramBytes / VRAM_CARD) * 100).toFixed(1),
  errors: errors.length,
  warns: warns.length,
  selftest: SELFTEST ? { injected: PROBE, detected: probeCaught } : null,
};

if (JSON_OUT) {
  console.log(JSON.stringify(result, null, 2));
} else {
  if (!QUIET) {
    console.log('=== 贴图资产体检 ===');
    console.log(`  扫描 ${scanned} 个数据模块 · 引用 ${refs.size} 张贴图 · 磁盘 ${onDisk.length} 个文件 ${result.diskMB} MB`);
    console.log('\n  分辨率分布：');
    for (const [k, v] of Object.entries(buckets)) console.log(`    ${k.padEnd(10)} ${String(v).padStart(4)}`);
    if (dimUnknown) console.log(`    读不出尺寸  ${dimUnknown}`);
    console.log(`  平均宽度 ${result.avgWidth}px`);
    console.log('\n  显存预算（RGBA8 + mipmap ×4/3）：');
    console.log(`    常驻约 ${result.vramMB} MB，占 4 GB 独显的 ${result.vramPct}%（未计几何体 / 渲染目标 / 浏览器自身）`);
    if (unused.length) {
      console.log(`\n  磁盘上有但没天体引用（${unused.length} 个）：`);
      console.log('    ' + unused.join(', '));
    } else {
      console.log('\n  磁盘上的每一个贴图都被引用了。');
    }
  }
  if (errors.length) {
    console.log(`\n  ✗ ${errors.length} 条错误：`);
    for (const e of errors) console.log('    · ' + e);
  }
  if (warns.length) {
    console.log(`\n  ! ${warns.length} 条告警：`);
    for (const w of warns) console.log('    · ' + w);
  }
  if (!errors.length && !warns.length) console.log('\n  ✓ 全部通过：引用完整、登记表诚实、无闲置资产。');
  if (SELFTEST) {
    console.log(probeCaught
      ? `\n  ✓ 故障注入自检通过：注入的 ${PROBE} 被 A 类判据抓到 ⇒ 这条判据确实会响。`
      : `\n  ✗ 故障注入自检失败：注入的 ${PROBE} 没被报出来 ⇒ 这条判据是哑的，别信它的 0 错误。`);
  }
  console.log(`\n  结论：${errors.length} 错误 · ${warns.length} 告警 · ${unused.length} 闲置`);
}

process.exit(SELFTEST && !probeCaught ? 1 : (errors.length ? 1 : 0));
