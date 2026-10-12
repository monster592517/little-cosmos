#!/usr/bin/env node
/**
 * 便携包验收：打包完成 ≠ 能用。
 *
 * 上一轮的经验：`tools/package.mjs` 报「完成」，但没人真跑过那个包。
 * 这个脚本就是补那一步——四件事：
 *   1. **结构**：该带的文档都在；不该带的目录（隔离区 / 日志 / 外部工具数据 / node_modules）一个都没进去。
 *   2. **启动**：用**包内自带的** `runtime/node.exe` 起服务（不是系统 Node）——这才是目标机器上的真实路径。
 *   3. **接口**：health / selfcheck / 静态资源 / 404 语义。
 *   4. **收工**：关掉进程，不留孤儿。
 *
 * 用法：node tools/check-package.mjs [--port=8795] [--zip]
 * 退出码：0 = 全通过
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const NAME = '小小宇宙';
const STAGE = path.join(DIST, NAME);
const PORT = Number((process.argv.find((a) => a.startsWith('--port=')) || '').slice(7)) || 8795;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) pass++; else fail++;
  console.log(`${cond ? '  OK  ' : '  FAIL'} ${name}${extra ? ` -- ${extra}` : ''}`);
};

/* ---------- 1. 结构 ---------- */
console.log(`验收 ${path.relative(ROOT, STAGE)}`);
ok('暂存目录存在', existsSync(STAGE));
if (!existsSync(STAGE)) process.exit(1);

const MUST = [
  '启动小小宇宙.bat', '使用说明.txt',
  'README.md', '操作手册.md', '自检维修手册.md', '坑与雷点.md',
  'runtime/node.exe',
  'server/server.mjs', 'server/lib/log.mjs', 'server/lib/selfcheck.mjs',
  // ⚠️ 「跑子进程取 stdout」的唯一实现。selfcheck 与 gpu-preference **都依赖它**，
  //    包里缺了它 ⇒ 自检四条检查一起报「跑不起来」（见 坑与雷点.md 坑 159）。
  'server/lib/run-capture.mjs',
  'web/index.html', 'web/vendor/three/three.module.js', 'web/vendor/astronomy/astronomy.js',
  'tools/selfcheck.mjs',
  'data/sources.json', 'data/stars.json',
];
const missing = MUST.filter((f) => !existsSync(path.join(STAGE, f)));
ok('必需文件齐全', missing.length === 0, missing.length ? `缺 ${missing.join(' / ')}` : `${MUST.length} 项`);

/**
 * 绝不能进包的东西。`.trash` 与 `logs` 尤其重要——
 * 隔离区里有改名前的旧文件和本机运行日志，泄漏出去既臃肿又暴露路径。
 */
const FORBIDDEN = ['.trash', 'logs', '.workbuddy', 'node_modules', 'shots', 'dist'];
const leaked = FORBIDDEN.filter((d) => existsSync(path.join(STAGE, d)));
ok('没有夹带不该带的目录', leaked.length === 0, leaked.length ? `混进了 ${leaked.join(' / ')}` : `排除了 ${FORBIDDEN.join(' / ')}`);

// 贴图与影像必须真的在（页面能开但全是纯色球，也是"打包没打全"）
const nt = existsSync(path.join(STAGE, 'web/textures')) ? readdirSync(path.join(STAGE, 'web/textures')).length : 0;
const ni = existsSync(path.join(STAGE, 'web/images')) ? readdirSync(path.join(STAGE, 'web/images')).length : 0;
ok('贴图已打包', nt >= 80, `${nt} 张`);
ok('真实影像已打包', ni >= 80, `${ni} 张`);

if (process.argv.includes('--zip')) {
  const zip = path.join(DIST, `${NAME}-便携版.zip`);
  const s = existsSync(zip) ? statSync(zip).size / 1048576 : 0;
  ok('zip 已生成', s > 10, `${s.toFixed(1)} MB`);
}

/* ---------- 2~4. 用包内运行时启动 ---------- */
const NODE = path.join(STAGE, 'runtime', 'node.exe');
if (!existsSync(NODE)) {
  console.log('  跳过启动验收：包内没有 runtime/node.exe');
  console.log(`\n${fail ? 'FAIL' : 'OK'} 通过 ${pass} 项${fail ? `，失败 ${fail} 项` : ''}`);
  process.exit(fail ? 1 : 0);
}

