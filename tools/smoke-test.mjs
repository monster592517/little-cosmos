#!/usr/bin/env node
/** 接口冒烟测试：node tools/smoke-test.mjs [--port=8787] [--translate] */
const port = (process.argv.find((a) => a.startsWith('--port=')) || '').slice(7) || '8787';
const base = `http://127.0.0.1:${port}`;
const doTranslate = process.argv.includes('--translate');
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? '  ✓' : '  ✗'} ${name}${extra ? ' — ' + extra : ''}`); };

const j = async (url, init) => {
  const res = await fetch(base + url, init);
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: text }; }
};

console.log(`冒烟测试 ${base}`);
const health = await j('/api/health');
ok('GET /api/health', health.status === 200 && health.body.ok === true, `翻译=${health.body.translate} 数据集=${(health.body.datasets || []).join(',')}`);

const search = await j('/api/research/search?q=jupiter%20magnetosphere&limit=6');
const r = search.body;
ok('GET /api/research/search', search.status === 200 && Array.isArray(r.results) && r.results.length > 0,
  `命中 ${r.results?.length} 篇 | 来源 ${JSON.stringify(r.sources)} | 错误 ${JSON.stringify(r.errors)}`);
ok('检索结果字段完整', (r.results || []).every((p) => p.title && p.source && p.url !== undefined), '标题/来源/链接');
ok('检索结果含摘要', (r.results || []).filter((p) => p.abstract).length >= Math.min(3, (r.results || []).length), '摘要非空');

const cn = await j('/api/research/search?q=' + encodeURIComponent('木星 大红斑') + '&limit=4');
ok('中文检索→英文关键词', cn.status === 200 && !!cn.body.englishQuery, `englishQuery="${cn.body.englishQuery}" 命中 ${cn.body.results?.length}`);

const st = await j('/data/stars.json');
ok('GET /data/stars.json', st.status === 200 && Array.isArray(st.body.rows) && st.body.rows.length > 100, `${st.body.rows?.length} 行`);
const ex = await j('/data/exoplanets.json');
ok('GET /data/exoplanets.json', ex.status === 200 && Array.isArray(ex.body.systems), `${ex.body.systems?.length} 个系统`);
const idx = await j('/');
ok('GET / (首页)', idx.status === 200 && String(idx.body).includes('<html'), `${String(idx.body).length} 字节`);

if (doTranslate) {
  const tr = await j('/api/research/translate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ texts: ['We present new JWST observations of volcanic activity on Io.', 'The accretion disk drives relativistic jets.'] }),
  });
  ok('POST /api/research/translate', tr.status === 200 && tr.body.items?.every((t) => typeof t === 'string' && t.length > 0), JSON.stringify(tr.body.items || tr.body));
  const cached = await j('/api/research/translate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ texts: ['We present new JWST observations of volcanic activity on Io.'] }),
  });
  ok('翻译缓存命中（不再计费）', cached.body.items?.[0] === tr.body.items?.[0]);
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
