#!/usr/bin/env node
/**
 * 体检 / 修复：**持久会话索引里那些 cwd 指向的工作区目录，还在不在。**
 *
 * 为什么需要它（2026-09-11 晚的 4011 事件）：
 *   WorkBuddy 打开会话时，会先校验 `~/.workbuddy/workbuddy.db` → `sessions.cwd`
 *   指向的目录**是否存在**，不在就直接拒：
 *     `4011 Conversation workspace does not exist or was removed`
 *   而那天的三件事**同时成立、谁也不报错**：
 *     · 全仓库更名干净（`naming.legacy` 绿）
 *     · 桌面文件夹已是新名（`naming.workspace-dir` 绿）
 *     · 迁移工具自检 20/20 全绿（但它改的是**心跳文件**，压根没碰这个库）
 *   三张网都没罩住这一份 —— 又是一次「判据测不到被验证的对象」。
 *
 * 用法
 *   node tools/check-workspace-cwd.mjs                                   体检（只读，默认）
 *   node tools/check-workspace-cwd.mjs --old <旧> --new <新>              预演怎么修
 *   node tools/check-workspace-cwd.mjs --old <旧> --new <新> --apply      真修（备份 + 读回核对）
 *   node tools/check-workspace-cwd.mjs --selftest                        沙箱自检
 *
 * ⚠️ 它**同时**搬转录目录、同步工作区显示名 —— 因为三者是一件事的三个面：
 *   门（db.cwd）、房（转录目录）、门牌（display-names）。只修门，进去还是空的。
 *   顺序上它和 `migrate-workspace-rename.mjs` **不重叠**：
 *     · 还没改名  → 用 `migrate-workspace-rename.mjs`（它还负责改文件夹名）
 *     · 已经改完名、只是会话打不开 → 用本工具（旧路径已不存在，migrate 会拒绝执行）
 *
 * 退出码：0 = 体检无失效 或 预演无阻碍 或 修复成功；1 = 有失效 / 任一步 ✗。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const argOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const APPLY = argv.includes('--apply');
const SELFTEST = argv.includes('--selftest');

const OLD_NAME = '小小太阳系';   // 更名遗留：本工具**必须**知道旧名，否则无从识别「文件夹已改名、索引没跟上」（有意保留）

const norm = (p) => String(p).replace(/[\\/]+$/, '').toLowerCase();
const slugOf = (abs) => String(abs)
  .replace(/^([A-Za-z]):[\\/]/, (_, d) => `${d.toLowerCase()}-`)
  .replace(/[\\/]/g, '-');
const ex = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };

let FAILS = 0;
const ok = (l, d = '') => console.log(`  ✓ ${l}${d ? `   ${d}` : ''}`);
const bad = (l, d = '') => { FAILS++; console.log(`  ✗ ${l}${d ? `   ${d}` : ''}`); };
const skip = (l, w = '') => console.log(`  – ${l}${w ? `   ${w}` : ''}`);

async function loadSqlite() {
  try { return (await import('node:sqlite')).DatabaseSync; } catch { return null; }
}

/** 体检：列出库里每条会话的 cwd 是否还指着存在的目录。 */
async function health(env, DatabaseSync) {
  if (!ex(env.db)) return { dbMissing: true, rows: [] };
  if (!DatabaseSync) return { err: '本机 Node 不带 node:sqlite（需 ≥ 22.5，Node 24 自带）', rows: [] };
  let db;
  try { db = new DatabaseSync(env.db, { readOnly: true }); }
  catch (e) { return { err: e.message, rows: [] }; }
  try {
    const rows = [];
    for (const r of db.prepare('SELECT * FROM sessions').all()) {
      rows.push({ id: r.id, cwd: r.cwd, title: r.title, status: r.status, alive: ex(r.cwd) });
    }
    return { rows };
  } catch (e) { return { err: e.message, rows: [] }; }
  finally { db.close(); }
}

