#!/usr/bin/env node
/**
 * 迁移：把**工作区文件夹**从旧项目名改成产品名（更名遗留：旧名与新名两个常量就在下面几行）。
 *
 * 为什么单独写一个工具、还要人关掉 WorkBuddy 再双击一次 —— 见 `坑与雷点.md` 坑 21。
 * 这个文件夹同时是**四样东西**：
 *   ① 源码根；
 *   ② WorkBuddy 的**工作区根** —— 会话转录按路径 slug 存在 `~/.workbuddy/projects/<slug>/`；
 *   ③ `~/.workbuddy/workbuddy.db` → `sessions.cwd` —— **持久会话索引**，软件靠它决定
 *      「这个会话属于哪个工作区」。指向的目录不存在 ⇒ 打开会话直接报
 *      `4011 Conversation workspace does not exist or was removed`。
 *   ④ `~/.workbuddy/sessions/*.json` 里**跑着的进程**的 `cwd`（心跳，临时态）。
 *
 * 只改 ① 的话，② 那个目录会变成**孤儿**（点进去一片空白，坑 19）；③ 不同步则是 **4011**。
 * 所以四样必须**一起搬**，而且**顺序有讲究** —— 先搬 WorkBuddy 那一侧，**最后**才动文件夹本身，
 * 因为文件夹一改名，脚本自己脚下的路就没了。
 *
 * ⚠️ **③ 曾是本工具的真账**（2026-09-11 晚修）：第一版把 ④ 的 `sessions/*.json` 当成了
 *    「会话索引」，改了个热闹 —— 而它只是心跳文件，进程一退就没人看。
 *    而真正决定「会话能不能打开」的 ③ 一次都没碰过。后果：`--selftest` **20/20 全绿**，
 *    文件夹改名也「成功」，然后所有指着它的会话**全部变成 4011**。
 *    教训同 坑 84/85：**判据全绿只证明它测过的那些东西没问题；它没测的那一半，绿得毫无意义。**
 *
 * ⚠️ 两个硬性前提（脚本会自己查，不满足就拒绝执行）：
 *   1. **WorkBuddy 已经关掉**。它还开着的时候，这个文件夹是它的 cwd，
 *      Windows 不允许改一个正在被用的进程当 cwd 的目录 ⇒ 会中途失败，留下半搬状态。
 *   2. **本脚本的 cwd 不在这个文件夹里**（桌面上的 `改名到小小宇宙.bat` 会把它复制到 `%TEMP%` 再跑，
 *      就是为了同时满足这两条 —— 顺便让 cmd.exe 对那个 .bat 的文件句柄也留在文件夹外面）。
 *
 * 用法
 *   node tools/migrate-workspace-rename.mjs                 预演：只打印计划，一个字节都不动
 *   node tools/migrate-workspace-rename.mjs --apply         真的执行
 *   node tools/migrate-workspace-rename.mjs --from <dir>    指定要改的文件夹（默认 = 本文件的上一级）
 *   node tools/migrate-workspace-rename.mjs --home <dir>    换一个「家目录」（自检用，同时进入沙箱模式：
 *                                                           不查进程、不碰桌面快捷方式）
 *   node tools/migrate-workspace-rename.mjs --force         跳过「WorkBuddy 没关」这道闸（危险）
 *   node tools/migrate-workspace-rename.mjs --selftest      在临时沙箱里真跑一遍，含故障注入
 *
 * 退出码：0 = 成功（或预演无阻碍）；1 = 有任何一步 ✗。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OLD_NAME = '小小太阳系';   // 更名遗留：本工具**必须**知道旧名，否则无从匹配（有意保留）
const NEW_NAME = '小小宇宙';

/* ── 参数 ─────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const A = { apply: false, force: false, selftest: false, from: null, home: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') A.apply = true;
    else if (a === '--dry') A.apply = false;
    else if (a === '--force') A.force = true;
    else if (a === '--selftest') A.selftest = true;
    else if (a === '--from') A.from = argv[++i];
    else if (a.startsWith('--from=')) A.from = a.slice('--from='.length);
    else if (a === '--home') A.home = argv[++i];
    else if (a.startsWith('--home=')) A.home = a.slice('--home='.length);
    else if (a === '-h' || a === '--help') A.help = true;
  }
  return A;
}
const ARGS = parseArgs(process.argv.slice(2));

/* ── 环境 ─────────────────────────────────────────────────────────── */

/**
 * ⚠️ 家目录必须**按次传入**，不能做成模块级常量。
 * 第一版我把它写成 `const HOME = ARGS.home ? … : os.homedir()`，于是 `--selftest` 里
 * 五个用例**全都指着真的 `C:\Users\<local-user>\.workbuddy`** —— 沙箱只沙住了「桌面」那一半。
 * 那次没出事纯属侥幸：真家目录那条路径上，「WorkBuddy 还在跑」这道闸把每个用例都拦下来了。
 * **自检借用了真实资源，而拦住它的是另一条检查** —— 这不是设计，是运气。
 * 现在改成每次 `migrate()` 显式收一份 env，谁也别想偷偷用全局。
 */
