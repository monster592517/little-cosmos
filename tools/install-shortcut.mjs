#!/usr/bin/env node
/**
 * install-shortcut.mjs —— 桌面快捷方式「安装 / 刷新 / 校验」
 *
 * ## 为什么必须单独有这么一个工具
 *
 * 桌面快捷方式 `.lnk` 住在**仓库外面**。任何「全仓库扫描 + 替换」式的更名
 * （本项目的 `tools/rename-pass2.mjs` 就是）都扫不到它，
 * 所以产品一改名，它必然变成指向不存在目标的历史垃圾。
 * 现象：双击弹出「找不到 `<它自己记着的那个旧文件名>`」（快捷方式记的是改名前的文件）。
 *
 * 更关键的是——**没有任何现成脚本能重建它**。之前那个 .lnk 是手工建的一次性产物，
 * 所以坏了只能靠人再手工建一次。这属于「踩过的坑没固化」。
 * 本工具就是那次固化：把「快捷方式必须指向现实」变成一条可重复执行的命令。
 *
 * ## 设计原则：一切从现实推导，不写死任何名字
 *
 *   - 产品名   ← 仓库里那个 `启动XXX.bat` 的文件名（剥掉「启动」和 `.bat`）
 *   - 启动器   ← 同上这个文件本身
 *   - 图标     ← `assets/icon.ico`（有就用）
 *   - 仓库路径 ← 脚本自身位置（import.meta.url）
 *   - 附标语   ← `package.json` 的 description（去掉开头的「产品名：」和括号内容）
 *
 * 因此「仓库改名 / 启动器改名」之后**再跑一次本工具即可自愈**，
 * 不需要回来改这个脚本里的任何一行。
 *
 * ## 为什么是字节手术而不是调 API
 *
 * `.lnk` 是 [MS-SHLLINK] 二进制格式，正规做法是 COM 的 `WScript.Shell`，
 * 但本机安全策略禁用了 COM。所以直接改字节：
 *
 *   - 复用已有 .lnk 的 Header / IDList / ExtraData 结构，**只在原位置换名称字符串**
 *     （IDList 里每个 item 的尺寸都留了大量余量，换短名字不用动任何尺寸字段，
 *      于是完全不需要重算偏移 —— 这是本工具最省事的取舍）；
 *   - StringData 段整体重建（那里有 2 字节的「字符数」，长度必须对得上）；
 *   - 中文出现在三个地方、两套编码：IDList / ANSI 字段里是 **GBK**，StringData 里是 **UTF-16LE**。
 *
 * ## 用法
 *
 *   node tools/install-shortcut.mjs                 刷新桌面快捷方式
 *   node tools/install-shortcut.mjs --check         只校验不写盘；不一致 → 退出码 1
 *   node tools/install-shortcut.mjs --dir <目录>     指定放置目录（默认用户桌面）
 *   node tools/install-shortcut.mjs --template <lnk> 指定结构模板
 *   node tools/install-shortcut.mjs --name <显示名>  覆盖工具提示名
 *   node tools/install-shortcut.mjs --quiet         静默（只输出结论）
 *   node tools/install-shortcut.mjs --no-prune      不清理同项目的旧名快捷方式
 *
 * ## 已知边界（诚实声明）
 *
 *   - **没有现成 .lnk 当模板时**，本工具会从零构造一个 IDList。该路径只做过
 *     **结构自校验**（重新解析自己写出的字节，核对每个 item 尺寸/名称/编码），
 *     **没有做过双击实测**。首次自动生成后，请双击确认一次。
 *   - 只支持本地盘符路径（`C:\...`）；UNC / 网络盘不支持。
 *   - 只处理 `.lnk`；`.url` / 符号链接不在职责内。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRASH = path.join(ROOT, '.trash');

// ────────────────────────────── 参数 ──────────────────────────────
const opt = { check: false, dir: null, template: null, name: null, quiet: false, prune: true, inspect: false };
{
  const argv = process.argv.slice(2);
  const take = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) { console.error(`${flag} 需要一个值`); process.exit(2); }
    return [v, i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') opt.check = true;
    else if (a === '--inspect') opt.inspect = true;
    else if (a.startsWith('--inspect=')) { opt.inspect = true; opt.dir = path.dirname(path.resolve(a.slice('--inspect='.length))); opt._inspectFile = path.resolve(a.slice('--inspect='.length)); }
    else if (a === '--quiet') opt.quiet = true;
    else if (a === '--no-prune') opt.prune = false;
    else if (a === '--dir') { const [v, j] = take(i, a); opt.dir = v; i = j; }
    else if (a.startsWith('--dir=')) opt.dir = a.slice('--dir='.length);
    else if (a === '--template') { const [v, j] = take(i, a); opt.template = v; i = j; }
    else if (a.startsWith('--template=')) opt.template = a.slice('--template='.length);
    else if (a === '--name') { const [v, j] = take(i, a); opt.name = v; i = j; }
    else if (a.startsWith('--name=')) opt.name = a.slice('--name='.length);
    else if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
    else { console.error('未知参数:', a); printHelp(); process.exit(2); }
  }
}
function printHelp() {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')
    .split('\n').filter((l) => l.startsWith(' *')).map((l) => l.replace(/^ \* ?/, '')).join('\n'));
}
const say = (...a) => { if (!opt.quiet) console.log(...a); };
function fail(msg) { console.error('✗ ' + msg); process.exit(1); }

// ─────────────────────── 坏字符的编码：GBK / ANSI ───────────────────────
// Node 只有 UTF-8 编码器，没有 GBK 编码器；但 TextDecoder 支持 GBK 解码。
// 于是反查：把 GBK 双字节空间暴力解一遍，按需缓存「字符 → 字节」。
let _gbkDec;
const _ansiCache = new Map();
function gbkDecoder() {
  if (_gbkDec === undefined) {
    try { _gbkDec = new TextDecoder('gbk'); } catch { _gbkDec = null; }
  }
  return _gbkDec;
}
function ansiDecode(buf) {
  const d = gbkDecoder();
  if (!d) return buf.toString('latin1');
  try { return d.decode(buf); } catch { return buf.toString('latin1'); }
}
function ansiEncode(str) {
  if (!/[\u0080-\uffff]/.test(str)) return Buffer.from(str, 'latin1');
  const d = gbkDecoder();
  if (!d) throw new Error('当前 Node 不带 GBK 支持（small-icu 构建？），无法写中文 ANSI 字段');
  const out = [];
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (code < 0x80) { out.push(Buffer.from([code])); continue; }
    let hit = _ansiCache.get(ch);
    if (!hit) {
      outer: for (let b1 = 0x81; b1 <= 0xfe; b1++) {
        for (let b2 = 0x40; b2 <= 0xfe; b2++) {
          if (b2 === 0x7f) continue;
          let s;
          try { s = d.decode(Uint8Array.from([b1, b2])); } catch { continue; }
          if (s === ch) { hit = Buffer.from([b1, b2]); break outer; }
        }
      }
      if (!hit) throw new Error(`GBK 码页里没有这个字符：${JSON.stringify(ch)}`);
      _ansiCache.set(ch, hit);
    }
    out.push(hit);
  }
  return Buffer.concat(out);
}

// ───────────────────────── .lnk 解析 ─────────────────────────
const FLAG = {
  HasLinkTargetIDList: 0x00000001,
  HasLinkInfo: 0x00000002,
  HasName: 0x00000004,
  HasRelativePath: 0x00000008,
  HasWorkingDir: 0x00000010,
  HasArguments: 0x00000020,
  HasIconLocation: 0x00000040,
  IsUnicode: 0x00000080,
};
const STRING_FIELDS = [
  [FLAG.HasName, 'NAME_STRING'],
  [FLAG.HasRelativePath, 'RELATIVE_PATH'],
  [FLAG.HasWorkingDir, 'WORKING_DIR'],
  [FLAG.HasArguments, 'COMMAND_LINE_ARGS'],
  [FLAG.HasIconLocation, 'ICON_LOCATION'],
];
/** 承载「一个 Windows 路径」的 ExtraData 块签名（ANSI 260 + UTF-16 520 布局）。 */
const ENV_BLOCK_SIGS = new Set([0xa0000001, 0xa0000007, 0xa0000008]);