/** 修：把 cwd **严格等于** old 的那些改成 new，同时搬转录目录、改显示名。 */
async function repair(env, oldCwd, newCwd, doIt, DatabaseSync) {
  console.log(`\n修复：${oldCwd}\n  →   ${newCwd}\n`);

  // ── 0. 目标目录必须真的在，否则等于把门开到另一个空房间 ──
  if (!ex(newCwd)) { bad('目标目录存在', `${newCwd} 不存在 —— 先确认新文件夹的真实路径`); return 1; }
  if (norm(oldCwd) === norm(newCwd)) { bad('新旧路径不同', '两边一样，没什么可修'); return 1; }
  ok('目标目录存在', newCwd);

  // ── 1. 备份 ──
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  if (doIt && ex(env.db)) {
    try {
      const bak = `${env.db}.bak-${stamp}`;
      fs.copyFileSync(env.db, bak);
      for (const s of ['-wal', '-shm']) if (ex(env.db + s)) fs.copyFileSync(env.db + s, bak + s);
      ok('数据库已备份', bak);
    } catch (e) { bad('数据库备份', e.message); return 1; }
  } else if (!doIt) skip('备份', '预演不写盘');

  // ── 2. 改库里的 cwd ──
  if (!ex(env.db)) skip('改库', '没有 workbuddy.db');
  else if (!DatabaseSync) { bad('node:sqlite 可用', '本机 Node 太老，换 ≥ 22.5 再跑'); return 1; }
  else if (!doIt) {
    const h = await health(env, DatabaseSync);
    const n = h.rows.filter((r) => r.cwd && norm(r.cwd) === norm(oldCwd)).length;
    console.log(`     预演：库里 ${n} 条会话的 cwd 等于旧路径，会被改到新路径`);
  } else {
    let db;
    try { db = new DatabaseSync(env.db); } catch (e) { bad('打开数据库', e.message); return 1; }
    db.exec('PRAGMA busy_timeout = 8000');
    let hit = 0, other = 0;
    try {
      for (const r of db.prepare('SELECT id, cwd FROM sessions').all()) {
        if (typeof r.cwd !== 'string') continue;
        if (norm(r.cwd) !== norm(oldCwd)) { other++; continue; }
        db.prepare('UPDATE sessions SET cwd = ? WHERE id = ?').run(newCwd, r.id);
        hit++;
      }
    } catch (e) { db.close(); bad('改 sessions.cwd', e.message); return 1; }
    // 读回核对 —— 写盘返回值不算证据
    let still = 0;
    try {
      for (const r of db.prepare('SELECT cwd FROM sessions').all()) {
        if (typeof r.cwd === 'string' && norm(r.cwd) === norm(oldCwd)) still++;
      }
    } catch { still = -1; }
    db.close();
    console.log(`     扫了 ${hit + other} 条：${hit} 条等于旧路径，${other} 条指向别处（不碰）`);
    if (still !== 0) bad('读回核对：库里没有残留旧路径', `还有 ${still} 条`);
    else ok('库里的 cwd 已改并读回核对', `改 ${hit} 条`);
  }

  // ── 3. 搬转录目录（门开了，房里得有东西）──
  const projOld = path.join(env.wb, 'projects', slugOf(oldCwd));
  const projNew = path.join(env.wb, 'projects', slugOf(newCwd));
  if (!ex(projOld)) skip('搬转录目录', `旧 slug 目录不存在 ${projOld}`);
  else if (!doIt) {
    console.log(`     预演：把 ${fs.readdirSync(projOld).length} 项从 ${projOld} 搬到 ${projNew}`);
  } else {
    try {
      fs.mkdirSync(projNew, { recursive: true });
      let moved = 0, kept = 0;
      for (const e of fs.readdirSync(projOld)) {
        const s = path.join(projOld, e), d = path.join(projNew, e);
        if (ex(d)) { kept++; continue; }        // 目标已有同名项：**不覆盖**
        fs.renameSync(s, d);
        moved++;
      }
      const left = fs.readdirSync(projOld).length;
      if (left) bad('转录目录已清空', `${projOld} 还剩 ${left} 项`);
      else ok('转录目录已搬', `搬 ${moved} 项${kept ? `，跳过已存在 ${kept} 项` : ''}`);
      if (left === 0) fs.rmdirSync(projOld);
    } catch (e) { bad('搬转录目录', e.message); }
  }

  // ── 4. 工作区显示名映射里的 path/id ──
  const dn = path.join(env.wb, 'workspace-display-names.json');
  if (!ex(dn)) skip('工作区显示名', '没有该文件');
  else {
    try {
      const j = JSON.parse(fs.readFileSync(dn, 'utf8'));
      const ws = j.workspaces || {};
      const hits = Object.keys(ws).filter((k) => norm(ws[k]?.path || k) === norm(oldCwd));
      if (!doIt) console.log(`     预演：显示名映射里 ${hits.length} 条指向旧路径会改到新路径`);
      else if (!hits.length) ok('工作区显示名无需改', '没有指向旧路径的条目');
      else {
        const rebuilt = {};
        for (const k of Object.keys(ws)) {
          if (hits.includes(k)) {
            const e = ws[k];
            e.path = newCwd;
            e.id = newCwd.replace(/\\/g, '/').toLowerCase();
            e.updatedAt = Date.now();
            rebuilt[newCwd.replace(/\\/g, '/').toLowerCase()] = e;
          } else rebuilt[k] = ws[k];
        }
        j.workspaces = rebuilt;
        fs.writeFileSync(dn, JSON.stringify(j, null, 2), 'utf8');
        ok('工作区显示名已改', hits.join(', ') + ' → ' + newCwd);
      }
    } catch (e) { bad('工作区显示名', e.message); }
  }

  console.log('\n' + '='.repeat(52));
  if (!doIt) { console.log('预演结束。加 --apply 才真的执行。'); return FAILS ? 1 : 0; }
  if (FAILS) { console.log(`有 ${FAILS} 步 ✗ —— 看上面的清单。数据库备份在 ${env.db}.bak-*`); return 1; }
  console.log('完成。重开 WorkBuddy 再打开那个会话。');
  return 0;
}