function realEnv() {
  const home = os.homedir();
  return { home, wb: path.join(home, '.workbuddy'), sandbox: false };
}
/** 沙箱：家目录是假的 ⇒ 进程表、桌面快捷方式都不碰。 */
function sandboxEnv(home) {
  return { home, wb: path.join(home, '.workbuddy'), sandbox: true };
}

/**
 * WorkBuddy 的转录目录 slug。口径来自 坑 20 的实测：
 * 去掉冒号、`\` → `-`、**只把盘符转小写**（路径其余部分大小写保留）。
 *
 * ⚠️ 第一版我写成 `.toLowerCase()` 整串转小写 —— Windows 路径大小写不敏感，
 * 在**这台机器上**恰好也对（用户目录叫 `Users`、桌面叫 `Desktop`）。
 * 所以它不会报错，只会在别人的机器上悄悄找不到目录。刀口要收窄到盘符那一个字符。
 */
function slugOf(abs) {
  return abs
    .replace(/^([A-Za-z]):[\\/]/, (_, d) => `${d.toLowerCase()}-`)
    .replace(/[\\/]/g, '-');
}

/* ── 报告 ─────────────────────────────────────────────────────────── */

let FAILS = 0;
const ok = (label, detail = '') => console.log(`  ✓ ${label}${detail ? `   ${detail}` : ''}`);
const bad = (label, detail = '') => {
  FAILS++;
  console.log(`  ✗ ${label}${detail ? `   ${detail}` : ''}`);
};
const skip = (label, why = '') => console.log(`  – ${label}${why ? `   ${why}` : ''}`);
const step = (n, t) => console.log(`\n[${n}] ${t}`);

/* ── 计划 ─────────────────────────────────────────────────────────── */

function makePlan(from, env) {
  const to = path.join(path.dirname(from), NEW_NAME);
  return {
    env,
    home: env.home,
    from,
    to,
    desk: env.sandbox ? '' : path.join(env.home, 'Desktop'),
    slugFrom: slugOf(from),
    slugTo: slugOf(to),
    projOld: path.join(env.wb, 'projects', slugOf(from)),
    projNew: path.join(env.wb, 'projects', slugOf(to)),
    sessions: path.join(env.wb, 'sessions'),
  };
}

function printPlan(p) {
  console.log('=== 迁移计划 ===');
  console.log(`  家目录          ${p.home}${p.env.sandbox ? '   （沙箱）' : ''}`);
  console.log(`  文件夹          ${p.from}`);
  console.log(`              →   ${p.to}`);
  console.log(`  转录目录        ${p.projOld}`);
  console.log(`              →   ${p.projNew}`);
  console.log(`  进程心跳        ${p.sessions}  （临时态，只改 cwd 指向本文件夹的那些）`);
  console.log(`  持久索引        ${path.join(p.env.wb, 'workbuddy.db')} → sessions.cwd ← 决定会话能不能打开`);
  console.log(`  快捷方式        ${p.env.sandbox ? '（沙箱模式跳过）' : path.join(p.desk, NEW_NAME + '.lnk')}`);
}

/* ── 前置检查 ─────────────────────────────────────────────────────── */

/** WorkBuddy 是否还在跑。判据看**操作系统**，不看文件锁 —— 文件锁在 Windows 上要等到最后一步才暴露。 */
function workBuddyRunning() {
  try {
    const out = execFileSync('tasklist', ['/fo', 'csv', '/nh'], {
      encoding: 'binary', windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    });
    return /workbuddy/i.test(Buffer.from(out, 'binary').toString('latin1'));
  } catch {
    return null;   // 查不到 ≠ 没在跑。null 表示「不知道」，由调用方决定怎么处置
  }
}

function preflight(p) {
  step(0, '前置检查');
  let fatal = 0;

  if (!fs.existsSync(p.from)) { bad('待改的文件夹存在', p.from); fatal++; }
  else ok('待改的文件夹存在', p.from);

  if (fs.existsSync(p.to)) { bad('目标名没被占用', `${p.to} 已经存在 —— 先处理它`); fatal++; }
  else ok('目标名没被占用', p.to);

  // cwd 在文件夹里 = Windows 一定会拒绝改名。这不是「可能」，所以直接判死。
  const cwd = process.cwd();
  if (cwd.toLowerCase().startsWith(p.from.toLowerCase() + path.sep.toLowerCase()) ||
      cwd.toLowerCase() === p.from.toLowerCase()) {
    bad('本脚本的 cwd 在文件夹之外', `当前 cwd = ${cwd}`);
    console.log('     处置：桌面上的 `改名到小小宇宙.bat` 会把自己和脚本都搬到 %TEMP% 再跑。');
    fatal++;
  } else ok('本脚本的 cwd 在文件夹之外', cwd);

  if (p.projNew && fs.existsSync(p.projNew)) {
    console.log(`  ! 注意：目标转录目录已经存在（${p.projNew}），会做**合并**而不是改名。`);
  }

  if (!p.env.sandbox) {
    const run = workBuddyRunning();
    if (run === true && !ARGS.force) {
      bad('WorkBuddy 已关闭', '它还在跑 —— 这个文件夹是它的 cwd，改到一半会失败');
      fatal++;
    } else if (run === true) {
      console.log('  ! --force：WorkBuddy 还在跑，跳过这道闸。**后果自负**。');
    } else if (run === null) {
      skip('WorkBuddy 进程检查', 'tasklist 没查出来 —— 不把它当成绿灯，也不当成红灯');
    } else ok('WorkBuddy 已关闭');
  } else skip('WorkBuddy 进程检查', '沙箱模式');

  return fatal === 0;
}

