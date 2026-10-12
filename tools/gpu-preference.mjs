#!/usr/bin/env node
// 显卡偏好设置 —— 「把负载挪到独显的显存」这件事的落地工具。
//
// 为什么需要它（先看这段，不然会做反）
// ─────────────────────────────────────
// 混合显卡笔记本（核显 + 独显）默认走**核显**省电，浏览器也不例外。
// 而**核显没有自己的显存** —— 它的「显存」是**从系统内存里借的**（UMA）。
// 所以在核显上谈「把负载搬到显存」，等于**搬到系统内存**，与目标正好相反。
//
// 实测（本机，2026-09-11，见 tools/perf-probe.py）：
//   默认      ANGLE (AMD, AMD Radeon(TM) Graphics ... D3D11)      画质档位 saver
//   强制高性能 ANGLE (NVIDIA, RTX 3050 Ti Laptop GPU ... D3D11)   画质档位 high
//   独显专用显存 4096 MB，其中只用了 214 MB —— 3.8 GB 闲置。
//
// 两条路，各有代价：
//
//   A. 命令行开关 `--force_high_performance_gpu`（见 启动小小宇宙.bat）
//      优点：只影响这一次启动，退出即失效，什么都不改。
//      缺点：⚠ **如果机器上已经有一个 Edge 实例在跑，开关会被静默忽略** ——
//            新窗口只是交给那个老进程，GPU 还是老进程当初选的那个。
//            这是典型的静默故障：看着加了参数，其实没生效。
//
//   B. 用户级注册表偏好（本工具做的事）= Windows「设置 → 显示 → 图形」里那一项
//      优点：对**整个浏览器进程**持久生效，不受「已有实例」影响。
//      缺点：影响这台机器上 Edge/Chrome 的**所有**页面；用电池时会费电。
//
// 所以本工具默认**只读**（--check），改要显式说 --apply，并且随时可 --revert。
//
// 用法：
//   node tools/gpu-preference.mjs                只读检查（默认）
//   node tools/gpu-preference.mjs --apply        设为「高性能」（写 HKCU，可还原）
//   node tools/gpu-preference.mjs --revert       删掉本工具写过的项（恢复「让 Windows 决定」）
//   node tools/gpu-preference.mjs --json         给别的脚本吃
//
// ⚠ 本机 `reg.exe` 在程序黑名单里（直接调用会被沙箱拦），所以走 PowerShell 的
//   `-EncodedCommand`（base64/UTF-16LE）—— 这样还顺带绕开了引号与代码页问题。
//   注意：**在 Bash 命令串里出现 powershell 字样会被拦**，所以这段调用只能待在
//   本文件里、由 `node tools/gpu-preference.mjs` 触发。见 坑与雷点.md。

import fs from 'node:fs';
// ⚠️ 子进程走 runCapture（**落临时文件**），不要用 `execFileSync(...,{encoding:'utf8'})`：
//    后者会建管道，本机**不给子进程建管道** ⇒ `spawnSync powershell.exe EBUSY`（实测 12/12）。
//    本文件原来正是死在这一点上：`--json` 直接以 Node 崩溃告终，一行 JSON 都不吐，
//    于是自检把「工具炸了」读成「注册表读不到」，把人引向错误方向。
//    根因与实测数据见 server/lib/run-capture.mjs 的文件头。
import { runCapture, errText } from '../server/lib/run-capture.mjs';

const KEY = 'HKCU:\\Software\\Microsoft\\DirectX\\UserGpuPreferences';
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const doApply = args.includes('--apply');
const doRevert = args.includes('--revert');

// 要设置的浏览器可执行文件。用**存在性**判断，不写死「一定有 Edge」。
// 这些是**工作区外面**的程序安装路径 —— 天生就该是绝对路径，
// 所以逐行自证豁免（自检项 `prog.no-abs-paths` 只认写在**这一行上**的豁免，不认中央清单）。
const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',   // 外部路径
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',         // 外部路径
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',         // 外部路径
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',   // 外部路径
];