/* ── 自检：沙箱里真跑一遍 ───────────────────────────────── */

async function selftest() {
  console.log('=== 自检：沙箱里真跑一遍 ===\n');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-'));
  let pass = 0, fail = 0, skipped = 0;
  const T = (c, l, d = '') => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.log(`  ✗ ${l}${d ? '   ' + d : ''}`); } };
  const S = (l, w) => { skipped++; console.log(`  – ${l}   ${w}`); };

  const DatabaseSync = await loadSqlite();
  if (!DatabaseSync) S('全部数据库用例', '本机 Node 不带 node:sqlite');

  const OLD = path.join(root, 'Desktop', OLD_NAME);
  const NEW = path.join(root, 'Desktop', '小小宇宙');
  const mk = (tag, mode = 'normal') => {
    const h = path.join(root, tag);
    const wb = path.join(h, '.workbuddy');
    fs.mkdirSync(wb, { recursive: true });
    fs.mkdirSync(path.join(wb, 'projects', slugOf(OLD)), { recursive: true });
    fs.writeFileSync(path.join(wb, 'projects', slugOf(OLD), 's1.jsonl'), '{}\n');
    fs.writeFileSync(path.join(wb, 'projects', slugOf(OLD), 's1.meta.json'), '{}\n');
    const other = path.join(root, 'Desktop', '别的项目');
    if (mode !== 'missing' && DatabaseSync) {
      const db = new DatabaseSync(path.join(wb, 'workbuddy.db'));
      if (mode === 'normal') {
        db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, status TEXT)');
        const ins = db.prepare('INSERT INTO sessions (id,cwd,title,status) VALUES (?,?,?,?)');
        ins.run('s1', OLD, '打不开的那个', 'error');
        ins.run('s2', OLD, '另一个', 'completed');
        ins.run('s3', other, '**不该碰**', 'completed');
      }
      db.close();
    }
    fs.writeFileSync(path.join(wb, 'workspace-display-names.json'), JSON.stringify({
      version: 1,
      workspaces: { [OLD.replace(/\\/g, '/').toLowerCase()]: { id: OLD.replace(/\\/g, '/').toLowerCase(), path: OLD, displayName: '小小宇宙' } },
    }, null, 2));
    return { env: { home: h, wb, db: path.join(wb, 'workbuddy.db') }, wb };
  };
  const readCwds = (dbPath) => {
    if (!DatabaseSync || !ex(dbPath)) return null;
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const m = {};
      for (const r of db.prepare('SELECT id, cwd FROM sessions').all()) m[r.id] = r.cwd;
      db.close();
      return m;
    } catch { return null; }
  };

  // 目标目录必须存在（真实场景里就是那个改好名的新文件夹）
  console.log('[用例 1] 改名已完成、会话打不开 → 修好');
  {
    fs.mkdirSync(NEW, { recursive: true });
    const { env, wb } = mk('ok');
    const rc = await repair(env, OLD, NEW, true, DatabaseSync);
    T(rc === 0, '退出码 0', `实际 ${rc}`);
    const m = readCwds(env.db);
    if (!m) S('库里的 cwd 已改', '本机没有 node:sqlite');
    else {
      T(m.s1 === NEW && m.s2 === NEW, '**两条都指向新路径**', `${m.s1} / ${m.s2}`);
      T(m.s3 === path.join(root, 'Desktop', '别的项目'), '**别的项目的会话没被碰**', String(m.s3));
    }
    T(fs.existsSync(path.join(wb, 'projects', slugOf(NEW), 's1.jsonl')), '转录搬到了新 slug');
    T(!fs.existsSync(path.join(wb, 'projects', slugOf(OLD))), '旧 slug 目录已清掉');
    const dn = JSON.parse(fs.readFileSync(path.join(wb, 'workspace-display-names.json'), 'utf8'));
    T(!JSON.stringify(dn).includes(OLD_NAME), '显示名映射里没有旧路径了', JSON.stringify(dn).slice(0, 120));
    T(fs.readdirSync(wb).some((n) => n.startsWith('workbuddy.db.bak-')), '数据库留了备份');
  }

  console.log('\n[用例 2] 预演：一个字节都不许动');
  {
    const { env, wb } = mk('dry');
    const before = readCwds(env.db);
    const rc = await repair(env, OLD, NEW, false, DatabaseSync);
    T(rc === 0, '退出码 0', `实际 ${rc}`);
    const after = readCwds(env.db);
    T(JSON.stringify(before) === JSON.stringify(after), '库里没动');
    T(fs.existsSync(path.join(wb, 'projects', slugOf(OLD))), '转录目录没动');
    T(!fs.readdirSync(wb).some((n) => n.startsWith('workbuddy.db.bak-')), '连备份都不留');
  }

  console.log('\n[用例 3] 故障注入：目标目录不存在 → 拒绝（别把门开到空房间）');
  {
    const { env } = mk('notarget');
    const rc = await repair(env, OLD, path.join(root, 'Desktop', '根本不存在'), true, DatabaseSync);
    T(rc === 1, '退出码 1', `实际 ${rc}`);
  }

  console.log('\n[用例 4] 没有 workbuddy.db 的机器 → 体检不崩');
  {
    const { env } = mk('nodb', 'missing');
    const h = await health(env, DatabaseSync);
    T(h.dbMissing === true, '如实报告「库不存在」，而不是抛异常', JSON.stringify(h).slice(0, 80));
  }

  console.log('\n[用例 5] 库在但没有 sessions 表 → 如实报错，不崩');
  {
    const { env } = mk('broken', 'broken');
    const h = await health(env, DatabaseSync);
    T(!h.dbMissing && (h.err || h.rows.length === 0), '报出读不出来的原因', JSON.stringify(h).slice(0, 100));
  }

  console.log('\n[用例 6] slug 口径');
  {
    // 向量取**本机真实家目录**：既测到真实盘符格式，又不在源码里写死盘符绝对路径
    // （写死会踩自检 `prog.no-abs-paths`，而那个检查是对的 —— 写死的路径换台机器就指错地方）。
    const H = os.homedir();
    const s = slugOf(H);
    T(/^[a-z]-/.test(s), '盘符转小写', s);
    T(s === H.replace(/:/g, '').replace(/[\\/]+/g, '-').replace(/^([A-Za-z])/, (m) => m.toLowerCase()),
      '口径 = 去冒号 + 分隔符转横线 + 盘符小写', s);
    const other = H[0].toLowerCase() === 'c' ? 'D' : 'C';
    T(slugOf(`${other}:\\a\\b`) === `${other.toLowerCase()}-a-b`, '换个盘符也对', slugOf(`${other}:\\a\\b`));
  }

  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 沙箱残留无害 */ }
  console.log(`\n=== 自检：${pass} 通过 / ${fail} 失败${skipped ? ` / ${skipped} 跳过` : ''} ===`);
  if (skipped) console.log('    （跳过 = 本机跑不了这一项，它们**没有**被算进通过数）');
  return fail ? 1 : 0;
}