/* ── 各步骤 ───────────────────────────────────────────────────────── */

/** 备份**进程心跳目录**。**先备份再动**，这是 1 个目录几十个小文件，代价可以忽略。 */
function backupSessions(p, doIt) {
  step(1, '备份进程心跳文件');
  if (!fs.existsSync(p.sessions)) { skip('会话索引目录', '不存在'); return null; }
  const n0 = fs.readdirSync(p.sessions).length;
  if (!doIt) { skip('备份', `预演不写盘（真跑时会先备份这 ${n0} 项）`); return null; }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dst = `${p.sessions}.bak-${stamp}`;
  fs.cpSync(p.sessions, dst, { recursive: true });
  const n = fs.readdirSync(dst).length;
  const m = fs.readdirSync(p.sessions).length;
  if (n !== m) bad('备份条数对得上', `${m} → ${n}`);
  else ok('备份完成', `${dst}  (${n} 项，与源一致)`);
  return dst;
}

/**
 * 改**心跳文件**里的 `cwd`（`~/.workbuddy/sessions/*.json`）。
 *
 * ⚠️ 它不是「会话索引」，是**跑着的进程**写的心跳 —— 进程一退就过期，没人会读。
 *    真正的持久索引是 `workbuddy.db` → `sessions` 表，见下面的 `rewriteDbCwd()`。
 *    （第一版正是把这里叫成了「会话索引」，于是「改索引」这一步改了个寂寞。）
 * ⚠️ 只改**真的等于** from 的那些 —— 不认识的取值一律不碰，
 *    否则「顺手全量替换」会把别的项目的会话也一起改坏。
 */
function rewriteSessions(p, doIt) {
  step(2, '改后台进程心跳里的 cwd（临时态）');
  if (!fs.existsSync(p.sessions)) { skip('会话索引', '目录不存在'); return { hit: 0, total: 0 }; }
  const files = fs.readdirSync(p.sessions).filter((f) => f.endsWith('.json'));
  let hit = 0, other = 0, wrote = 0, skipped = 0;
  for (const f of files) {
    const abs = path.join(p.sessions, f);
    let j;
    try { j = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { skipped++; continue; }
    if (typeof j?.cwd !== 'string') { skipped++; continue; }
    const same = j.cwd.replace(/[\\/]+$/, '').toLowerCase() === p.from.replace(/[\\/]+$/, '').toLowerCase();
    if (!same) { other++; continue; }
    hit++;
    if (doIt) {
      j.cwd = j.cwd.replace(p.from, p.to);
      fs.writeFileSync(abs, JSON.stringify(j, null, 2));
      wrote++;
    }
  }
  // 「跳过」也要说出来。静默 continue 就是「我不知道」被我当成「没问题」（坑 67 的同族）。
  console.log(`     扫了 ${files.length} 个索引：${hit} 个指向本次要改的文件夹，`
    + `${other} 个指向别处（不碰），${skipped} 个读不出 cwd（跳过）`);
  if (!doIt) return { hit, total: files.length, wrote };

  // 读回核对 —— 写盘返回值不算证据
  let still = 0;
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(p.sessions, f), 'utf8'));
      if (typeof j?.cwd === 'string' && j.cwd.toLowerCase().startsWith(p.from.toLowerCase())) still++;
    } catch { /* 坏文件不参与核对 */ }
  }
  if (wrote !== hit) bad('改的条数 = 该改的条数', `该改 ${hit}，实写 ${wrote}`);
  else if (still !== 0) bad('读回核对：没有残留旧路径', `还有 ${still} 个`);
  else ok('会话索引已改并读回核对', `该改 ${hit}，实写 ${wrote}，残留 ${still}`);
  return { hit, total: files.length, wrote, still };
}

/** 只认**真的相等**的路径（去尾斜杠 + 大小写不敏感）—— 不认识的取值一律不碰。 */
function samePath(a, b) {
  return String(a).replace(/[\\/]+$/, '').toLowerCase()
    === String(b).replace(/[\\/]+$/, '').toLowerCase();
}

