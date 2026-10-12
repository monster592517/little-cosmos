#!/usr/bin/env node
// -*- coding: utf-8 -*-
/**
 * 把「本机各种编码混着来」的日志转成干净的 UTF-8 文本，再吐成 `<原文件>.txt`。
 *
 * 为什么有这个东西
 * ----------------
 * 本机三套编码同时在用，而且**写法不同结果不同**：
 *   · python 重定向写出来的日志       = UTF-8（无 BOM）
 *   · bash（Git Bash）重定向          = UTF-8
 *   · **PowerShell 5.1 的 `>` / `*>`  = UTF-16LE，而且它会先把子进程的输出
 *     按 `[Console]::OutputEncoding`（中文机 = GBK）解码一次再写** ⇒
 *     子进程吐的中文被 GBK 解得面目全非，前面还挂着 UTF-16 的 BOM。
 *
 * 后果：`Read` 工具直接把这文件判成 **binary**，一句话都看不到；
 * 用 `Get-Content` 看是一屏乱码。上一轮就是这样丢掉了探针的实时输出。
 *
 * 这个脚本按 BOM 猜编码（没有 BOM 再按「字节里一半是 0x00」猜 UTF-16LE），
 * 解出来落到同名 `.txt`。**不删原文件**。
 *
 * 用法
 * ----
 *    node tools/dump-log.mjs shots/_galaxy-probe9.log
 *    node tools/dump-log.mjs shots/_galaxy-probe9.log --tail=40
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const tailArg = args.find((a) => a.startsWith('--tail='));
const TAIL = tailArg ? Number(tailArg.split('=', 2)[1]) : 0;

if (!file) {
  console.error('用法: node tools/dump-log.mjs <文件> [--tail=N]');
  process.exit(2);
}
const abs = path.resolve(file);
const buf = fs.readFileSync(abs);

/** @returns {{enc: string, text: string}} */
function decode(b) {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
    return { enc: 'utf-16le (BOM)', text: b.toString('utf16le', 2) };
  }
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    // UTF-16BE：Node 没有内置，手工翻字节
    const n = b.length - 2;
    const sw = Buffer.alloc(n);
    for (let i = 0; i < n; i += 2) { sw[i] = b[i + 3]; sw[i + 1] = b[i + 2]; }
    return { enc: 'utf-16be (BOM)', text: sw.toString('utf16le') };
  }
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    return { enc: 'utf-8 (BOM)', text: b.toString('utf8', 3) };
  }
  // 无 BOM：ASCII 文本在 UTF-16LE 里每隔一个字节就是 0x00
  let zeros = 0;
  const step = Math.min(b.length, 4000);
  for (let i = 1; i < step; i += 2) if (b[i] === 0) zeros++;
  if (step > 2 && zeros / (step / 2) > 0.6) {
    return { enc: 'utf-16le (猜测：隔字节 0x00)', text: b.toString('utf16le') };
  }
  return { enc: 'utf-8 (默认)', text: b.toString('utf8') };
}

const { enc, text } = decode(buf);
let lines = text.split(/\r?\n/);
const total = lines.length;
if (TAIL > 0) lines = lines.slice(-TAIL);

const outTxt = abs + '.txt';
fs.writeFileSync(outTxt, lines.join('\n'), 'utf8');

console.log(`文件    ${abs}`);
console.log(`字节    ${buf.length}`);
console.log(`判定的编码  ${enc}`);
console.log(`行数    ${total}${TAIL ? `（只写出末尾 ${lines.length} 行）` : ''}`);
console.log(`写出    ${outTxt}`);
