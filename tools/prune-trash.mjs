#!/usr/bin/env node
/**
 * 小小宇宙 · 隔离区收纳（`tools/prune-trash.mjs`）
 *
 * 为什么要这个：本项目的删除**一律走隔离区**（永久删除是禁止的），于是 `.trash/` **只进不出**。
 * 而 `tools/package.mjs` 每跑一次会往里丢一份「上一次的暂存目录」，约 130 MB / 658 个文件。
 * 打包四次就是 500 MB —— 全是同一批文件的第 N 份拷贝，磁盘白白被吃掉。
 *
 * 它做什么：
 *   · 只挑 `old-stage-*` 这类**可复现的构建产物**，默认只留最近 1 个；
 *   · 其余的，先把**清单**（相对路径 + 字节数 + mtime）写到 `.trash/_manifests/`，
 *     核对清单条数与目录里的文件数一致之后，才回收字节；
 *   · **其它任何东西都不碰** —— 探针脚本、`.lnk` 备份、报告、诊断残留，全都原样留着。
 *
 * 为什么是「清单」而不是「打包成 zip」：这些暂存目录彼此 99% 相同，
 * 7 份打成 zip 还是 7×56 MB，只省 45%；而它们的字节**本来就能由 `node tools/package.mjs` 重新生成**，
 * 真正值得留的是「里面到底有什么」。换成清单，省 ~100%，且信息一点不丢。
 *
 * 两条安全设计（都来自本项目踩过的坑）：
 *   1. **只操作 `.trash/` 的直接子项**，且只匹配 `old-stage-*`。不递归删别的东西，路径上多一层都不认。
 *   2. **不用 `fs.rm(recursive)`**（坑 28：它在本机可能永久卡死，成因未明）。
 *      改成自己走一遍、逐个 `unlinkSync`，并且**带时间预算**：超时就停下来说清停在哪，
 *      而不是像坑 28 那样「进程活着、什么都不干、也不报错」。逐个删除是幂等的，重跑即可续上。
 *
 * 用法：
 *   node tools/prune-trash.mjs                 # 默认只出计划，不动任何东西（dry-run）
 *   node tools/prune-trash.mjs --apply         # 真做
 *   node tools/prune-trash.mjs --keep=2        # 最近 2 个暂存目录都留着
 *   node tools/prune-trash.mjs --json          # 机器可读
 *
 * 退出码：0 = 正常（含「没什么可收的」）；1 = 出错了。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 坑 14：中文路径下 new URL(import.meta.url).pathname 不解码，必须用 fileURLToPath
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRASH = path.join(ROOT, '.trash');
const MANIFEST_DIR = path.join(TRASH, '_manifests');

/** 只有这些名字才在管辖范围内 —— 可复现的打包暂存目录。 */
const ELIGIBLE = /^old-stage-\d{4}-\d{2}-\d{2}T[\d-]+$/;

/**
 * 本机实测：**删一个文件约 40–60 ms**（临时目录里 64 字节的小文件也一样，`unlinkSync` 与 `rmSync` 无差别）。
 * 正常机器应在 0.1 ms 量级 —— 也就是这台机器慢了约三个数量级。
 * 这条数字很关键：它意味着「删 658 个文件 = 30 秒以上」，
 * 也解释了坑 28（`fs.rm(recursive)` 看起来卡死，其实是**慢 + 没有进度输出**）。
 * 测量脚本：`.trash/probe-unlink-speed.mjs`。
 */
const MS_PER_UNLINK = 50;

/** 逐个删除的时间预算：可用 `--budget=<秒>` 调，默认 900 秒。 */
const BUDGET_S = (() => {
  const hit = process.argv.slice(2).find((a) => a === '--budget' || a.startsWith('--budget='));
  if (!hit) return 900;
  const raw = hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : '';
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 900;
})();
const BUDGET_MS = BUDGET_S * 1000;

const argv = process.argv.slice(2);
const flag = (name, dflt = null) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
};

if (flag('help')) {
  console.log('用法：node tools/prune-trash.mjs [--apply] [--keep=N] [--budget=秒] [--json] [--help]');
  console.log('默认只出计划（dry-run）。加 --apply 才真回收字节。');
  console.log(`--budget 默认 ${BUDGET_S} 秒；本机删一个文件约 ${MS_PER_UNLINK} ms，量大时请调大。`);
  process.exit(0);
}