/**
 * 改**持久会话索引**：`workbuddy.db` → `sessions.cwd`。← 决定「会话能不能打开」的那一份
 *
 * 为什么它必须独立成一步：软件打开会话时会先校验 `cwd` 指向的目录**还在不在**，
 * 不在就直接拒（`4011 Conversation workspace does not exist or was removed`）——
 * **转录搬得再准也没用，门在这一步就被关上了。**
 *
 * 读库用 Node 内置 `node:sqlite`（≥ 22.5；Node 22 会打一条 ExperimentalWarning，无害）。
 * 拿不到就**明确降级、绝不假装成功**：
 *   · 库文件不存在  → skip（这台机器还没建过索引）
 *   · 库/表读不出来 → 报 ❌，并让 `migrate()` **就此停手**（文件夹保持原名，免得搬完打不开）
 * 改完**读回核对** —— 写盘返回值不算证据。
 */
async function rewriteDbCwd(p, doIt) {
  step(3, '改持久会话索引 workbuddy.db 的 sessions.cwd');
  const dbPath = path.join(p.env.wb, 'workbuddy.db');
  if (!fs.existsSync(dbPath)) {
    skip('会话数据库', `不存在 ${dbPath}（这台机器还没建过索引）`);
    return { hit: 0, wrote: 0, still: 0, degraded: false };
  }

  let DatabaseSync = null;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* 落到降级分支 */ }
  if (!DatabaseSync) {
    bad('node:sqlite 可用', `当前 Node ${process.version} 不带 node:sqlite（需要 ≥ 22.5）`);
    console.log('     处置：换一个够新的 node（项目自带 runtime/node.exe 或 ≥24）再跑一遍。');
    return { hit: 0, wrote: 0, still: 0, degraded: true };
  }

  if (!doIt) {
    let db;
    try { db = new DatabaseSync(dbPath, { readOnly: true }); }
    catch (e) { bad('会话数据库可读', e.message); return { hit: 0, wrote: 0, still: 0, degraded: true }; }
    let n = 0;
    try {
      for (const r of db.prepare('SELECT cwd FROM sessions').all()) {
        if (typeof r.cwd === 'string' && samePath(r.cwd, p.from)) n++;
      }
    } catch (e) { db.close(); bad('读取 sessions 表', e.message); return { hit: 0, wrote: 0, still: 0, degraded: true }; }
    db.close();
    console.log(`     预演：有 ${n} 条会话的 cwd 指向本文件夹，会被改到 ${p.to}`);
    return { hit: n, wrote: 0, still: 0, degraded: false };
  }

  // 动手前先备份（WorkBuddy 已关，没有并发写，复制三件套就是完整快照）
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const bak = `${dbPath}.bak-${stamp}`;
  try {
    fs.copyFileSync(dbPath, bak);
    for (const sfx of ['-wal', '-shm']) {
      if (fs.existsSync(dbPath + sfx)) fs.copyFileSync(dbPath + sfx, bak + sfx);
    }
    ok('数据库已在动手前备份', `${bak}  (${fs.statSync(dbPath).size} bytes)`);
  } catch (e) { bad('数据库备份', e.message); return { hit: 0, wrote: 0, still: 0, degraded: true }; }

  let db;
  try { db = new DatabaseSync(dbPath); }
  catch (e) {
    bad('打开会话数据库', e.message);
    console.log('     处置：确认 WorkBuddy 真的退干净了（它是唯一会占着这个库的进程）。');
    return { hit: 0, wrote: 0, still: 0, degraded: true };
  }
  db.exec('PRAGMA busy_timeout = 8000');

  let hit = 0, wrote = 0, other = 0;
  try {
    const rows = db.prepare('SELECT id, cwd FROM sessions').all();
    for (const r of rows) {
      if (typeof r.cwd !== 'string') continue;
      if (!samePath(r.cwd, p.from)) { other++; continue; }
      hit++;
      db.prepare('UPDATE sessions SET cwd = ? WHERE id = ?').run(p.to, r.id);
      wrote++;
    }
  } catch (e) { db.close(); bad('改 sessions.cwd', e.message); return { hit, wrote, still: -1, degraded: true }; }

  // 读回核对 —— 写盘返回值不算证据
  let still = 0;
  try {
    for (const r of db.prepare('SELECT cwd FROM sessions').all()) {
      if (typeof r.cwd === 'string' && samePath(r.cwd, p.from)) still++;
    }
  } catch { still = -1; }
  db.close();

  console.log(`     扫了 ${hit + other} 条会话：${hit} 条指向本文件夹，${other} 条指向别处（不碰）`);
  if (wrote !== hit) bad('改的条数 = 该改的条数', `该改 ${hit}，实写 ${wrote}`);
  else if (still !== 0) bad('读回核对：库里没有残留旧路径', `还有 ${still} 条`);
  else ok('会话数据库已改并读回核对', `该改 ${hit}，实写 ${wrote}，残留 ${still}`);
  return { hit, wrote, still, degraded: false };
}