function parseLnk(buf) {
  const b = buf;
  if (b.length < 0x4c) throw new Error('太短，不是 .lnk');
  const headerSize = b.readUInt32LE(0);
  if (headerSize !== 0x4c) throw new Error(`HeaderSize 异常：${headerSize}`);
  const cls = b.subarray(4, 20).toString('hex');
  if (cls !== '0114020000000000c000000000000046') throw new Error('LinkCLSID 不是 Shell Link：' + cls);
  const flags = b.readUInt32LE(20);
  const out = { buf: b, headerSize, flags, idl: null, strings: {}, strStart: null, strEnd: null, extra: null };

  let off = headerSize; // HeaderSize 之后紧跟 IDList / LinkInfo / StringData
  /* ⚠️ 2026-10-12：段顺序修正 —— MS-SHLLINK 的真实顺序是
   * [header][IDList][LinkInfo][StringData][ExtraData]，**IDList 在 LinkInfo 之前**。
   * 原来这里先读 LinkInfo：对系统 API（ctypes IShellLink）生成的 lnk（两者位都开着），
   * 会在 IDList 起点把 IDListSize 字段误当 LinkInfoSize，偏移从此错位，
   * 读出 offset 1311149 之类的越界（自检报「文件可解析」失败）。
   * Windows 自己生成的、以及 `01_yolo_lab/scripts/make_lnk.py` 产物都是这个顺序 ——
   * 解析器必须先走 IDList。（同族教训：windows-lnk-rewrite skill 的 build() 顺序 bug，同日修。） */
  if (flags & FLAG.HasLinkTargetIDList) {
    const sizeOff = off;
    const total = b.readUInt16LE(off);
    const start = off + 2;
    const end = start + total;
    if (end > b.length) throw new Error('IDList 越界');
    const items = [];
    let p = start;
    while (p < end - 1) {
      const size = b.readUInt16LE(p);
      if (size === 0) { p += 2; break; }
      if (size < 3 || p + size > b.length) throw new Error(`IDList item 越界 @${p}`);
      const type = b[p + 2];
      const it = { start: p, size, type, nameStart: null, nameEnd: null, enc: null, name: '', attrs: null };
      if (type === 0x1f) {
        it.enc = 'clsid';
        it.clsid = b.subarray(p + 4, p + 20).toString('hex');
      } else if (type === 0x2f) {
        it.enc = 'ansi';
        /* ⚠️ 盘符段的头部只有 3 字节（2 size + 1 type），名字从 p+3 起；
         *    记下自己的头部长度，别让改写端按 0x31 的 14 字节算余量
         *    （算出来是负数，从零构造的 IDList 会在「D:\」这段直接 fail）。 */
        it.hdr = 3;
        it.nameStart = p + 3;
        let i = p + 3; while (i < p + size && b[i]) i++;
        it.nameEnd = i;
        it.name = ansiDecode(b.subarray(p + 3, i));
      } else if (type === 0x31 || type === 0x32) {
        it.enc = 'ansi';
        it.attrs = b.readUInt16LE(p + 12);
        it.nameStart = p + 14;
        let i = p + 14; while (i < p + size && b[i]) i++;
        it.nameEnd = i;
        it.name = ansiDecode(b.subarray(p + 14, i));
      } else if (type === 0x35 || type === 0x36) {
        it.enc = 'utf16';
        it.attrs = b.readUInt16LE(p + 12);
        it.nameStart = p + 14;
        let i = p + 14; while (i + 1 < p + size && (b[i] || b[i + 1])) i += 2;
        it.nameEnd = i;
        it.name = b.subarray(p + 14, i).toString('utf16le');
      } else {
        it.enc = 'unknown';
      }
      items.push(it);
      p += size;
    }
    out.idl = { sizeOff, total, start, end, items };
    off = end;
  }

  if (flags & FLAG.HasLinkInfo) {
    // 本工具不支持改写含 LinkInfo 的模板（保留字段，跳过后读 StringData 才不错位）。
    // ⚠️ 必须在 IDList **之后**跳（规范顺序），见上面 2026-10-12 那段。
    const liSize = b.readUInt32LE(off);
    out.linkInfo = { start: off, size: liSize };
    off += liSize;
  }

  const unicode = !!(flags & FLAG.IsUnicode);
  out.strStart = off;
  for (const [mask, key] of STRING_FIELDS) {
    if (!(flags & mask)) { out.strings[key] = null; continue; }
    const cnt = b.readUInt16LE(off); off += 2;
    out.strings[key] = unicode
      ? b.subarray(off, off + cnt * 2).toString('utf16le')
      : ansiDecode(b.subarray(off, off + cnt));
    off += unicode ? cnt * 2 : cnt;
  }
  out.strEnd = off;

  const blocks = [];
  let p = off;
  while (p + 4 <= b.length) {
    const size = b.readUInt32LE(p);
    const sig = p + 8 <= b.length ? b.readUInt32LE(p + 4) : 0;
    if (size === 0 || sig === 0) {
      // 结束块。规范写的是 8 字节（BlockSize=4 + BlockSignature=0），
      // 但本机 Explorer 实际写出的是**只有 4 字节 BlockSize** 的截断形式。
      // 两种都按结束处理 —— 别把正常收尾报成「尾部有垃圾」。
      blocks.push({ start: p, size: 4, sig: 0 });
      p += Math.min(b.length - p, 4);
      break;
    }
    blocks.push({ start: p, size, sig });
    if (size < 8 || p + size > b.length) { out.extraTruncated = true; break; }
    p += size;
  }
  out.extra = { start: off, end: p, blocks };
  if (p !== b.length) out.tailBytes = b.length - p;
  return out;
}

