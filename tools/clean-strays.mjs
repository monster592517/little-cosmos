#!/usr/bin/env node
// -*- coding: utf-8 -*-
/**
 * 清掉「检查脚本泄漏出来的进程」。
 *
 * 为什么有这个东西
 * ----------------
 * 2026-09-11 实测：一次会话里 `probe-galaxy-visual.py` 泄漏了 **七份**残留
 * ——每个 python 探针 + 一个 playwright 驱动 node + （部分还带着）一个
 * `server/server.mjs --port=879X` 的孤儿服务。它们**不死不退**：
 * 主进程卡在极少 CPU 的状态、日志 0 字节，四个小时里被我误读成「跑得慢」。
 *
 * 这是典型的**静默故障**：机器看着正常，实际内存被慢慢吃掉、端口被占死，
 * 而 `serve_for_checks.pick_port()` 会因此跳过一堆端口（更坏的情况是全被占满后报错）。
 * 手工 `netstat` + `taskkill` 每次都要重新盯一遍，所以固化成这个脚本。
 *
 * 判据（谁算「残留」）
 * -------------------
 *   ① **孤儿服务**：命令行里有 `server/server.mjs`，且 `--port=` 落在**检查端口段**
 *      （默认 8791–8805）。**8787 是日常服务，永远不碰。**
 *   ② **探针/检查 python**：命令行里有 `tools/probe-*.py` / `tools/check-*.py`，
 *      且**存活时间超过 `--older-than`**（默认 300 秒）。
 *      这条门槛是必须的：否则刚启动的那次探针会被自己杀掉 —— 上一轮就吃过这个亏。
 *   ③ ① ② 命中之后，用 `taskkill /T` 连子树一起收（playwright 驱动 node 是 python 的子进程，
 *      不用单独点名）。
 *   ④ **孤儿的 playwright 驱动 node**：命令行指向 `playwright[/\]driver[/\]node.exe`，
 *      而它的**父进程已经不在了**。第 23 轮新增 —— 起因是探针加了硬退看门狗：
 *      `os._exit()` **跳过一切清理**，于是 python 干净退出了，它拉起的驱动 node 没人收。
 *      ⚠️ 这类进程**不占端口**，所以原来那条「按端口扫」的判据**根本看不见它**
 *      （实测：工具报「没有发现残留」，而两个驱动 node 正躺在进程表里）。
 *      派生后果：驱动 node **继承着 stdout 管道** ⇒ 调用它的那个 shell 永远等不到管道关闭
 *      ⇒ **包装进程一起卡住**，任务状态一直显示 running。
 *      判据用「**父进程已不在**」而不是存活时间：父在跑 = 正常，父没了 = 孤儿。
 *
 * 用法
 * ----
 *    node tools/clean-strays.mjs                 # 只列，不动手（默认）
 *    node tools/clean-strays.mjs --apply         # 真收工
 *    node tools/clean-strays.mjs --older-than=60 # 放宽存活门槛（调试用）
 *
 * 退出码：0 = 没残留或已收干净；1 = 还剩下没收掉的。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ★ 取仓库根不能用 `new URL(...).pathname`（坑 14：百分号编码，中文路径直接坏事）
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 检查端口段。8787 是日常服务，**不在**这个段里 —— 别扩进来。 */
const CHECK_PORTS = { lo: 8791, hi: 8805 };
/** 日常服务端口，硬保护：命中也不动。 */
const MAIN_PORT = 8787;

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const olderArg = argv.find((a) => a.startsWith('--older-than='));
// 默认 900s（15 分钟）。**别调小**：一次完整探针本来就要跑 2–5 分钟，
// 门槛设在 300s 会让工具去杀**正在正常运行**的探针 —— 那比漏检更坏。
const OLDER_THAN = olderArg ? Number(olderArg.split('=', 2)[1]) : 900;
/** 孤儿驱动 node 的宽限：父已不在也要等这么久才收，避开 PID 复用造成的误判。 */
const DRIVER_GRACE = 60;

const line = (s = '') => process.stdout.write(s + '\n');