/** 搬转录目录。 */
function moveTranscriptDir(p, doIt) {
  step(4, '搬 WorkBuddy 转录目录');
  const exists = fs.existsSync(p.projOld);
  console.log(`     ${p.projOld}  ${exists ? '（存在）' : '（不存在）'}`);
  if (!exists) { skip('转录目录', '没有——这台机器上没为旧路径存过转录'); return false; }
  const n = fs.readdirSync(p.projOld).length;
  if (!doIt) { console.log(`     预演：会把 ${n} 项搬到 ${p.projNew}`); return true; }
  const dstExisted = fs.existsSync(p.projNew);
  if (dstExisted) {
    // 合并而不是覆盖：目标已存在时逐项搬，同名的不动（避免把已有的转录删掉）
    for (const e of fs.readdirSync(p.projOld)) {
      const s = path.join(p.projOld, e), d = path.join(p.projNew, e);
      if (!fs.existsSync(d)) fs.renameSync(s, d);
    }
    fs.rmSync(p.projOld, { recursive: true, force: true });
  } else {
    fs.renameSync(p.projOld, p.projNew);
  }
  if (!fs.existsSync(p.projNew) || fs.existsSync(p.projOld)) bad('转录目录已搬到新 slug', p.projNew);
  else ok('转录目录已搬到新 slug', `${n} 项${dstExisted ? '（并入已有目录）' : ''}`);
  return true;
}

/** 改文件夹本身。**必须最后做** —— 做完之后 `p.from` 里的任何路径都不再存在。 */
function renameWorkspaceDir(p, doIt) {
  step(5, '改文件夹名（最后一步）');
  if (!doIt) { console.log(`     预演：${p.from}\n         → ${p.to}`); return; }
  fs.renameSync(p.from, p.to);
  const a = fs.existsSync(p.to), b = fs.existsSync(p.from);
  if (!a || b) bad('文件夹已改名', `新=${a} 旧仍在=${b}`);
  else ok('文件夹已改名', p.to);
}

/** 重装桌面快捷方式：它的 IDList 里存着**文件夹名**，不改名之后必然指向空气（坑 29）。 */
function reinstallShortcut(p, doIt) {
  step(6, '重装桌面快捷方式');
  if (p.env.sandbox) { skip('快捷方式', '沙箱模式'); return; }
  // ⚠️ 预演时 `p.to` **还不存在**（它要等第 4 步才出现）——
  //    所以存在性检查必须看 `p.from`。第一版照抄了 p.to，于是在预演里报
  //    「找不到 install-shortcut.mjs」，一个**根本不会发生的故障**。
  //    预演报假故障 = 教人不信预演。
  const tool = path.join(doIt ? p.to : p.from, 'tools', 'install-shortcut.mjs');
  if (!fs.existsSync(tool)) { skip('快捷方式', `找不到 ${tool}`); return; }
  if (!doIt) { console.log(`     预演：node ${tool}`); return; }
  const node = process.execPath;
  try {
    const out = execFileSync(node, [tool], { cwd: p.to, encoding: 'utf8', windowsHide: true });
    ok('快捷方式已重建', out.split(/\r?\n/).filter(Boolean).slice(-1)[0] || '');
  } catch (e) {
    bad('快捷方式已重建', String(e.stdout || e.message).split(/\r?\n/).filter(Boolean).slice(-1)[0] || '');
    return;
  }
  try {
    execFileSync(node, [tool, '--check'], { cwd: p.to, encoding: 'utf8', windowsHide: true });
    ok('快捷方式自校验通过', '四个路径都指得着');
  } catch (e) {
    bad('快捷方式自校验', String(e.stdout || e.message).trim().split(/\r?\n/).slice(-3).join(' / '));
  }
}

/** 收尾复核：四样东西都在新名下。 */
async function finalCheck(p, res) {
  step(7, '复核');
  if (fs.existsSync(p.to)) ok('文件夹在新名下', p.to); else bad('文件夹在新名下', p.to);
  if (!p.env.sandbox) {
    if (fs.existsSync(p.projNew) || !fs.existsSync(p.projOld)) ok('转录目录不在旧 slug 下', p.projNew);
    else bad('转录目录不在旧 slug 下', p.projNew);
  }
  console.log(`     进程心跳：该改 ${res.sess.hit} 个，实写 ${res.sess.wrote ?? 0} 个，残留 ${res.sess.still ?? '—'}`);
  console.log(`     持久索引：该改 ${res.db.hit} 条，实写 ${res.db.wrote} 条，残留 ${res.db.still}`);

  // 复核决定「会话能不能打开」的那一份。**重开一次库**读，不复用刚才的返回值。
  const dbPath = path.join(p.env.wb, 'workbuddy.db');
  if (fs.existsSync(dbPath) && !res.db.degraded) {
    let still = null;
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(dbPath, { readOnly: true });
      still = 0;
      for (const r of db.prepare('SELECT cwd FROM sessions').all()) {
        if (typeof r.cwd === 'string' && samePath(r.cwd, p.from)) still++;
      }
      db.close();
    } catch { still = null; }
    if (still === null) skip('持久索引复核', '库读不回来，跳过');
    else if (still === 0) ok('持久索引里已无指向旧路径的会话', '重开库读过一遍');
    else bad('持久索引里已无指向旧路径的会话', `还有 ${still} 条`);
  }
}