/** 把 IDList 还原成绝对路径（用于 --check 判断「指的还是不是现实」）。 */
function idlToPath(idl) {
  if (!idl) return null;
  const names = idl.items
    .filter((it) => it.enc === 'ansi' || it.enc === 'utf16')
    .map((it) => it.name);
  if (!names.length) return null;
  const drive = names[0];
  return drive.replace(/\\+$/, '') + '\\' + names.slice(1).join('\\');
}

// ─────────────────── 从零构造 IDList（无模板时的兜底） ───────────────────
const CLSID_MYCOMPUTER = Buffer.from('e04fd020ea3a6910a2d808002b30309d', 'hex');
function buildIDListFromScratch(absTarget) {
  const norm = path.resolve(absTarget);
  const m = /^([A-Za-z]:\\)(.*)$/.exec(norm);
  if (!m) throw new Error('只支持本地盘符路径，收到：' + norm);
  const drive = m[1];
  const segs = m[2].split('\\').filter(Boolean);
  const parts = [];

  const root = Buffer.alloc(20);
  root.writeUInt16LE(0x14, 0); root[2] = 0x1f; root[3] = 0;
  CLSID_MYCOMPUTER.copy(root, 4);
  parts.push(root);

  const driveName = Buffer.from(drive, 'latin1');
  const dsz = 3 + driveName.length + 1;
  const dbuf = Buffer.alloc(dsz);
  dbuf.writeUInt16LE(dsz, 0); dbuf[2] = 0x2f; dbuf[3] = 0;
  driveName.copy(dbuf, 3);
  parts.push(dbuf);

  let acc = drive.replace(/\\+$/, '');
  segs.forEach((name, i) => {
    acc = acc + '\\' + name;
    let st = null;
    try { st = fs.statSync(acc); } catch { /* 目标不存在也要写出来，--check 会报 */ }
    const isDir = st ? st.isDirectory() : i !== segs.length - 1;
    const nb = ansiEncode(name);
    const size = 14 + nb.length + 1;
    if (size > 0xffff) throw new Error('路径段太长：' + name);
    const buf = Buffer.alloc(size);
    buf.writeUInt16LE(size, 0);
    buf[2] = 0x31; buf[3] = 0;
    buf.writeUInt32LE(isDir || !st ? 0 : st.size, 4);
    buf.writeUInt32LE(0, 8);
    buf.writeUInt16LE(isDir ? 0x10 : 0x2000, 12);
    nb.copy(buf, 14);
    parts.push(buf);
  });

  /* ⚠️ 终止项（2 字节零）必须**进列表、计入 total**：真实 lnk 的 IDList size
   *    就含终止项，parseLnk 按 `off = start + total` 接着读 StringData——
   *    少这 2 字节，后面的字符串字段全体错位（第一版从零构造就栽在这里）。 */
  const list = Buffer.concat([...parts, Buffer.alloc(2)]);
  if (list.length > 0xffff) throw new Error('IDList 超过 65535 字节');
  const total = Buffer.alloc(2);
  total.writeUInt16LE(list.length, 0);
  return Buffer.concat([total, list]);
}