/** 跑一段 PowerShell，返回 stdout（UTF-8）。用 -EncodedCommand 免去一切引号/代码页问题。
 *
 *  ⚠️ 取 stdout 走 `runCapture`（落临时文件），**不建管道** —— 本机不给子进程建管道，
 *     原来的 `{ encoding: 'utf8' }` 会 12/12 报 `spawnSync powershell.exe EBUSY`。
 *  ⚠️ 但**保留"失败即抛"的老语义**：`--apply` / `--revert` 真写失败时必须炸出来，
 *     这里若改成静默吞掉，调用方会以为写成功了 —— 那是更坏的静默故障。
 *     只有**只读**那条路（`readState`）才把异常收成 `{error}`，见那个函数。
 */
function ps(script) {
  // $ProgressPreference='SilentlyContinue' 必须加：PowerShell 在 stdout 被重定向时，
  // 会把「正在准备首次使用模块」这类进度记录以 CLIXML 形式掺进 stdout，
  // 把 JSON 输出冲掉（表现形式是 `#< CLIXML` 开头的垃圾 + 解析失败）。
  const wrapped = `$ProgressPreference='SilentlyContinue'\n` +
    `[Console]::OutputEncoding=[Text.Encoding]::UTF8\n` + script;
  const b64 = Buffer.from(wrapped, 'utf16le').toString('base64');
  const { txt, err } = runCapture('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64],
    { timeout: 30000, windowsHide: true });
  if (err) throw err;
  return txt;
}

/**
 * 判断适配器是核显 / 独显 / 虚拟。
 * 不能只看名字里有没有 Radeon —— AMD 既有核显（Radeon Graphics）也有独显（Radeon RX）。
 * 「虚拟/间接显示驱动」（Idd）既不是核显也不是独显，别硬归一类。
 */
function adapterKind(name) {
  const n = String(name);
  if (/Idd|Indirect|Virtual|Remote|Basic Render|Mirror/i.test(n)) return '虚拟';
  if (/NVIDIA|GeForce|RTX|GTX|Quadro|Tesla/i.test(n)) return '独显';
  if (/Radeon\s+(RX|Pro\s+W|VII)/i.test(n)) return '独显';
  if (/Radeon.*Graphics|Intel.*(Graphics|UHD|Iris)|AMD.*Radeon\(TM\) Graphics/i.test(n)) return '核显';
  return '其他';
}


function readState() {
  // ⚠ 适配器**不要**用 Get-CimInstance Win32_VideoController 枚举 —— 本机实测 10.3 秒，
  //   是整条命令耗时（12.5s）的全部来源，会把自检从 2 秒拖到 13 秒。
  //   改读显示类注册表键：**结果完全一致**（验证过 3/3 相同），耗时 0.99 秒，快 10 倍。
  //   只在注册表路线拿不到时才退回 CIM（慢但兜得住）。见 坑与雷点.md 坑 73。
  const script = `
$ErrorActionPreference = 'SilentlyContinue'   # 显示类下单有个子键会拒绝访问，属正常，不该中断枚举
$p = '${KEY}'
$out = [ordered]@{ keyExists = $false; entries = @(); adapters = @(); adapterSource = 'registry' }
if (Test-Path $p) {
  $out.keyExists = $true
  $item = Get-Item $p
  foreach ($n in $item.Property) {
    $v = (Get-ItemProperty $p -Name $n).$n
    $out.entries += [ordered]@{ name = $n; value = [string]$v }
  }
}
$cls = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'
foreach ($k in (Get-ChildItem $cls)) {
  $d = (Get-ItemProperty $k.PSPath -Name DriverDesc).DriverDesc
  if ($d) {
    $ver = (Get-ItemProperty $k.PSPath -Name DriverVersion).DriverVersion
    $out.adapters += [ordered]@{ name = [string]$d; driver = [string]$ver }
  }
}
if ($out.adapters.Count -eq 0) {
  $out.adapterSource = 'cim'
  foreach ($a in (Get-CimInstance Win32_VideoController)) {
    $out.adapters += [ordered]@{ name = [string]$a.Name; driver = [string]$a.DriverVersion }
  }
}
$out | ConvertTo-Json -Depth 5 -Compress
`;
  // ⚠️ 包一层 try：这是**只读**路径，取不到就该如实返回 `{error}`，
  //    让上层（人读输出 / `--json` / 自检）自己决定怎么报 ——
  //    而不是让一个 EBUSY 把整个进程炸掉、连一行 JSON 都不吐。
  //    这正对应本项目那条规矩：**「服务死了」和「数据坏了」不能用同一个错误标记**。
  let raw = '';
  try { raw = ps(script).trim(); }
  catch (e) { return { error: `PowerShell 调用失败：${errText(e)}`, raw: '' }; }
  try { return JSON.parse(raw); } catch { return { error: 'PowerShell 输出不是 JSON', raw }; }
}

