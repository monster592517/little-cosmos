/**
 * 子进程取 stdout —— **不建管道，落到临时文件再读回来**。
 *
 * 为什么不能直接用 `execFileSync(..., { encoding: 'utf8' })`：
 * 那个写法会让 Node 给子进程**建一条管道**，而本机环境**不许给子进程建管道**
 * —— 报 `spawnSync <exe> EBUSY`（errno -4082），连 `process.execPath` 自己都起不来。
 *
 * 2026-09-26 实测（同一台机器、同一份托管 node.exe，12 次一组）：
 *
 *   | 写法                                   | 结果                       |
 *   |---|---|
 *   | `{ encoding: 'utf8' }`（建管道）        | **12/12 EBUSY**            |
 *   | `{ stdio: ['ignore', fd, fd] }`（落文件）| **12/12 正常且能取回输出** |
 *
 * 同一天更早的一组 30/30 观测与之一致（管道 30/30 EBUSY、`stdio:'ignore'` 30/30 正常）。
 * ⇒ 这是**环境约束**，不是脚本写错了；**换机制**才是解法。
 *
 * ⚠️ 三件必须记住的事：
 *   1. **不要用「重试」来盖它**。有无根据的重试已经被本项目撤过一次
 *      （见 `server/lib/selfcheck.mjs` 里 checkPerf 上方那段注释：那次重试是在
 *       给一个不存在的病开药）。EBUSY 是**必然**，不是**偶发** —— 重试只会同样失败。
 *   2. **失败也要把真错带回去**。非零退出时 `execFileSync` 抛异常，而很多工具
 *      （如 `check-refs.mjs`）是「退出码 1 + stdout 一份完整 JSON」——
 *      调用方要能从 `txt` 里抢救出那份 JSON，别一律报成「跑不起来」。
 *      这正是本项目的规矩：**「服务死了」和「数据坏了」不能用同一个错误标记**。
 *   3. 临时文件路径走 `os.tmpdir()`，**不写死本机路径**。
 *
 * 返回 `{ txt, err }`：
 *   · `txt` —— stdout 内容（子进程失败但写出了东西时**照样有**）
 *   · `err` —— 失败时的异常对象（`null` 表示子进程正常退出）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

let seq = 0;

/**
 * @param {string} exe   可执行文件（如 `process.execPath` / `'powershell.exe'`）
 * @param {string[]} args 参数数组
 * @param {object}  [opts] 透传给 `execFileSync` 的选项；`encoding` 会被强制忽略，
 *                         `stdio` 会被本函数接管（调用方不需要也不该设）
 * @returns {{ txt: string, err: Error|null }}
 */
export function runCapture(exe, args, opts = {}) {
  seq += 1;
  const tmp = path.join(os.tmpdir(), `wbcap-${process.pid}-${seq}-${Date.now()}.out`);
  let fd = -1;
  let err = null;
  try {
    fd = fs.openSync(tmp, 'w');
    // ⚠️ stdio 的第 0 位留 'ignore'：子进程**不读** stdin，也不许继承父进程的。
    execFileSync(exe, args, { ...opts, encoding: undefined, stdio: ['ignore', fd, fd] });
  } catch (e) {
    err = e;
  } finally {
    try { if (fd >= 0) fs.closeSync(fd); } catch { /* 关不掉也不能让自检崩 */ }
  }
  let txt = '';
  try { txt = fs.readFileSync(tmp, 'utf8'); } catch { /* 没落盘就是真空 */ }
  try { fs.unlinkSync(tmp); } catch { /* 临时文件删不掉不该升级成故障 */ }
  return { txt, err };
}

/**
 * 拿 `runCapture` 的输出解析最后一行 JSON（很多工具会先打日志、最后一行才是 JSON）。
 * 解析不出来返回 `null`，**不抛** —— 让调用方按自己的分级口径处理。
 */
export function lastJsonLine(txt) {
  const lines = String(txt || '').trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const s = lines[i].trim();
    if (!s.startsWith('{') && !s.startsWith('[')) continue;
    try { return JSON.parse(s); } catch { /* 继续往上找 */ }
  }
  return null;
}

/** 整个 stdout 就是一个 JSON 的情况。解析不出来也返回 `null`。 */
export function wholeJson(txt) {
  const s = String(txt || '').trim();
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * 从 `runCapture` 的返回值里尽量抢救一份 JSON（失败路径优先）。
 * 顺序：正常输出 → 异常自带的 stdout。
 */
export function salvageJson({ txt, err }) {
  let v = wholeJson(txt) ?? lastJsonLine(txt);
  if (v !== null) return v;
  const out = err && err.stdout != null ? Buffer.from(err.stdout).toString('utf8') : '';
  return wholeJson(out) ?? lastJsonLine(out);
}

/** 把异常整理成一句能贴进报告的话（`stderr` 优先，其次 `message`）。 */
export function errText(err) {
  if (!err) return '(无异常信息)';
  const raw = err.stderr || err.message || String(err);
  return String(raw).trim().slice(0, 300);
}