// ───────────────────────── 构建目标信息 ─────────────────────────
function findLauncher() {
  const hits = fs.readdirSync(ROOT).filter((n) => /^启动.*\.bat$/i.test(n));
  if (hits.length === 0) {
    fail(`仓库根目录没有找到「启动*.bat」启动器：${ROOT}`);
  }
  if (hits.length > 1) {
    fail(`仓库根目录有多个「启动*.bat」，无法判断用哪个：${hits.join(' / ')}`);
  }
  return hits[0];
}

function displayName(product) {
  if (opt.name) return opt.name;
  let desc = '';
  try { desc = String(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).description || ''); } catch { }
  let tag = desc.trim().replace(/^[^：:]{0,20}[：:]/, '').split(/[（(【\[]/)[0].trim().replace(/[。；;，,、\s]+$/, '');
  return tag ? `${product} · ${tag}` : product;
}

function userDesktop() {
  const home = os.homedir();
  const cands = [path.join(home, 'Desktop'), path.join(home, 'OneDrive', 'Desktop'), path.join(home, '桌面')];
  // 优先桌面.ini 指向的真实目录（中文系统可能被重定向）
  return cands.find((c) => { try { return fs.statSync(c).isDirectory(); } catch { return false; } }) || null;
}

// ───────────────────────── 主流程 ─────────────────────────
const launcher = findLauncher();
const product = launcher.replace(/^启动/, '').replace(/\.bat$/i, '');
const target = path.join(ROOT, launcher);
const icon = fs.existsSync(path.join(ROOT, 'assets', 'icon.ico')) ? path.join(ROOT, 'assets', 'icon.ico') : null;
const shName = product;
const showName = displayName(product);

const outDir = opt.dir ? path.resolve(opt.dir) : userDesktop();
if (!outDir) fail('找不到桌面目录；用 --dir <目录> 显式指定');
if (!fs.existsSync(outDir)) fail('目录不存在：' + outDir);
const lnkPath = path.join(outDir, shName + '.lnk');

if (launcher.includes('太阳系')) {
  say('⚠ 启动器文件名里还留着「太阳系」——那是尺度层级名，作为产品名不合适（检查一下是不是漏改了）。');
}

// ── --inspect：把 .lnk 的结构摊开看（排障用，不写盘） ──
const FLAG_NAMES = [
  [0x00000001, 'HasLinkTargetIDList'], [0x00000002, 'HasLinkInfo'], [0x00000004, 'HasName'],
  [0x00000008, 'HasRelativePath'], [0x00000010, 'HasWorkingDir'], [0x00000020, 'HasArguments'],
  [0x00000040, 'HasIconLocation'], [0x00000080, 'IsUnicode'], [0x00000100, 'ForceNoLinkInfo'],
  [0x00000200, 'HasExpString'], [0x00001000, 'HasDarwinID'], [0x00004000, 'HasExpIcon'],
  [0x00008000, 'NoPidlAlias'], [0x00010000, 'RunWithShimLayer'], [0x00020000, 'ForceNoLinkTrack'],
  [0x00040000, 'EnableTargetMetadata'], [0x00080000, 'DisableLinkPathTracking'],
  [0x00100000, 'DisableKnownFolderTracking'], [0x00200000, 'DisableKnownFolderAlias'],
  [0x00400000, 'AllowLinkToLink'], [0x00800000, 'UnaliasOnSave'],
  [0x01000000, 'PreferEnvironmentPath'], [0x02000000, 'KeepLocalIDListForUNCTarget'],
];
const EXTRA_NAMES = {
  0xa0000001: 'EnvironmentVariable', 0xa0000002: 'Console', 0xa0000003: 'Tracker',
  0xa0000004: 'ConsoleFE', 0xa0000005: 'SpecialFolder', 0xa0000006: 'Darwin',
  0xa0000007: 'IconEnvironment', 0xa0000008: 'Shim', 0xa0000009: 'PropertyStore',
  0xa000000a: 'KnownFolder', 0xa000000b: 'VistaAndAboveIDList',
};
function runInspect(file) {
  if (!fs.existsSync(file)) fail('文件不存在：' + file);
  const p = parseLnk(fs.readFileSync(file));
  console.log(`文件       ${file}   (${p.buf.length} 字节)`);
  console.log(`LinkFlags  0x${p.flags.toString(16).padStart(8, '0')}  ` +
    FLAG_NAMES.filter(([m]) => p.flags & m).map(([, n]) => n).join(' | '));
  const itypes = {
    0x1f: 'RootFolder', 0x2f: 'Drive', 0x31: 'Entry(ANSI)',
    0x32: 'Entry(ANSI+ext)', 0x35: 'Entry(UTF16)', 0x36: 'Entry(UTF16+attr)',
  };
  if (p.idl) {
    console.log(`\n[LinkTargetIDList] ${p.idl.items.length} 项，共 ${p.idl.total} 字节`);
    for (const it of p.idl.items) {
      const label = itypes[it.type] || ('0x' + it.type.toString(16));
      const nm = it.enc === 'clsid' ? 'CLSID ' + it.clsid
        : it.enc === 'unknown' ? '(未解析)' : JSON.stringify(it.name);
      console.log(`  @${String(it.start).padStart(5)}  尺寸 ${String(it.size).padStart(4)}  ${label.padEnd(16)} ${nm}`);
    }
    console.log(`  还原路径   ${idlToPath(p.idl)}`);
  } else console.log('\n[LinkTargetIDList] 不存在（靠 LinkInfo / RelativePath 定位）');
  console.log('\n[StringData]');
  for (const [, key] of STRING_FIELDS) {
    console.log(`  ${key.padEnd(18)} ${p.strings[key] === null ? '(无)' : JSON.stringify(p.strings[key])}`);
  }
  console.log('\n[ExtraData]  （顺序：BlockSize 在前、BlockSignature 在后）');
  for (const bl of p.extra.blocks) {
    console.log(`  @${String(bl.start).padStart(5)}  尺寸 ${String(bl.size).padStart(4)}  ${EXTRA_NAMES[bl.sig] || ('0x' + bl.sig.toString(16))}`);
    if (bl.size >= 8 + 780 && bl.start + 8 + 780 <= p.buf.length) {
      console.log(`         Ansi    ${JSON.stringify(ansiDecode(p.buf.subarray(bl.start + 8, bl.start + 8 + 260)).split('\0')[0])}`);
      console.log(`         Unicode ${JSON.stringify(p.buf.subarray(bl.start + 268, bl.start + 268 + 520).toString('utf16le').split('\0')[0])}`);
    }
  }
  if (p.extraTruncated) console.log('  ! ExtraData 未完整解析');
  if (p.tailBytes) console.log(`  ! 尾部还有 ${p.tailBytes} 字节未解析`);
  process.exit(0);
}

// ── --check 模式 ──
if (opt.inspect) runInspect(opt._inspectFile || lnkPath);
if (opt.check) process.exit(runCheck());

function runCheck() {
  console.log(`检查目标：${lnkPath}`);
  const rows = [];
  const add = (ok, label, detail) => { rows.push({ ok, label, detail }); };

  if (!fs.existsSync(lnkPath)) {
    add(false, '快捷方式存在', `没有 ${shName}.lnk`);
  } else {
    let p = null;
    try { p = parseLnk(fs.readFileSync(lnkPath)); } catch (e) { add(false, '文件可解析', e.message); }
    if (p) {
      const idlPath = idlToPath(p.idl);
      if (idlPath) {
        const same = path.resolve(idlPath).toLowerCase() === target.toLowerCase();
        if (same) {
          add(true, 'IDList 指向', idlPath);
        } else if (fs.existsSync(idlPath)) {
          // 指向**另一份副本**（便携版 / 另一个克隆 / 另一处开发目录）。
          // 这不是故障：那份副本还在，快捷方式指向它是合理的。
          // 否则便携版包里跑自检会常年报 warn —— 那等于训练用户忽略自检。
          add(true, 'IDList 指向', `${idlPath}  ← 指向另一份副本，本目录不接管它`);
        } else {
          add(false, 'IDList 指向', `${idlPath}  ← 该文件不存在；本目录的目标是 ${target}`);
        }
      }
      const rel = p.strings.RELATIVE_PATH;
      if (rel) {
        const rp = path.resolve(outDir, rel);
        add(fs.existsSync(rp), 'RELATIVE_PATH 可解析', `${rel} → ${rp}${fs.existsSync(rp) ? '' : ' (不存在)'}`);
      }
      const wd = p.strings.WORKING_DIR;
      if (wd) add(fs.existsSync(wd), 'WORKING_DIR 存在', wd);
      const ic = p.strings.ICON_LOCATION;
      if (ic) add(fs.existsSync(ic), 'ICON_LOCATION 存在', ic);
      const nm = p.strings.NAME_STRING;
      add(!nm || nm.includes(product), 'NAME_STRING 含产品名', JSON.stringify(nm));
    }
  }

  // 顺手把「指向本项目、但名字已过期」的同伙也翻出来 ——
  // 只说「没有新快捷方式」等于把线索丢了一半：旧的那个才是双击报错的元凶。
  const tokens = [Buffer.from(path.basename(ROOT), 'utf16le'), Buffer.from(product, 'utf16le'), ansiEncode(path.basename(ROOT))];
  const stale = [];
  let names = [];
  try { names = fs.readdirSync(outDir); } catch { }
  for (const n of names) {
    if (!n.toLowerCase().endsWith('.lnk') || n === path.basename(lnkPath)) continue;
    const full = path.join(outDir, n);
    let raw;
    try { if (!fs.statSync(full).isFile()) continue; raw = fs.readFileSync(full); } catch { continue; }
    if (!tokens.some((t) => raw.includes(t))) continue;
    let detail = full;
    try {
      const idlPath = idlToPath(parseLnk(raw).idl);
      detail = idlPath + (fs.existsSync(idlPath) ? '' : '   ← 目标不存在');
    } catch { }
    stale.push(`${n}  →  ${detail}`);
  }
  if (stale.length) add(false, '旧名快捷方式', stale.join('\n' + ' '.repeat(24)));

  let bad = 0;
  for (const r of rows) {
    if (!r.ok) bad++;
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.label.padEnd(20)} ${r.detail}`);
  }
  console.log(bad === 0
    ? '结论：一致，无需刷新。'
    : `结论：有 ${bad} 项不一致 → 跑 \`node tools/install-shortcut.mjs\` 刷新。`);
  return bad === 0 ? 0 : 1;
}