const APPLY = !!flag('apply');
const AS_JSON = !!flag('json');
const KEEP = Math.max(0, Number.parseInt(flag('keep', '1'), 10) || 0);

/* ============================================================
   量体积
   ============================================================ */

/** 走一遍目录，统计字节数与文件数。只为出报告，不做删除。 */
function measure(dir) {
  let bytes = 0;
  let files = 0;
  const walk = (p) => {
    let ents;
    try { ents = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const q = path.join(p, e.name);
      if (e.isDirectory()) walk(q);
      else {
        files++;
        try { bytes += fs.statSync(q).size; } catch { /* 读不到就不算，不编数字 */ }
      }
    }
  };
  walk(dir);
  return { bytes, files };
}

const mb = (b) => Math.round((b / 1048576) * 10) / 10;

/* ============================================================
   挑出该收的
   ============================================================ */

if (!fs.existsSync(TRASH)) {
  console.log('隔离区还不存在，没什么可收的。');
  process.exit(0);
}

const entries = fs.readdirSync(TRASH, { withFileTypes: true })
  .filter((e) => e.isDirectory() && ELIGIBLE.test(e.name))
  .map((e) => {
    const full = path.join(TRASH, e.name);
    const st = fs.statSync(full);
    const size = measure(full);
    return { name: e.name, full, mtime: st.mtime, ...size };
  })
  // **按名字排序，不按 mtime**：名字里就带着可排序的时间戳（`old-stage-YYYY-MM-DDTHH-MM-SS`），
  // 而 mtime 会被别的事情扰动 —— 实测：上一次被中断的回收（删除文件会更新目录 mtime）
  // 让一个**只剩 115 个文件的残骸**变成了"最新"，于是"保留最近 1 个"留住的是残骸。
  .sort((a, b) => b.name.localeCompare(a.name)); // 最新在前

const keep = entries.slice(0, KEEP);
const drop = entries.slice(KEEP);

const before = measure(TRASH);

/* ============================================================
   出计划
   ============================================================ */

if (!AS_JSON) {
  console.log('');
  console.log('  小小宇宙 · 隔离区收纳' + (APPLY ? '' : '（预演，不动任何东西）'));
  console.log('  ' + '─'.repeat(60));
  console.log(`  隔离区现状：${mb(before.bytes)} MB · ${before.files} 个文件`);
  console.log(`  管辖范围：${entries.length} 个 old-stage-* 目录（其它一律不碰）`);
  console.log('');
  for (const k of keep) console.log(`  留着    ${k.name}   ${mb(k.bytes)} MB · ${k.files} 文件`);
  for (const d of drop) console.log(`  ${APPLY ? '回收' : '待回收'}  ${d.name}   ${mb(d.bytes)} MB · ${d.files} 文件`);
  if (drop.length === 0) console.log('  （最近 ' + KEEP + ' 个都在保留范围内，没什么可收的）');
  if (drop.length) {
    const files = drop.reduce((s, d) => s + d.files, 0);
    console.log(`  合计 ${files} 个文件 · 按 ${MS_PER_UNLINK} ms/个估算约需 ${Math.ceil((files * MS_PER_UNLINK) / 1000)} 秒`);
  }
  console.log('');
}

/* ============================================================
   回收（清单先落、核对过、再动字节）
   ============================================================ */

/** 写清单：相对路径 + 字节数 + mtime。这是这个目录唯一值得长期保留的东西。 */
function writeManifest(entry) {
  const lines = [];
  lines.push(`# 隔离区归档清单 · ${entry.name}`);
  lines.push(`# 归档时间：${new Date().toISOString()}`);
  lines.push(`# 文件数：${entry.files} · 合计 ${mb(entry.bytes)} MB`);
  lines.push('# 说明：这是 tools/package.mjs 每次打包前移进来的「上一次的暂存目录」。');
  lines.push('# 它的字节可由 `node tools/package.mjs` 完全重新生成，所以只保留清单、回收字节。');
  lines.push('# 格式：字节数<TAB>修改时间<TAB>相对路径');
  const walk = (dir, rel) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      const q = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(q, r);
      else {
        let st = null;
        try { st = fs.statSync(q); } catch { /* 忽略 */ }
        lines.push(`${st ? st.size : '?'}\t${st ? st.mtime.toISOString() : '?'}\t${r}`);
      }
    }
  };
  walk(entry.full, '');
  fs.mkdirSync(MANIFEST_DIR, { recursive: true });
  const out = path.join(MANIFEST_DIR, `${entry.name}.txt`);
  fs.writeFileSync(out, lines.join('\n') + '\n', 'utf8');
  return { out, entries: lines.length - 6 };
}