// ---------------------------------------------------------------------------
// 取进程表（要命令行 ⇒ 只能走 CIM；`wmic` 在新版 Windows 上已经没了）
// ---------------------------------------------------------------------------
function listProcesses() {
  // ★ 存活时间由 **PowerShell 那边**算成秒数再交过来，不要交 `CreationDate`。
  //   第 23 轮实测的坑：`ConvertTo-Json` 序列化 DateTime 的形状**不稳定**
  //   （有的是 `\/Date(1789117500006)\/`，有的解析不出来），
  //   我在 node 这边按 `/Date(ms)/` 解析 ⇒ 存活时间变成 null ⇒ 被当成「刚起的」跳过
  //   ⇒ 工具报「没有残留」，而探针 python 明明活着（PID 22748，已存活 15 分钟）。
  //   **判据要放在不会变形的层上**：DateTime 只在 PowerShell 里是 DateTime。
  const ps = [
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
    '$p = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,'
      + '@{n=\'AgeS\';e={ if ($_.CreationDate) { [int]((Get-Date) - [datetime]$_.CreationDate).TotalSeconds } else { $null } }},'
      + 'CommandLine',
    'ConvertTo-Json -InputObject @($p) -Depth 3 -Compress',
  ].join('; ');
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20,
  });
  const j = JSON.parse(raw.trim());
  return (Array.isArray(j) ? j : [j]).filter((x) => x && x.ProcessId);
}

/** 是不是 WorkBuddy 桌面端自己的进程。
 *
 * ⚠️ 这里原来是 `/WorkBuddy/i.test(cmd)`，**太宽了**：我们自己用的托管 node
 *    装在 `C:\Users\<local-user>\.workbuddy\binaries\node\`，路径里就带 `.workbuddy`，
 *    于是那条孤儿服务被护栏放行、整个检测被静默关掉（实测：报「没有发现残留」
 *    而 PID 4092 正在 `--port=8792` 上 LISTENING）。
 *    ⇒ 护栏必须**窄**，窄到只认桌面端本体；而且不能放在循环开头一票否决。
 */
function isWorkBuddyApp(p) {
  const name = String(p.Name || '');
  const cmd = String(p.CommandLine || '');
  if (/^WorkBuddy(\.exe)?$/i.test(name)) return true;
  return /Programs[\\/]WorkBuddy[\\/]/i.test(cmd) || /app\.asar/i.test(cmd);
}

function portOf(cmd) {
  const m = /--port=(\d+)/.exec(cmd || '');
  return m ? Number(m[1]) : null;
}

