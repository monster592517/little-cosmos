#!/usr/bin/env node
/**
 * 服务端端到端检查：自己拉起服务 → 打接口 → 收工关掉。
 *
 * 为什么不用「先手动开服务、再跑 smoke-test」：那种流程在自动化里会漏掉一半——
 * 忘了开服务就一片红，忘了关就留个孤儿进程占着端口。脚本自己管生命周期最省事。
 * 顺带一条：它**故意用一个冷门端口**（默认 8793），免得撞上你手动开着的那一个。
 *
 * 用法：node tools/check-server.mjs [--port=8793] [--keep-log]
 * 退出码：0 = 全通过
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number((process.argv.find((a) => a.startsWith('--port=')) || '').slice(7)) || 8793;
const base = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) pass++; else fail++;
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${extra ? ` — ${extra}` : ''}`);
};

const j = async (url, init) => {
  const res = await fetch(base + url, init);
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: text }; }
};

/* ---------- 拉起服务 ---------- */
console.log(`启动服务（端口 ${PORT}）…`);
const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.mjs'), `--port=${PORT}`], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '', stderr = '';
child.stdout.on('data', (d) => { stdout += d; });
child.stderr.on('data', (d) => { stderr += d; });

const stop = () => { try { child.kill('SIGTERM'); } catch { /* ignore */ } };
process.on('exit', stop);

// 等端口就绪：轮询而不是 sleep。固定睡眠在慢机器上会假失败、在快机器上白等。
let ready = false;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`${base}/api/health`);
    if (r.ok) { ready = true; break; }
  } catch { /* 还没起来 */ }
  await new Promise((r) => setTimeout(r, 250));
}
if (!ready) {
  console.error('✗ 服务在 15 秒内没起来。进程输出：\n' + stdout + stderr);
  stop();
  process.exit(1);
}
console.log('服务已就绪。\n');

try {
  /* ---------- /api/health ---------- */
  const h = await j('/api/health');
  ok('GET /api/health', h.status === 200 && h.body.ok === true, `服务名=${h.body.service} v${h.body.version}`);

  /* ---------- /api/logs ---------- */
  const lg = await j('/api/logs?n=50');
  ok('GET /api/logs', lg.status === 200 && lg.body.ok === true, `来源=${lg.body.source} 文件=${lg.body.file} 可写=${lg.body.writable}`);
  ok('日志里已经落下了启动记录', Array.isArray(lg.body.records) && lg.body.records.some((r) => r.msg === '服务已启动'),
    `共 ${lg.body.records?.length || 0} 条`);
  ok('日志记录结构完整', (lg.body.records || []).every((r) => r.t && r.level && r.scope && r.msg), 't/level/scope/msg 四字段');

  /* ---------- /api/selfcheck ---------- */
  const sc = await j('/api/selfcheck');
  ok('GET /api/selfcheck', sc.status === 200 && typeof sc.body.ok === 'boolean',
    `${sc.body.summary?.ok} 通过 / ${sc.body.summary?.warn} 注意 / ${sc.body.summary?.error} 故障，${sc.body.elapsedMs} ms`);
  ok('自检每一条都给了 fix', (sc.body.checks || []).every((c) => typeof c.fix === 'string' && c.fix.length > 0),
    `${sc.body.checks?.length || 0} 项检查`);
  ok('自检分组齐全', (sc.body.groups || []).length >= 5, `分组：${(sc.body.groups || []).map((g) => g.label).join('、')}`);
  ok('在线自检能识别真实端口', (sc.body.checks || []).some((c) => {
    if (c.id !== 'svc.port') return false;
    return `${c.title} ${c.detail}`.includes(String(PORT));
  }), (sc.body.checks || []).find((c) => c.id === 'svc.port')?.title);

  /* ---------- 静态资源与 404 语义 ---------- */
  const idx = await fetch(`${base}/`);
  ok('GET / 返回页面', idx.status === 200 && (await idx.text()).includes('<html'), `content-type=${idx.headers.get('content-type')}`);
  const miss = await j('/textures/__不存在的贴图__.jpg');
  ok('缺失的静态资源老实报 404', miss.status === 404, '不会退化成 HTML，避免静默故障');
  const spa = await fetch(`${base}/some/deep/route`);
  ok('未知页面路径回退到 SPA', spa.status === 200 && (await spa.text()).includes('<html'));

  /* ---------- 路径穿越防护 ---------- */
  const esc = await j('/data/../../package.json');
  ok('路径穿越被拦', esc.status === 403 || esc.status === 404, `status=${esc.status}`);

  /* ---------- 日志文件真的落盘了 ---------- */
  const recs = (await j('/api/logs?n=200')).body.records || [];
  const badReq = recs.filter((r) => r.msg === '静态资源缺失');
  ok('404 事件被记进日志', badReq.length >= 1, `${badReq.length} 条，带 path=${JSON.stringify(badReq[0]?.data?.path || '')}`);

  /* ---------- 有没有把错误悄悄吞掉 ---------- */
  ok('没有未处理异常', !stderr.includes('uncaughtException') && !stderr.includes('UnhandledPromiseRejection'),
    stderr.split('\n').filter((l) => /Error|error/.test(l)).slice(0, 2).join(' | ') || '干净');
} finally {
  stop();
  await new Promise((r) => setTimeout(r, 300));
}

console.log(`\n${fail ? '✗' : '✓'} 通过 ${pass} 项${fail ? `，失败 ${fail} 项` : '，全部通过'}`);
process.exit(fail ? 1 : 0);