/**
 * 逐个删（**不用 fs.rm(recursive)** —— 坑 28 它会永久卡死）。
 * 返回 { aborted, done, total }；aborted 时调用方会明确说出来，不会装作做完了。
 */
function reclaim(dir, logEvery = 50) {
  const t0 = Date.now();
  const files = [];
  const dirs = [];
  const walk = (p) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const q = path.join(p, e.name);
      if (e.isDirectory()) { dirs.push(q); walk(q); }
      else files.push(q);
    }
  };
  walk(dir);

  let done = 0;
  for (const f of files) {
    try { fs.unlinkSync(f); } catch { /* 已经没了也算过 */ }
    done++;
    // 进度必须打：本机删一个文件要几十毫秒，658 个文件就是半分钟以上，
    // 一声不吭地看着像卡死（坑 28 就是这么被误判成死锁的）。
    if (logEvery && done % logEvery === 0) {
      const pct = Math.round((done / files.length) * 100);
      process.stdout.write(`         … 已回收 ${done}/${files.length}（${pct}%）\n`);
    }
    if (Date.now() - t0 > BUDGET_MS) {
      return { aborted: true, done, total: files.length, elapsedMs: Date.now() - t0 };
    }
  }
  // DFS 前序列表反过来就是「子在前、父在后」⇒ 保证空目录能被 rmdir 掉
  for (const d of dirs.reverse()) { try { fs.rmdirSync(d); } catch { /* 非空就跳过 */ } }
  try { fs.rmdirSync(dir); } catch { /* 同上 */ }
  return { aborted: false, done, total: files.length, elapsedMs: Date.now() - t0 };
}

const report = { dryRun: !APPLY, keep, before: { ...before, mb: mb(before.bytes) }, kept: keep.map((k) => k.name), pruned: [], aborted: [] };

if (APPLY && drop.length) {
  for (const d of drop) {
    const m = writeManifest(d);
    // 核对：清单条数必须等于目录里的文件数。对不上就**不动这个目录**。
    if (m.entries !== d.files) {
      const msg = `清单核对失败（清单 ${m.entries} 条 vs 目录 ${d.files} 个文件），已跳过 ${d.name}`;
      console.error('  ✗ ' + msg);
      report.aborted.push({ name: d.name, reason: msg });
      continue;
    }
    const r = reclaim(d.full);
    if (r.aborted) {
      const msg = `回收超时（${r.done}/${r.total} 个文件，${r.elapsedMs} ms > ${BUDGET_MS} ms），停在 ${d.name}。`
        + `逐个删除是幂等的，重跑即可续上；量大时加 --budget=${Math.max(1800, BUDGET_S * 2)}。`;
      console.error('  ✗ ' + msg);
      report.aborted.push({ name: d.name, reason: msg });
    } else {
      report.pruned.push({ name: d.name, mb: mb(d.bytes), files: d.files, manifest: path.relative(ROOT, m.out) });
    }
  }
}

const after = measure(TRASH);
report.after = { ...after, mb: mb(after.bytes) };
report.reclaimedMB = mb(Math.max(0, before.bytes - after.bytes));

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
} else {
  if (APPLY && drop.length) {
    console.log('');
    console.log(`  清单已落：.trash/_manifests/（${report.pruned.length} 份）`);
    console.log(`  已回收：${report.reclaimedMB} MB`);
    console.log(`  隔离区现在：${report.after.mb} MB · ${report.after.files} 个文件`);
    if (report.aborted.length) console.log(`  ⚠ 有 ${report.aborted.length} 个没做完，见上面的 ✗`);
  } else if (!APPLY && drop.length) {
    const would = mb(drop.reduce((s, d) => s + d.bytes, 0));
    console.log(`  预计可回收 ${would} MB。确认后执行：node tools/prune-trash.mjs --apply`);
  }
  console.log('');
}

process.exitCode = report.aborted.length ? 1 : 0;
