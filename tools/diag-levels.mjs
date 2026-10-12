/**
 * 诊断：每个尺度层级里到底装了什么。
 * 用 mock fetch 把真实 JSON 喂给 Dataset，然后按 level × type 统计。
 * 不改任何东西，只出报告。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// mock fetch：把 './data/xxx.json' 映射到磁盘
globalThis.fetch = async (url) => {
  const rel = String(url).replace(/^\.\//, '');
  const p = path.join(ROOT, 'data', rel.replace(/^data\//, ''));
  const txt = fs.readFileSync(p, 'utf8');
  return { ok: true, json: async () => JSON.parse(txt) };
};

const { Dataset } = await import(pathToFileURL(path.join(ROOT, 'web/js/data/dataset.js')).href);

const ds = new Dataset();
await ds.load(() => {}, {});

const out = [];
out.push('=== 层级 × 类型 分布 ===');
const byLevel = new Map();
for (const b of ds.bodies.values()) {
  const lv = b.level || '(无)';
  if (!byLevel.has(lv)) byLevel.set(lv, new Map());
  const m = byLevel.get(lv);
  m.set(b.type, (m.get(b.type) || 0) + 1);
}
const ORDER = ['solar', 'neighborhood', 'galaxy', 'localgroup', 'supercluster', 'universe', '(无)'];
for (const lv of ORDER) {
  const m = byLevel.get(lv);
  if (!m) continue;
  const total = [...m.values()].reduce((a, b) => a + b, 0);
  const parts = [...m.entries()].sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${t}:${n}`).join('  ');
  out.push(`\n[${lv}] 共 ${total}`);
  out.push('  ' + parts);
}

out.push('\n\n=== 目录树分组 ===');
const walk = (nodes, depth) => {
  for (const n of nodes) {
    const pad = '  '.repeat(depth);
    if (n.kind === 'group') {
      out.push(`${pad}${n.name}  <${n.id}>`);
      if (n.children) walk(n.children, depth + 1);
    } else {
      out.push(`${pad}· ${n.name}`);
    }
    if (depth >= 3) continue;
  }
};
// 只打印分组层（不打印叶子），避免爆
const pruned = (nodes) => nodes.map((n) => {
  if (n.kind === 'group' && n.children) {
    return { ...n, children: n.children.map((c) => (c.kind === 'group' ? { ...c, children: [] } : c)) };
  }
  return n;
});
walk(pruned(ds.catalog), 0);

/* 尺度分节：面板实际会渲染成什么样（外层尺度包含内层）。
   顺带把「未归入尺度」的顶层分组报出来 —— 非空就是 dataset.js 的 TIER_OF 漏了分组。 */
out.push('\n\n=== 尺度分节（面板实际渲染的结构）===');
const { SCALE_CHAIN } = await import(pathToFileURL(path.join(ROOT, 'web/js/core/scales.js')).href);
const tierOrder = [...SCALE_CHAIN].sort((a, b) => b.order - a.order);
const buckets = new Map(tierOrder.map((s) => [s.id, []]));
const untiered = [];
for (const n of ds.catalog) {
  if (n.tier && buckets.has(n.tier)) buckets.get(n.tier).push(n);
  else untiered.push(n);
}
const leavesOf = (nodes) => nodes.reduce(
  (a, n) => a + ((n.kind === 'body' || n.kind === 'ring') ? 1 : leavesOf(n.children || [])), 0);
for (const s of tierOrder) {
  const list = buckets.get(s.id);
  if (!list.length) continue;
  out.push(`\n[${s.order}] ${s.name}（${s.unit}）  顶层分组 ${list.length} 个 · 叶子 ${leavesOf(list)}`);
  for (const n of list) out.push(`      ${n.name}  <${n.id}>`);
}
out.push(`\n未归入尺度：${untiered.length} 个顶层分组 ${JSON.stringify(ds.catalogUntiered)}`);
if (untiered.length) out.push('  ⚠ 去 dataset.js 的 TIER_OF 补上：' + untiered.map((n) => n.id).join(', '));

out.push('\n\n=== 关键计数 ===');
out.push(`天体总数          ${ds.bodies.size}`);
out.push(`深空天体（OpenNGC） ${ds.deepSky.length}`);
out.push(`  已落点          ${ds.deepSkyPlaced?.length ?? '-'}`);
out.push(`  无距离          ${ds.deepSkyNoDistance}`);
out.push(`  与人工表重复跳过  ${ds.deepSkySkipped}`);
out.push(`致密天体（SIMBAD）  ${ds.compactObjects.length}`);
out.push(`  新增            ${ds.compactAdded}`);
out.push(`  去重跳过        ${ds.compactSkipped}`);
out.push(`恒星（邻近层）      ${ds.stars.length}`);
out.push(`系外行星系统        ${ds.exoplanets.length}`);

// 系外行星：哪些恒星有行星、行星是否作为独立天体进了 bodies
const exoBodies = [...ds.bodies.values()].filter((b) => b.type === 'exoplanet');
out.push(`系外行星（独立天体）${exoBodies.length}`);
const withPlanets = [...ds.bodies.values()].filter((b) => b.hasPlanets);
out.push(`标记 hasPlanets 的恒星 ${withPlanets.length}`);

// deepSky 的 scope 分布
const scopeCount = new Map();
for (const o of ds.deepSky) scopeCount.set(o.scope || '(none)', (scopeCount.get(o.scope || '(none)') || 0) + 1);
out.push(`\ndeepSky scope 分布: ` + [...scopeCount.entries()].map(([k, v]) => `${k}:${v}`).join('  '));

// milkyway 内天体的类型分布（这些本该在 galaxy 层）
const mw = ds.deepSky.filter((o) => o.scope === 'milkyway');
const mwType = new Map();
for (const o of mw) mwType.set(o.type, (mwType.get(o.type) || 0) + 1);
out.push(`scope=milkyway 的类型: ` + [...mwType.entries()].map(([k, v]) => `${k}:${v}`).join('  '));

// 被分到 localgroup 但其实是银河系内的
const lgInMw = [...ds.bodies.values()].filter((b) => b.level === 'localgroup' && b.scope !== 'extragalactic' && (b.distMly != null && b.distMly < 0.5));
out.push(`\n⚠️ 落在 localgroup 但距离<0.5Mly 的天体: ${lgInMw.length}`);
const lgT = new Map();
for (const b of lgInMw) lgT.set(b.type, (lgT.get(b.type) || 0) + 1);
out.push('  类型: ' + [...lgT.entries()].map(([k, v]) => `${k}:${v}`).join('  '));
out.push('  例: ' + lgInMw.slice(0, 8).map((b) => `${b.name}(${b.distMly}Mly)`).join(', '));

fs.writeFileSync(path.join(ROOT, '.trash', '_diag-levels.txt'), out.join('\n'));
console.log('written .trash/_diag-levels.txt');