const base = `http://127.0.0.1:${PORT}`;
console.log(`\n用包内运行时启动（端口 ${PORT}）…`);
const child = spawn(NODE, [path.join(STAGE, 'server', 'server.mjs'), `--port=${PORT}`], {
  cwd: STAGE, stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '', err = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { err += d; });

const stop = () => {
  // Windows 上 SIGTERM 对子进程不可靠，用任务树强杀，避免留孤儿占端口
  try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); }
  catch { try { child.kill('SIGKILL'); } catch { /* 已经死了 */ } }
};
process.on('exit', stop);

let ready = false;
for (let i = 0; i < 80; i++) {
  try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch { /* 等它起来 */ }
  await new Promise((r) => setTimeout(r, 250));
}

try {
  ok('包内运行时能起服务', ready, ready ? 'health 有响应' : `${out}${err}`.slice(0, 300));

  if (ready) {
    /**
     * 带重试的取数。
     *
     * 本机会偶发 `ECONNRESET`（瞬时 / 环境态）。以前它直接冒泡成**未捕获异常**：
     * 打一堆 stack、退出码 1，而且**中间已经通过的那些项一个字都不汇总** ——
     * 看上去像"这个包坏了"。一次瞬时抖动不该长得像真故障。
     * 只对**连接层**错误重试；服务端真返回了错误码的，照常往下走。
     */
    const getJSON = async (p, attempts = 3) => {
      let last;
      for (let i = 1; i <= attempts; i++) {
        try { return await (await fetch(`${base}${p}`)).json(); } catch (e) {
          last = e;
          if (!/fetch failed|ECONNRESET|ECONNREFUSED|socket hang up|EPIPE/i.test(String(e?.message || e))) throw e;
          await new Promise((r) => setTimeout(r, 200 * i));
        }
      }
      throw last;
    };

    const h = await getJSON('/api/health');
    ok('服务名与版本', h.service === '小小宇宙', `${h.service} v${h.version}，${(h.datasets || []).length} 个数据集`);

    // 日志要真能落盘——目标机器上没有 logs/ 目录，得自己建出来
    const lg = await getJSON('/api/logs?n=20');
    ok('日志随包自建', lg.ok === true, `文件 ${lg.file} 可写=${lg.writable}`);
    ok('日志目录是被现场创建的', existsSync(path.join(STAGE, 'logs')), '首次启动自动 mkdir');

    const sc = await getJSON('/api/selfcheck');
    ok('包内自检能跑', typeof sc.ok === 'boolean',
      `${sc.summary?.ok} 通过 / ${sc.summary?.warn} 注意 / ${sc.summary?.error} 故障，${sc.elapsedMs} ms`);
    // 关键：交付物装好之后不许自己报「故障」。便携版不带 package.json 是正常的，
    // 自检必须把这条判成「注意」并解释清楚，而不是让用户一解压就看到红字。
    ok('包内自检零故障', sc.summary?.error === 0,
      (sc.checks || []).filter((c) => c.level === 'error').map((c) => `${c.id}: ${c.detail}`).join(' | ') || '没有 error 级项');
    const honesty = (sc.checks || []).find((c) => c.id === 'data.registry-honesty');
    ok('包内登记表仍然说实话', honesty?.level === 'ok', honesty?.detail);
    const scripts = (sc.checks || []).find((c) => c.id === 'shell.scripts');
    ok('缺 package.json 只报注意、且解释了为什么不影响使用',
      scripts?.level === 'warn' && /便携版|不影响使用/.test(scripts.detail) && Boolean(scripts.fix),
      `${scripts?.level} · ${scripts?.detail}`);

    const idx = await fetch(`${base}/`);
    ok('页面能打开', idx.status === 200 && (await idx.text()).includes('小小宇宙'));
    const miss = await fetch(`${base}/textures/__no_such__.jpg`);
    ok('缺资源老实 404', miss.status === 404);

    const after = await getJSON('/api/logs?n=5');
    ok('日志记录了启动', (after.records || []).some((r) => r.msg === '服务已启动'));
  }
} catch (e) {
  // 出意外也要把已经攒下的结果汇总出来。
  // 直接让异常冒泡的话，Node 只打一堆 stack、**前面通过的项一个字都不显示**，
  // 于是"某个中间步骤出错"看起来像"整个包都坏了"。
  fail++;
  console.log(`  FAIL  验收中断 -- ${e?.message || e}`);
} finally {
  stop();
  // 顺手把验收过程中在包内生成的 logs/ 删掉，别污染交付物
  await new Promise((r) => setTimeout(r, 400));
  try { rmSync(path.join(STAGE, 'logs'), { recursive: true, force: true }); } catch { /* 没有就算了 */ }
}

console.log(`\n${fail ? 'FAIL' : 'OK'} 通过 ${pass} 项${fail ? `，失败 ${fail} 项` : '，全部通过'}`);
process.exit(fail ? 1 : 0);