/* ── 主流程 ───────────────────────────────────────────────────────── */

async function migrate(from, doIt, env) {
  FAILS = 0;
  const p = makePlan(from, env);
  printPlan(p);
  if (!preflight(p)) {
    console.log('\n>>> 前置检查没过，**一个字节都没动**。');
    return 1;
  }
  backupSessions(p, doIt);
  const sess = rewriteSessions(p, doIt);
  const db = await rewriteDbCwd(p, doIt);

  // ⛔ 持久索引没改成 ⇒ 文件夹一改名，所有指着它的会话立刻全变 4011。
  //    所以在这里**必须停手**：此时文件夹还是原名、库还是原值，状态自洽、可重来。
  if (doIt && db.degraded) {
    console.log('\n>>> 持久索引没改成，**就此停手** —— 文件夹名一个字节都没动。');
    console.log('    按上面那条 ❌ 的处置修好（多半是 WorkBuddy 没退干净、或 node 太老），再跑一次。');
    console.log('    若文件夹**已经被手动改过名**（本次就是这种情况），改用：');
    console.log(`      node tools/fix-workspace-cwd.mjs --apply`);
    return 1;
  }

  moveTranscriptDir(p, doIt);
  renameWorkspaceDir(p, doIt);
  reinstallShortcut(p, doIt);
  const res = { sess, db };
  if (doIt) await finalCheck(p, res);

  console.log('\n' + '='.repeat(52));
  if (!doIt) {
    console.log('预演结束：一切就绪。加 --apply 才真的执行。');
    return FAILS ? 1 : 0;
  }
  if (FAILS) {
    console.log(`有 ${FAILS} 步 ✗ —— 看上面的清单。`);
    console.log(`  进程心跳备份：${p.sessions}.bak-*`);
    console.log(`  数据库备份  ：${path.join(p.env.wb, 'workbuddy.db')}.bak-*`);
    return 1;
  }
  console.log('完成。重开 WorkBuddy 即可，它会按新文件夹名找回全部会话记录。');
  return 0;
}

/* ── 自检：临时沙箱里真跑一遍 + 故障注入 ──────────────────────────── */