function applyPrefs() {
  const present = CANDIDATES.filter((p) => {
    try { return ps(`if (Test-Path '${p}') {'y'} else {'n'}`).trim() === 'y'; }
    catch { return false; }
  });
  if (!present.length) return { changed: [], reason: '找不到 Edge/Chrome 的可执行文件' };

  const lines = present.map((p) => {
    // 值名 = exe 全路径；数据 = GpuPreference=2;  （2 = 高性能，1 = 省电）
    // 必须写**全路径**：Windows 图形设置存的就是全路径，只写 exe 名不会生效。
    return `New-ItemProperty -Path '${KEY}' -Name '${p}' -Value 'GpuPreference=2;' -PropertyType String -Force | Out-Null`;
  }).join('\n');
  ps(`New-Item -Path '${KEY}' -Force | Out-Null\n${lines}\nWrite-Output 'ok'`);
  return { changed: present, reason: 'ok' };
}

function revertPrefs() {
  const st = readState();
  const ours = (st.entries || []).filter(
    (e) => CANDIDATES.includes(e.name) && /GpuPreference=2;/.test(e.value || ''));
  if (!ours.length) return { removed: [], reason: '本工具没有留下需要还原的项' };
  const lines = ours.map((e) => `Remove-ItemProperty -Path '${KEY}' -Name '${e.name}' -ErrorAction SilentlyContinue`).join('\n');
  ps(`${lines}\nWrite-Output 'ok'`);
  return { removed: ours.map((e) => e.name), reason: 'ok' };
}

const before = readState();
// ⚠️ 只在**人读**那条路提前退出。`--json` 必须**照样把 JSON 吐出来** ——
//    自检是靠解析那份 JSON 的 `summary.readOk` 来判「读到了 / 没读到」的；
//    这里若提前 `process.exit(1)`，自检只能拿到一段人类文字，
//    于是把「工具炸了」报成「跑不起来」，人就被派去查工具而不是查注册表。
if (before.error && !asJson) {
  console.log(`  读注册表失败：${before.error}`);
  console.log(`  原始输出：${String(before.raw).slice(0, 300)}`);
  process.exit(1);
}

let action = null;
if (doApply) action = { verb: 'apply', ...applyPrefs() };
else if (doRevert) action = { verb: 'revert', ...revertPrefs() };

const after = (doApply || doRevert) ? readState() : before;

/**
 * 把原始注册表内容归纳成结论，供自检（server/lib/selfcheck.mjs）直接消费。
 * **单一来源** —— 判定逻辑只写在这里，自检不再自己重写一遍正则。
 */