// ── 安装 / 刷新 ──
say(`产品名   ${product}   （从启动器「${launcher}」推导）`);
say(`目标     ${target}`);
say(`图标     ${icon || '(无 assets/icon.ico)'}`);
say(`工具提示 ${showName}`);
say(`落点     ${lnkPath}`);

// 1. 选模板
let templatePath = null;
if (opt.template) {
  if (!fs.existsSync(opt.template)) fail('--template 指定的文件不存在：' + opt.template);
  templatePath = opt.template;
} else if (fs.existsSync(lnkPath)) {
  templatePath = lnkPath;
} else {
  // 桌面/隔离区里找本项目残留的旧名 .lnk 当结构模板
  const probes = [];
  for (const dir of [outDir, TRASH]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.toLowerCase().endsWith('.lnk')) continue;
      const full = path.join(dir, n);
      try {
        const raw = fs.readFileSync(full);
        if (raw.includes(Buffer.from(launcher, 'utf16le')) ||
            raw.includes(Buffer.from(product, 'utf16le')) ||
            raw.includes(ansiEncode(path.basename(ROOT)))) probes.push({ full, mtime: fs.statSync(full).mtimeMs });
      } catch { }
    }
  }
  probes.sort((a, b) => b.mtime - a.mtime);
  if (probes.length) templatePath = probes[0].full;
}
say(templatePath ? `模板     ${templatePath}` : '模板     (无 → 从零构造 IDList)');

