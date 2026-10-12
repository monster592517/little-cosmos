/**
 * 测量用的临时探针（用完移入隔离区）。
 * 目的：回答「还有多少天体没做进去」—— 分清三类：
 *   A. 数据文件里都没有（抓取阶段就被限额/条件挡掉）
 *   B. 数据文件里有、但没进目录（放置规则挡掉）
 *   C. 进了目录、只是被 CAP 藏起来
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = (r) => path.join(ROOT, r);
globalThis.fetch = async (u) => {
  const p = P(String(u).replace(/^\.?\//, ''));
  if (!fs.existsSync(p)) return { ok: false, status: 404, json: async () => ({}) };
  const txt = fs.readFileSync(p, 'utf8');
  return { ok: true, status: 200, text: async () => txt, json: async () => JSON.parse(txt) };
};

const mod = await import(pathToFileURL(P('web/js/data/dataset.js')).href);
const ds = new mod.Dataset();
await ds.load();
await ds.ready?.();

console.log('=== A. 数据文件层面 ===');
const files = [
  'data/deepsky.json', 'data/deep-sky.json', 'data/compact-objects.json',
  'data/exoplanets.json', 'data/stars.json', 'data/exo-planets.json',
];
for (const f of fs.existsSync(P('data')) ? fs.readdirSync(P('data')) : []) {
  if (!f.endsWith('.json')) continue;
  const st = fs.statSync(P('data/' + f));
  if (st.size < 2000) continue;
  files.push('data/' + f);
}
const seen = new Set();
for (const f of files) {
  if (seen.has(f) || !fs.existsSync(P(f))) continue;
  seen.add(f);
  try {
    const j = JSON.parse(fs.readFileSync(P(f), 'utf8'));
    const arr = Array.isArray(j) ? j : (j.objects || j.records || j.items || j.systems || j.planets || j.stars || j.data || null);
    const meta = j.meta || j.source || '';
    console.log(`${f.padEnd(30)} ${String(fs.statSync(P(f)).size).padStart(9)} B  条数=${arr ? arr.length : '(非数组)'}  meta=${JSON.stringify(meta).slice(0, 150)}`);
  } catch (e) {
    console.log(`${f.padEnd(30)} 解析失败 ${e.message}`);
  }
}

console.log('\n=== B. dataset 装配后的统计 ===');
const keys = Object.keys(ds).filter((k) => !k.startsWith('#'));
const stat = {};
for (const k of keys) {
  const v = ds[k];
  if (typeof v === 'number') stat[k] = v;
  else if (Array.isArray(v)) stat[k + '(len)'] = v.length;
  else if (v instanceof Map) stat[k + '(size)'] = v.size;
}
console.log(JSON.stringify(stat, null, 1));

console.log('\n=== C. 天体按「尺度 × 类型」分布 ===');
const byLT = {};
for (const b of ds.bodies.values()) {
  const k = `${b.level || '?'} | ${b.type || '?'}`;
  byLT[k] = (byLT[k] || 0) + 1;
}
Object.entries(byLT).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k.padEnd(34)} ${v}`));
console.log('  合计', ds.bodies.size);

console.log('\n=== D. 深空表里有 RA/Dec 的有多少、有多少没进目录 ===');
const dj = JSON.parse(fs.readFileSync(P('data/deepsky.json'), 'utf8').replace(/^\uFEFF/, ''));
const objs = dj.objects || dj;
const withPos = objs.filter((o) => Number.isFinite(o.ra) && Number.isFinite(o.dec)).length;
const withDist = objs.filter((o) => o.distMly != null || o.distLy != null).length;
const noDist = objs.filter((o) => o.noDistance).length;
console.log(`  深空表 ${objs.length} 条 · 有 RA/Dec ${withPos} · 有距离 ${withDist} · noDistance ${noDist}`);
console.log(`  样例 ${JSON.stringify(objs[0]).slice(0, 260)}`);