async function selftest() {
  console.log('=== 自检：沙箱里真跑一遍 ===\n');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-rename-'));
  let pass = 0, fail = 0, skipped = 0;

  // 造沙箱用的假库需要 node:sqlite。拿不到就**跳过**相关用例 —— 不许把它们算成通过。
  let DatabaseSync = null;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch { console.log('  ! 本机 Node 不带 node:sqlite：与数据库有关的用例一律**跳过**，不计入通过数。\n'); }
  const S = (label, why) => { skipped++; console.log(`  – ${label}   ${why}`); };
  const T = (cond, label, detail = '') => {
    if (cond) { pass++; console.log(`  ✓ ${label}`); }
    else { fail++; console.log(`  ✗ ${label}${detail ? '   ' + detail : ''}`); }
  };

  /**
   * 造一个假「家目录」：桌面 + `.workbuddy/{projects,sessions,workbuddy.db}`。
   * `dbMode`：`normal` 带 sessions 表的库 ／ `missing` 不建库 ／ `broken` 建一个没有表的空库。
   */
  const mkHome = (tag, dbMode = 'normal') => {
    const h = path.join(root, tag);
    const ws = path.join(h, 'Desktop', OLD_NAME);
    fs.mkdirSync(path.join(ws, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'tools', 'install-shortcut.mjs'), '// marker\n');
    const slug = slugOf(ws);
    fs.mkdirSync(path.join(h, '.workbuddy', 'projects', slug), { recursive: true });
    fs.writeFileSync(path.join(h, '.workbuddy', 'projects', slug, 't.jsonl'), '{}\n');
    const sd = path.join(h, '.workbuddy', 'sessions');
    fs.mkdirSync(sd, { recursive: true });
    const put = (f, cwd) => fs.writeFileSync(path.join(sd, f), JSON.stringify({ pid: 1, cwd, sessionId: f }, null, 2));
    put('a.json', ws);                                     // 该改
    put('b.json', ws);                                     // 该改
    put('c.json', path.join(h, 'Desktop', '别的项目'));      // **不该碰**
    fs.writeFileSync(path.join(sd, 'd.json'), '{ 坏 json'); // 坏文件：不许让整件事崩掉

    // 持久索引 `workbuddy.db` —— 决定「会话能不能打开」的那一份
    const dbPath = path.join(h, '.workbuddy', 'workbuddy.db');
    const otherCwd = path.join(h, 'Desktop', '别的项目');
    if (dbMode !== 'missing' && DatabaseSync) {
      const db = new DatabaseSync(dbPath);
      if (dbMode === 'normal') {
        db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, title TEXT)');
        const ins = db.prepare('INSERT INTO sessions (id, cwd, title) VALUES (?, ?, ?)');
        ins.run('s1', ws, '该改 1');
        ins.run('s2', ws, '该改 2');
        ins.run('s3', otherCwd, '**不该碰**');
      }
      db.close();
    }
    return { home: h, ws, slug, dbPath, otherCwd, env: sandboxEnv(h) };
  };

  /** 独立新连接读库里的 cwd 映射 —— 不复用被它自己改过程的返回值。 */
  const readDb = (dbPath) => {
    if (!DatabaseSync || !fs.existsSync(dbPath)) return null;
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const m = {};
      for (const r of db.prepare('SELECT id, cwd FROM sessions').all()) m[r.id] = r.cwd;
      db.close();
      return m;
    } catch { return null; }
  };
  const dbBaks = (home) => fs.readdirSync(path.join(home, '.workbuddy')).filter((n) => n.startsWith('workbuddy.db.bak-'));

  // ── 用例 1：正常路径 ──
  console.log('[用例 1] 正常路径');
  {
    const { home, ws, dbPath, otherCwd, env } = mkHome('ok');
    const before = readCwd(path.join(home, '.workbuddy', 'sessions'), 'c.json');
    const rc = await migrate(ws, true, env);
    const to = path.join(home, 'Desktop', NEW_NAME);
    T(rc === 0, '退出码 0', `实际 ${rc}`);
    T(fs.existsSync(to) && !fs.existsSync(ws), '文件夹改名成功且旧名已不在');
    T(fs.existsSync(path.join(home, '.workbuddy', 'projects', slugOf(to))), '转录目录搬到了新 slug');
    const a = readCwd(path.join(home, '.workbuddy', 'sessions'), 'a.json');
    const b = readCwd(path.join(home, '.workbuddy', 'sessions'), 'b.json');
    T(a === to && b === to, '两个该改的心跳都指向新路径', `${a} / ${b}`);
    const c = readCwd(path.join(home, '.workbuddy', 'sessions'), 'c.json');
    T(c === before, '**不该碰的心跳一个字节都没动**（这是「别顺手全量替换」的注入）');
    T(fs.existsSync(path.join(home, '.workbuddy', 'sessions', 'd.json')), '坏 json 没让流程崩掉');
    const baks = fs.readdirSync(path.join(home, '.workbuddy')).filter((n) => n.startsWith('sessions.bak-'));
    T(baks.length === 1, '动手之前留下了备份', baks.join(',') || '一个都没有');
    // 反查：备份里那 4 个索引必须还在（证明备份是**动手前**的快照，不是动手后的）
    T(baks.length === 1 && fs.readdirSync(path.join(home, '.workbuddy', baks[0])).length === 4,
      '备份是动手前的快照（4 个索引都在）');

    // ★ 持久索引 —— 正是「20/20 全绿、会话照样 4011」漏掉的那半张网
    const m = readDb(dbPath);
    if (!m) S('持久索引已改到新路径', '本机没有 node:sqlite');
    else {
      T(m.s1 === to && m.s2 === to, '**持久索引 workbuddy.db 的 cwd 都指向新路径**', `${m.s1} / ${m.s2}`);
      T(m.s3 === otherCwd, '**库里不属于本文件夹的会话没被改**', String(m.s3));
      T(dbBaks(home).length === 1, '数据库也在动手前留了备份', dbBaks(home).join(',') || '一个都没有');
    }
  }

  // ── 用例 2：注入「目标名已存在」→ 必须拒绝，且**一个字节都没动** ──
  console.log('\n[用例 2] 故障注入：目标文件夹已存在');
  {
    const { home, ws, dbPath, env } = mkHome('clash');
    const to = path.join(home, 'Desktop', NEW_NAME);
    fs.mkdirSync(to, { recursive: true });
    fs.writeFileSync(path.join(to, '先来的.txt'), 'x');
    const cwdBefore = readCwd(path.join(home, '.workbuddy', 'sessions'), 'a.json');
    const rc = await migrate(ws, true, env);
    T(rc === 1, '退出码 1（拒绝执行）', `实际 ${rc}`);
    T(fs.existsSync(ws), '旧文件夹还在（没搬一半）');
    T(fs.readFileSync(path.join(to, '先来的.txt'), 'utf8') === 'x', '目标目录里的东西没被覆盖');
    T(readCwd(path.join(home, '.workbuddy', 'sessions'), 'a.json') === cwdBefore, '心跳没被改');
    const m = readDb(dbPath);
    T(m === null || m.s1 === ws, '**库也没被改**（拒绝时不留下半成品）', m ? String(m.s1) : '（无库）');
  }

  // ── 用例 3：注入「待改的文件夹不存在」→ 拒绝 ──
  console.log('\n[用例 3] 故障注入：待改的文件夹不存在');
  {
    const { home, env } = mkHome('missing');
    const rc = await migrate(path.join(home, 'Desktop', '根本不存在'), true, env);
    T(rc === 1, '退出码 1（拒绝执行）', `实际 ${rc}`);
  }

  // ── 用例 4：预演不许动盘 ──
  console.log('\n[用例 4] 预演（--dry）不许改任何东西');
  {
    const { home, ws, dbPath, env } = mkHome('dry');
    const cwdBefore = readCwd(path.join(home, '.workbuddy', 'sessions'), 'a.json');
    const rc = await migrate(ws, false, env);
    T(rc === 0, '退出码 0', `实际 ${rc}`);
    T(fs.existsSync(ws) && !fs.existsSync(path.join(home, 'Desktop', NEW_NAME)), '文件夹没动');
    T(readCwd(path.join(home, '.workbuddy', 'sessions'), 'a.json') === cwdBefore, '心跳没动');
    T(fs.existsSync(path.join(home, '.workbuddy', 'projects', slugOf(ws))), '转录目录没动');
    const m = readDb(dbPath);
    T(m === null || m.s1 === ws, '库里没动', m ? String(m.s1) : '（无库）');
    T(dbBaks(home).length === 0, '预演连数据库备份都不留', dbBaks(home).join(','));
    // 「一个字节都不动」是一句**可证伪的断言** —— 连备份目录都不许留。
    // 第一版就栽在这儿：备份在 step 1 无条件执行，预演也在盘上留了一个 sessions.bak-*。
    const leftovers = fs.readdirSync(path.join(home, '.workbuddy')).filter((n) => n.startsWith('sessions.bak-'));
    T(leftovers.length === 0, '预演连备份目录都不留（否则「一个字节都不动」是假话）', leftovers.join(','));
  }

  // ── 用例 5：slug 口径本身（判据自己先证明会算对） ──
  console.log('\n[用例 5] slug 口径');
  {
    const s = slugOf('C:\\Users\\<local-user>\\Desktop\\' + OLD_NAME);   // 测试向量
    T(s === 'c-Users-<local-user>-Desktop-' + OLD_NAME, '盘符小写、其余大小写保留', s);
    T(slugOf('D:\\a\\b') === 'd-a-b', '换盘符也对', slugOf('D:\\a\\b'));   // 测试向量
  }

  // ── 用例 6：库读不出来 ⇒ **必须停手**，不许把文件夹搬成「所有会话都打不开」 ──
  console.log('\n[用例 6] 故障注入：库在、但没有 sessions 表');
  {
    const { home, ws, env } = mkHome('broken', 'broken');
    const rc = await migrate(ws, true, env);
    T(rc === 1, '退出码 1（停手）', `实际 ${rc}`);
    T(fs.existsSync(ws) && !fs.existsSync(path.join(home, 'Desktop', NEW_NAME)),
      '**文件夹保持原名** —— 没搬成一个「会话全打不开」的状态');
    T(fs.existsSync(path.join(home, '.workbuddy', 'projects', slugOf(ws))), '转录目录也没动');
  }

  // ── 用例 7：这台机器压根没建过库 ⇒ 跳过，不算故障 ──
  console.log('\n[用例 7] 没有 workbuddy.db 的机器：跳过，不该报错');
  {
    const { home, ws, dbPath, env } = mkHome('nodb', 'missing');
    const rc = await migrate(ws, true, env);
    T(rc === 0, '退出码 0（不因为「库不存在」而失败）', `实际 ${rc}`);
    T(fs.existsSync(path.join(home, 'Desktop', NEW_NAME)), '改名照常完成');
    T(!fs.existsSync(dbPath), '没有凭空造出一个数据库');
  }

  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 沙箱残留无害 */ }
  console.log(`\n=== 自检：${pass} 通过 / ${fail} 失败${skipped ? ` / ${skipped} 跳过` : ''} ===`);
  if (skipped) console.log('    （跳过 = 本机跑不了这一项，它们**没有**被算进通过数）');
  return fail ? 1 : 0;
}

function readCwd(dir, file) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')).cwd; } catch { return null; }
}

/* ── 入口 ─────────────────────────────────────────────────────────── */

if (ARGS.help) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').trim());
  process.exit(0);
}
if (ARGS.selftest) process.exit(await selftest());

const FROM = ARGS.from ? path.resolve(ARGS.from) : path.resolve(HERE, '..');
// `--home` 存在的意义只有一个：让沙箱用例能指向一个假家目录。给了它就按沙箱走。
const ENV = ARGS.home ? sandboxEnv(path.resolve(ARGS.home)) : realEnv();
process.exit(await migrate(FROM, ARGS.apply, ENV));