/** 是不是 playwright 拉起的驱动 node。**不能靠名字判** —— 它也叫 `node.exe`。 */
function isPlaywrightDriver(cmd) {
  return /playwright[\\/]driver[\\/]node\.exe/i.test(cmd || '');
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------
const procs = listProcesses();
const findings = [];
const skipped = [];
/** 当前活着的 PID 集合 —— 用来判「驱动 node 的父进程还在不在」。 */
const livePids = new Set(procs.map((p) => p.ProcessId));

// ★ 先自证「这次真的看见了进程表」。
//   判据不响（读不到命令行、进程数为 0）和「没有残留」在屏幕上一模一样 ——
//   这一条就是用来把两者分开的。上一轮正是栽在这里：报了「没有发现残留」，
//   而 PID 4092 正在 8792 上 LISTENING。
const withCmd = procs.filter((p) => p.CommandLine).length;
if (procs.length < 20 || withCmd === 0) {
  line(`  ❌ 进程表没读到（进程 ${procs.length} 个，有命令行 ${withCmd} 个）。`);
  line('     这次**什么也没测到**，不能当成「没有残留」——先查 CIM/PowerShell 是否可用。');
  process.exit(1);
}

for (const p of procs) {
  const cmd = p.CommandLine || '';
  const ageS = typeof p.AgeS === 'number' ? p.AgeS : null;

  // 护栏放在**判定之前但分支之内**，不做一票否决（见 isWorkBuddyApp 的注释）
  if (isWorkBuddyApp(p)) continue;

  // ② 孤儿服务
  if (/server[\\/]server\.mjs/i.test(cmd)) {
    const port = portOf(cmd);
    if (port === MAIN_PORT) continue;                       // 硬保护
    if (port !== null && port >= CHECK_PORTS.lo && port <= CHECK_PORTS.hi) {
      findings.push({ kind: '孤儿服务', pid: p.ProcessId, port, ageS, why: `--port=${port} 在检查端口段` });
    }
    continue;
  }

  // ③ 探针 / 检查脚本的 python
  if (/python/i.test(p.Name || '') && /tools[\\/](probe|check)-[\w.-]*\.py/i.test(cmd)) {
    if (ageS === null) {
      // ★ 读不到存活时间时**不许沉默**。不杀（它可能是刚起的），但必须报出来 ——
      //   否则「判据读不到」和「没有这东西」在屏幕上是同一句话（第 23 轮栽过）。
      skipped.push({ pid: p.ProcessId, why: '存活时间读不到（不杀，只报）' });
      continue;
    }
    if (ageS < OLDER_THAN) {
      skipped.push({ pid: p.ProcessId, why: `存活 ${ageS}s < ${OLDER_THAN}s（刚起的，不动）` });
      continue;
    }
    findings.push({ kind: '陈旧的探针', pid: p.ProcessId, port: null, ageS,
      why: `存活 ${ageS}s > ${OLDER_THAN}s` });
    continue;
  }

  // ④ 孤儿的 playwright 驱动 node
  //    判据用「**父进程已经不在进程表里**」，不是存活时间：
  //      父还在跑 ⇒ 这次探针是正常的，别动它（哪怕它已经跑了半小时）；
  //      父没了   ⇒ 它就是个没人认领的孤儿（`os._exit()` 跳过了清理）。
  if (isPlaywrightDriver(cmd)) {
    const ppid = p.ParentProcessId;
    if (ppid && livePids.has(ppid)) continue;              // 父还在 ⇒ 正常
    if (ageS !== null && ageS < DRIVER_GRACE) {
      skipped.push({ pid: p.ProcessId,
        why: `孤儿驱动（父已不在）但只存活 ${ageS}s < 宽限 ${DRIVER_GRACE}s` });
      continue;
    }
    findings.push({ kind: '孤儿驱动', pid: p.ProcessId, port: null, ageS,
      why: `playwright 驱动 node，父进程（PID ${ppid ?? '?'}）已退出` });
  }
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------
line('='.repeat(74));
line('  残留进程清理' + (APPLY ? '（--apply 真收工）' : '（只列不动手）'));
line('='.repeat(74));
line(`  仓库根  ${ROOT}`);
line(`  保护端口 ${MAIN_PORT}（日常服务，永不碰）`);
line(`  检查端口段 ${CHECK_PORTS.lo}–${CHECK_PORTS.hi}`);
line(`  陈旧门槛 ${OLDER_THAN}s`);
line(`  本次扫描 ${procs.length} 个进程，其中 ${withCmd} 个能读到命令行`);
line('-'.repeat(74));

if (!findings.length) {
  line('  ✓ 没有发现残留。');
} else {
  for (const f of findings) {
    const age = f.ageS === null ? '   ?  ' : String(f.ageS).padStart(5) + 's';
    line(`  [${f.kind}] PID ${String(f.pid).padStart(7)}  存活 ${age}   ${f.why}`);
  }
  line('-'.repeat(74));
  line(`  合计 ${findings.length} 个。子树（playwright 驱动 node 等）会一并收掉。`);
}

// 近失（读不到存活时间 / 刚起的）单独列出来 —— 静默跳过是这类工具最容易烂掉的地方
if (skipped.length) {
  if (findings.length) line('');
  line(`  （跳过 ${skipped.length} 个，只是让你看见它们存在）`);
  for (const s of skipped) line(`     PID ${String(s.pid).padStart(7)}  ${s.why}`);
}

if (!findings.length) {
  line('='.repeat(74));
  process.exit(0);
}

if (!APPLY) {
  line('');
  line('  确认无误后加 --apply 真收工：');
  line('    node tools/clean-strays.mjs --apply');
  line('='.repeat(74));
  process.exit(1);
}

line('');
let failed = 0;
for (const f of findings) {
  let ok = true;
  try {
    execFileSync('taskkill', ['/PID', String(f.pid), '/T', '/F'], {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    // taskkill 对「已经退出」的 PID 返回非零 —— 那是好事，不当失败
    const msg = String((e && (e.stdout || e.stderr)) || e.message || '');
    if (!/not found|没有找到/i.test(msg)) { ok = false; failed++; }
  }
  // ⚠️ **不回显 taskkill 的文字**：它的输出是 **OEM 代码页**（中文机 = GBK），
  //    而 `execFileSync` 按 utf8 解 ⇒ 屏幕上是一片乱码（坑 112 的同一条病）。
  //    那段文字也**不承载信息** —— 真判据是下面那次「收工后复查进程表」。
  line(`  PID ${String(f.pid).padStart(7)}  ${ok ? '已发终止信号' : 'taskkill 报错（看复查结果）'}`);
}

// 收工后复查 —— 不看一眼就报成功，是假绿的开始
const again = listProcesses().map((p) => p.ProcessId);
const left = findings.filter((f) => again.includes(f.pid));
line('');
if (left.length) {
  line(`  ❌ 还有 ${left.length} 个没收掉：${left.map((f) => f.pid).join(', ')}`);
  line('='.repeat(74));
  process.exit(1);
}
line('  ✓ 已全部收掉（复查过进程表）。');
line('='.repeat(74));
process.exit(0);