// 2. 取模板字节，或从零起一个骨架
let out;
let parsed = null;
if (templatePath) {
  out = Buffer.from(fs.readFileSync(templatePath));
  parsed = parseLnk(out);
  if (parsed.extraTruncated) say('⚠ 模板的 ExtraData 尾部不完整，将原样保留。');
} else {
  const SCRATCH_FLAGS = FLAG.HasLinkTargetIDList | FLAG.HasName | FLAG.HasRelativePath
    | FLAG.HasWorkingDir | FLAG.HasIconLocation | FLAG.IsUnicode;
  const hdr = Buffer.alloc(0x4c);
  hdr.writeUInt32LE(0x4c, 0);
  Buffer.from('0114020000000000c000000000000046', 'hex').copy(hdr, 4);
  hdr.writeUInt32LE(SCRATCH_FLAGS, 20);
  hdr.writeUInt32LE(0x20, 24);  // FileAttributes = ARCHIVE
  hdr.writeUInt32LE(0, 0x34);   // FileSize
  hdr.writeUInt32LE(0, 0x38);   // IconIndex
  hdr.writeUInt32LE(1, 0x3c);   // ShowCommand = SW_SHOWNORMAL
  /* ⚠️ flags 里声明的 StringData **必须真的写出来**：原来只写 Header + IDList +
   *    终止符，parseLnk 按 flags 读 4 个字符串字段时直接越界
   *    （ERR_OUT_OF_RANGE @197/195）——「从零构造」这条路第一次真正被走到就塌了
   *    （此前每次都能在 .trash 里翻到旧 .lnk 当模板，等于没测过）。
   *    占位值直接用真实值；第 4 步会按同一套口径重建并跑写盘前自校验。 */
  const parts = [hdr, buildIDListFromScratch(target)];   // IDList 自带终止项（含在 size 里）
  const scratchStrings = [
    showName,                                          // NAME_STRING
    '.\\' + path.relative(outDir, target),             // RELATIVE_PATH
    ROOT,                                              // WORKING_DIR
    icon,                                              // ICON_LOCATION
  ];
  for (const v of scratchStrings) {
    if (v == null) continue;
    const cnt = Buffer.alloc(2);
    cnt.writeUInt16LE(v.length, 0);
    parts.push(cnt, Buffer.from(v, 'utf16le'));
  }
  out = Buffer.concat(parts);
  parsed = parseLnk(out);
  say('（从零构造：只做过结构自校验，请双击确认一次）');
}