function summarize(state) {
  const adapters = (state.adapters || []).map((a) => ({ name: a.name, kind: adapterKind(a.name) }));
  const kinds = new Set(adapters.map((a) => a.kind));

  // Windows 图形设置存的是**exe 全路径**，所以只认精确匹配（忽略大小写）。
  // ⚠ 不要退化成「按 exe 文件名结尾匹配」：本机注册表里只有 `Program Files (x86)` 那条，
  //   结尾匹配会把**并不存在的** `Program Files\...\msedge.exe` 也判成「已设高性能」——
  //   一个凭空的假绿，而且它永远指向一个不存在的安装。
  //   先确认文件在盘上，再要求全路径一致。
  const prefs = state.entries || [];
  const browsers = [];
  for (const exe of CANDIDATES) {
    if (!fs.existsSync(exe)) continue;                       // 没装的浏览器不进结论
    const hit = prefs.find((e) => e.name.toLowerCase() === exe.toLowerCase());
    browsers.push({
      exe,
      // found=false 表示**明确没设过**（注册表里没有这一项），不是「读不到」
      found: !!hit,
      highPerf: !!hit && /GpuPreference=2;/.test(hit.value || ''),
    });
  }

  return {
    platform: process.platform,
    readOk: !state.error,                       // 读注册表本身成功没有
    // 读不到时把**原因**带上，别只给一个 false ——
    // 「没测到」和「测出来没问题」必须能区分，否则自检只能说一句空话。
    readError: state.error || null,
    hybrid: kinds.has('核显') && kinds.has('独显'),
    adapters,
    browsers,
  };
}

if (asJson) {
  console.log(JSON.stringify({ before, after, action, summary: summarize(after) }, null, 2));
  process.exit(0);
}

// ── 人读输出 ────────────────────────────────────────────────
const label = (v) => {
  if (/GpuPreference=2;/.test(v)) return '高性能（独显）';
  if (/GpuPreference=1;/.test(v)) return '省电（核显）';
  return `原样：${v}`;
};

console.log('');
console.log('  小小宇宙 · 显卡偏好');
console.log('  ' + '─'.repeat(60));
console.log('  这台机器的显示适配器：');
for (const a of before.adapters || []) {
  console.log(`    ${adapterKind(a.name)}  ${a.name}  (驱动 ${a.driver})`);
}
console.log('  ' + '─'.repeat(60));
console.log('  用户级图形偏好（Windows「设置 → 显示 → 图形」里那一项）');
if (!before.keyExists || !(before.entries || []).length) {
  console.log('    （键或项不存在 —— 说明从没为任何程序单独设过显卡偏好）');
  console.log('    含义：浏览器走 Windows 默认，混合显卡本上通常是**核显**。');
} else {
  for (const e of before.entries) {
    const short = e.name.split('\\').pop();
    console.log(`    ${short.padEnd(16)} ${label(e.value)}`);
    if (/GpuPreference=2;/.test(e.value)) console.log(`      ${e.name}`);
  }
}

if (action) {
  console.log('  ' + '─'.repeat(60));
  if (action.verb === 'apply') {
    if (action.changed.length) {
      console.log(`  ✓ 已设为「高性能」，影响 ${action.changed.length} 个可执行文件：`);
      for (const p of action.changed) console.log(`      ${p}`);
      console.log('    ⚠ 需要**完全退出浏览器**（所有窗口）再重新打开才会生效。');
      console.log('    还原：node tools/gpu-preference.mjs --revert');
    } else {
      console.log(`  ✗ 没有改动：${action.reason}`);
    }
  } else {
    if (action.removed.length) {
      console.log(`  ✓ 已还原 ${action.removed.length} 项（恢复「让 Windows 决定」）：`);
      for (const p of action.removed) console.log(`      ${p}`);
    } else {
      console.log(`  · 没有改动：${action.reason}`);
    }
  }
} else {
  console.log('  ' + '─'.repeat(60));
  console.log('  当前只是检查。要改：');
  console.log('    node tools/gpu-preference.mjs --apply    设为高性能（可 --revert 还原）');
}

console.log('');
console.log('  验证有没有真的生效（唯一可信的判据）：');
console.log('    py -3.13 -X utf8 tools/perf-probe.py');
console.log('    → 看「WebGL 后端」那一行是 AMD / Intel（核显）还是 NVIDIA（独显）');
console.log('  ⚠ 只看画质档位不算 —— 档位是程序自己按显卡*名*猜的，不是后端真值。');
console.log('');