/* ── 入口 ───────────────────────────────────────────────── */

if (SELFTEST) process.exit(await selftest());

const ENV = { home: os.homedir(), wb: path.join(os.homedir(), '.workbuddy'), db: path.join(os.homedir(), '.workbuddy', 'workbuddy.db') };
const DatabaseSync = await loadSqlite();
const OLD_ARG = argOf('--old');
const NEW_ARG = argOf('--new');

if (OLD_ARG && NEW_ARG) {
  process.exit(await repair(ENV, path.resolve(OLD_ARG), path.resolve(NEW_ARG), APPLY, DatabaseSync));
}

console.log('=== 体检：持久会话索引里的工作区目录还在不在 ===');
console.log(`  库：${ENV.db}\n`);
const h = await health(ENV, DatabaseSync);
if (h.dbMissing) { console.log('  – 没有 workbuddy.db：这台机器还没建过会话索引。'); process.exit(0); }
if (h.err) { bad('读取会话数据库', h.err); process.exit(1); }
const dead = h.rows.filter((r) => r.cwd && !r.alive);
if (!h.rows.length) { console.log('  – 库里没有任何会话。'); process.exit(0); }
console.log(`  会话 ${h.rows.length} 条，cwd 失效 ${dead.length} 条\n`);
for (const r of h.rows) {
  console.log(`  ${r.alive ? '✓' : '✗'} ${String(r.id).slice(0, 8)}  ${String(r.title ?? '').slice(0, 34)}`);
  console.log(`      cwd = ${r.cwd}`);
}
console.log('\n' + '='.repeat(52));
if (!dead.length) {
  console.log('结论：所有会话的 cwd 都指着存在的目录，打开会话不会报 4011。');
  process.exit(0);
}
console.log(`结论：${dead.length} 条会话的 cwd 指向已不存在的目录 —— 打开它们会报 4011。`);
console.log('修法（先预演，去掉 --apply 看计划）：');
for (const d of dead) {
  console.log(`  node tools/check-workspace-cwd.mjs --old "${d.cwd}" --new "<改好名后的真实路径>" --apply`);
}
process.exit(1);