let flags = parsed.flags;   // 618 行的 relPath 可能要清位，必须是 let
const unicode = !!(flags & FLAG.IsUnicode);

// 3. 改写 IDList：按位置对齐路径段，替换名称，尺寸不变
let idlBuf;
if (parsed.idl) {
  const norm = path.resolve(target);
  const m = /^([A-Za-z]:\\)(.*)$/.exec(norm);
  if (!m) fail('只支持本地盘符路径：' + norm);
  const want = [m[1], ...m[2].split('\\').filter(Boolean)];
  const items = parsed.idl.items;
  const named = items.filter((it) => it.enc === 'ansi' || it.enc === 'utf16');
  if (named.length !== want.length) {
    fail(`模板 IDList 有 ${named.length} 个路径段，目标路径有 ${want.length} 段，结构对不上。\n` +
      `   模板：${named.map((i) => i.name).join(' \\ ')}\n` +
      `   目标：${want.join(' \\ ')}\n` +
      `   处置：删掉这个 .lnk 后重跑（会从零构造），或用 --template 指定一个同盘符的模板。`);
  }
  named.forEach((it, i) => {
    const name = want[i];
    const bytes = it.enc === 'utf16' ? Buffer.from(name, 'utf16le') : ansiEncode(name);
    const termLen = it.enc === 'utf16' ? 2 : 1;
    /* 头部大小：0x31/0x32/0x35/0x36 段是 14 字节；0x2f（盘符）段只有 3 字节
     * （解析端在 it.hdr 里记了自己的值）。按各自头部算余量，别一刀切。 */
    const hdrLen = it.hdr ?? 14;
    const room = it.size - hdrLen - termLen;
    if (bytes.length > room) {
      fail(`第 ${i} 段「${name}」需要 ${bytes.length} 字节，模板只留了 ${room} 字节。\n` +
        `   处置：删掉这个 .lnk 后重跑（会从零构造）。`);
    }
    out.fill(0, it.nameStart, it.start + it.size);       // 先清干净（含 NUL 与余量）
    bytes.copy(out, it.nameStart);
  });
  idlBuf = out.subarray(parsed.idl.sizeOff, parsed.idl.end);
  say(`IDList   ${named.length} 段已对齐（尺寸未变，偏移零调整）`);
} else {
  idlBuf = buildIDListFromScratch(target);
  out.writeUInt32LE(flags | FLAG.HasLinkTargetIDList, 20);
  say('IDList   从零构造（模板里没有）');
}

// 4. 重建 StringData
const relRaw = path.relative(outDir, target);
const relPath = (!relRaw.startsWith('..') && !path.isAbsolute(relRaw)) ? '.\\' + relRaw : null;
/* ⚠️ 跨盘符时 relative() 给出绝对路径 ⇒ relPath = null。此时**必须把
 * HasRelativePath 标志位清掉**（连 Header 里的位一起改），否则第 4 步重建
 * StringData 会跳过这个字段而 flags 仍声明它 ⇒ 解析端全体错位、写盘前自校验
 * 必炸。项目搬到 D 盘后这工具就因为这个一直装不上（自检挂了几个月的真因）。 */
if (relPath === null) {
  flags &= ~FLAG.HasRelativePath;
  out.writeUInt32LE(flags, 20);   // Header + 20 = LinkFlags，前缀会原样进成品
}
const values = {
  NAME_STRING: parsed.strings.NAME_STRING === null ? null : showName,
  RELATIVE_PATH: parsed.strings.RELATIVE_PATH === null ? null : relPath,
  WORKING_DIR: parsed.strings.WORKING_DIR === null ? null : ROOT,
  COMMAND_LINE_ARGS: parsed.strings.COMMAND_LINE_ARGS,
  ICON_LOCATION: parsed.strings.ICON_LOCATION === null ? null : icon,
};
const chunks = [];
let written = 0;
for (const [mask, key] of STRING_FIELDS) {
  if (!(flags & mask)) continue;
  const v = values[key];
  if (v === null || v === undefined) continue;
  const body = unicode ? Buffer.from(v, 'utf16le') : ansiEncode(v);
  const cnt = Buffer.alloc(2);
  cnt.writeUInt16LE(v.length, 0);
  chunks.push(cnt, body);
  written++;
}
const strBuf = Buffer.concat(chunks);
say(`StringData ${written} 个字段已重建`);

