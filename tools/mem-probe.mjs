#!/usr/bin/env node
// 内存探针 —— 「内存压力太大了」这类反馈的第一步：先分清是谁在吃。
//
// 为什么要先分清：同一个症状（系统内存吃紧）至少有两种完全不同的病 ——
//   ① 本程序自己的进程/页面在吃；② 宿主（WorkBuddy 进程树）在吃。
//   拿错病去开药，会把「没参与的东西」当成病灶改一遍，而真凶照旧。
//   所以本工具只做一件事：把工作集按进程名列出来，让归因有依据。
//
// 用法：
//   node tools/mem-probe.mjs              看系统水位 + 按进程名聚合
//   node tools/mem-probe.mjs --top=25     多列几个进程
//   node tools/mem-probe.mjs --json       给别的脚本吃
//
// ⚠️ 读的是 Windows 的 working set（任务管理器里的「内存」列）。
//    「已提交/提交上限」另算 —— 提交量贴顶时进程会直接分不到内存而崩，
//    这在 working set 上看不出来，所以两栏都打。

import { execFileSync } from 'node:child_process';
import os from 'node:os';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const topN = Number((argv.find((a) => a.startsWith('--top=')) || '').split('=')[1]) || 18;

const MB = 1024 * 1024;

// ── 系统水位 ────────────────────────────────────────────────
const totalMB = os.totalmem() / MB;
const freeMB = os.freemem() / MB;
const usedMB = totalMB - freeMB;

// 提交量（Windows 专有）：用 Get-Counter 拿不到就退化成「拿不到」，
// 不许编一个数出来 —— 编出来的数会被当成判据。
function committed() {
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      '$c=(Get-CimInstance Win32_OperatingSystem); ' +
      '"{0} {1}" -f $c.TotalVirtualMemorySize, $c.FreeVirtualMemory',
    ], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    const [t, f] = out.trim().split(/\s+/).map(Number);
    if (!Number.isFinite(t) || !Number.isFinite(f)) return null;
    return { limitMB: t / 1024, freeMB: f / 1024 };
  } catch { return null; }
}

// ── 按进程名聚合工作集 ──────────────────────────────────────
// tasklist 的输出是 OEM 代码页（中文机 = GBK），进程名基本是 ASCII，聚合仍然可靠。
function processes() {
  let raw;
  try {
    raw = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], {
      encoding: 'latin1', timeout: 20000, maxBuffer: 32 * MB, windowsHide: true,
    });
  } catch (e) { return null; }

  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^"([^"]+)","(\d+)","[^"]*","\d+","([\d,]+) K"/);
    if (!m) continue;
    rows.push({ name: m[1], pid: Number(m[2]), wsMB: Number(m[3].replace(/,/g, '')) / 1024 });
  }
  return rows;
}

const rows = processes();
const committedInfo = committed();

if (asJson) {
  const agg = {};
  for (const r of rows || []) {
    agg[r.name] ??= { count: 0, wsMB: 0 };
    agg[r.name].count++;
    agg[r.name].wsMB += r.wsMB;
  }
  console.log(JSON.stringify({
    os: { totalMB, usedMB, freeMB },
    committed: committedInfo,
    byName: Object.entries(agg).map(([name, v]) => ({ name, ...v, wsMB: +v.wsMB.toFixed(1) }))
      .sort((a, b) => b.wsMB - a.wsMB),
    processes: (rows || []).sort((a, b) => b.wsMB - a.wsMB).slice(0, topN),
  }, null, 2));
  process.exit(0);
}

const bar = (v, max, w = 28) => '█'.repeat(Math.max(0, Math.round((v / max) * w)));

console.log('');
console.log('  小小宇宙 · 内存探针');
console.log('  ' + '─'.repeat(60));
console.log(`  物理内存  ${usedMB.toFixed(0)} / ${totalMB.toFixed(0)} MB 已用 · 可用 ${freeMB.toFixed(0)} MB`
  + `  ${(usedMB / totalMB * 100).toFixed(1)}%`);
if (committedInfo) {
  console.log(`  提交量    ${(committedInfo.limitMB - committedInfo.freeMB).toFixed(0)} / `
    + `${committedInfo.limitMB.toFixed(0)} MB  · 余量 ${committedInfo.freeMB.toFixed(0)} MB`
    + `  ${((committedInfo.limitMB - committedInfo.freeMB) / committedInfo.limitMB * 100).toFixed(1)}%`);
} else {
  console.log('  提交量    读不到（powershell/CIM 不可用）—— 不编数');
}

if (!rows) {
  console.log('\n  tasklist 不可用，进程表拿不到。');
  process.exit(1);
}

console.log('');
console.log('  按进程名聚合（working set，任务管理器「内存」列）');
console.log('  ' + '─'.repeat(60));
const agg = new Map();
for (const r of rows) {
  const a = agg.get(r.name) || { count: 0, wsMB: 0 };
  a.count++; a.wsMB += r.wsMB;
  agg.set(r.name, a);
}
const list = [...agg.entries()].sort((a, b) => b[1].wsMB - a[1].wsMB).slice(0, topN);
const maxWs = list[0]?.[1].wsMB || 1;
for (const [name, v] of list) {
  console.log(`  ${name.padEnd(26)} ${String(v.count).padStart(3)} 个  `
    + `${v.wsMB.toFixed(0).padStart(6)} MB  ${bar(v.wsMB, maxWs)}`);
}
const sum = [...agg.values()].reduce((a, v) => a + v.wsMB, 0);
console.log('  ' + '─'.repeat(60));
console.log(`  进程总数 ${rows.length} · 合计 ${sum.toFixed(0)} MB`);
console.log('');