// 5. 改写 ExtraData 里的路径块（图标路径也藏在这里，最容易漏）
let extraBuf = out.subarray(parsed.extra.start);
if (parsed.extra.blocks.some((bl) => ENV_BLOCK_SIGS.has(bl.sig))) {
  extraBuf = Buffer.from(extraBuf);
  for (const bl of parsed.extra.blocks) {
    if (!ENV_BLOCK_SIGS.has(bl.sig)) continue;
    if (bl.size < 8 + 260 + 520) continue;
    const ansiOff = bl.start - parsed.extra.start + 8;
    const wideOff = ansiOff + 260;
    const oldAnsi = extraBuf.subarray(ansiOff, ansiOff + 260).toString('latin1').split('\0')[0];
    const isIcon = /icon\.(ico|png)$/i.test(oldAnsi);
    const newAbs = (isIcon ? icon : target) || target;
    const newVal = newAbs.startsWith(os.homedir())
      ? '%USERPROFILE%' + newAbs.slice(os.homedir().length)
      : newAbs;
    const nb = ansiEncode(newVal);
    if (nb.length >= 260) fail('ExtraData 路径块装不下新路径：' + newVal);
    extraBuf.fill(0, ansiOff, ansiOff + 260);
    nb.copy(extraBuf, ansiOff);
    extraBuf.fill(0, wideOff, wideOff + 520);
    Buffer.from(newVal, 'utf16le').copy(extraBuf, wideOff);
    say(`ExtraData 路径块已更新 → ${newVal}`);
  }
}

// 6. 拼装 + 自校验（不许静默写坏）
const result = Buffer.concat([out.subarray(0, parsed.strStart), strBuf, extraBuf]);
const verify = parseLnk(result);
const problems = [];
if (idlToPath(verify.idl) && path.resolve(idlToPath(verify.idl)).toLowerCase() !== path.resolve(target).toLowerCase()) {
  problems.push(`IDList 指向 ${idlToPath(verify.idl)}，期望 ${target}`);
}
if (values.NAME_STRING !== null && verify.strings.NAME_STRING !== values.NAME_STRING) problems.push('NAME_STRING 写回不一致');
if (values.RELATIVE_PATH !== null && verify.strings.RELATIVE_PATH !== values.RELATIVE_PATH) problems.push('RELATIVE_PATH 写回不一致');
if (values.WORKING_DIR !== null && verify.strings.WORKING_DIR !== values.WORKING_DIR) problems.push('WORKING_DIR 写回不一致');
if (values.ICON_LOCATION !== null && verify.strings.ICON_LOCATION !== values.ICON_LOCATION) problems.push('ICON_LOCATION 写回不一致');
if (verify.extraTruncated) problems.push('ExtraData 解析不完整');
if (problems.length) fail('写盘前自校验失败（未写任何文件）：\n   - ' + problems.join('\n   - '));
say('自校验 通过（重新解析写出的字节，逐字段核对）');

// 7. 备份 + 落盘
function quarantine(file) {
  fs.mkdirSync(TRASH, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  let dest = path.join(TRASH, `${stamp}-${path.basename(file)}`);
  for (let k = 2; fs.existsSync(dest); k++) dest = path.join(TRASH, `${stamp}-${path.basename(file)}.${k}`);
  fs.renameSync(file, dest);
  return dest;
}
if (fs.existsSync(lnkPath)) {
  const bak = quarantine(lnkPath);
  say(`备份     ${path.relative(ROOT, bak)}`);
}
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(lnkPath, result);
say(`已写入   ${lnkPath}  (${result.length} 字节)`);

// 8. 清理同项目的旧名快捷方式
if (opt.prune) {
  const tokens = [Buffer.from(path.basename(ROOT), 'utf16le'), Buffer.from(product, 'utf16le'), ansiEncode(path.basename(ROOT))];
  let names = [];
  try { names = fs.readdirSync(outDir); } catch { }
  for (const n of names) {
    if (!n.toLowerCase().endsWith('.lnk')) continue;
    if (n === path.basename(lnkPath)) continue;
    const full = path.join(outDir, n);
    let raw;
    try { if (!fs.statSync(full).isFile()) continue; raw = fs.readFileSync(full); } catch { continue; }
    if (tokens.some((t) => raw.includes(t))) {
      const dest = quarantine(full);
      say(`清理     ${n} → ${path.relative(ROOT, dest)}（指向本项目但名字已过期）`);
    }
  }
}

say('');
say('完成。双击确认一次即可（会启动本地服务并弹出应用窗口）。');
process.exit(0);
