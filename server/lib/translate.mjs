/**
 * 翻译与简报服务 —— 不依赖任何付费 API / API Key
 *
 *  翻译引擎（按顺序尝试，结果全部落盘缓存，重复查看不再联网）：
 *    ① 浏览器内置翻译（Chrome/Edge 的 Translator API，本地模型，完全离线）——在客户端执行；
 *    ② 本文件代理的公共翻译端点（Google 翻译公开接口 → MyMemory 备用），无需密钥；
 *    ③ 都不可用时，前端提供「用浏览器打开原文并整页翻译」的入口。
 *
 *  检索词转换：优先把中文检索词翻成英文（提高 arXiv/OpenAlex 命中率），
 *  翻译不可用时退回内置术语表。
 *
 *  进展简报：不调用大模型，用抽取式摘要（关键词/位置/线索词打分）在本地生成，
 *  每条要点都标注来源论文编号，不编造内容。
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DiskCache } from './cache.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cache = new DiskCache(path.join(ROOT, 'data', '.cache', 'translate.json'), { maxEntries: 8000 });
const keyCache = new DiskCache(path.join(ROOT, 'data', '.cache', 'query-en.json'), { maxEntries: 4000 });

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) little-cosmos/1.0';

const hash = (text) => createHash('sha1').update(text).digest('hex').slice(0, 24);

/** 极简中文天文术语表：翻译不可用时兜底 */
const GLOSSARY = [
  ['太阳', 'sun'], ['水星', 'mercury'], ['金星', 'venus'], ['地球', 'earth'], ['月球', 'moon'],
  ['火星', 'mars'], ['木星', 'jupiter'], ['土星', 'saturn'], ['天王星', 'uranus'], ['海王星', 'neptune'],
  ['冥王星', 'pluto'], ['谷神星', 'ceres'], ['彗星', 'comet'], ['小行星', 'asteroid'],
  ['卫星', 'satellite'], ['木卫二', 'europa'], ['木卫一', 'io'], ['木卫三', 'ganymede'], ['木卫四', 'callisto'],
  ['土卫六', 'titan'], ['土卫二', 'enceladus'], ['海卫一', 'triton'], ['大红斑', 'great red spot'],
  ['磁层', 'magnetosphere'], ['大气', 'atmosphere'], ['海洋', 'ocean'], ['冰壳', 'ice shell'],
  ['轨道', 'orbit'], ['自转', 'rotation'], ['公转', 'revolution'], ['撞击', 'impact'],
  ['火山', 'volcanism'], ['喷流', 'plume'], ['尘埃', 'dust'], ['辐射', 'radiation'],
  ['光谱', 'spectrum'], ['观测', 'observation'], ['模拟', 'simulation'], ['演化', 'evolution'],
  ['形成', 'formation'], ['宜居', 'habitability'], ['生命', 'life'], ['有机分子', 'organic molecules'],
  ['太阳风', 'solar wind'], ['日冕', 'corona'], ['耀斑', 'flare'], ['黑子', 'sunspot'],
  ['引力波', 'gravitational wave'], ['系外行星', 'exoplanet'], ['柯伊伯带', 'kuiper belt'],
  ['小行星带', 'asteroid belt'], ['行星环', 'planetary ring'], ['潮汐加热', 'tidal heating'],
  ['朱诺号', 'juno'], ['旅行者', 'voyager'], ['新视野号', 'new horizons'], ['卡西尼', 'cassini'],
  ['帕克', 'parker'], ['韦布', 'jwst'], ['哈勃', 'hubble'], ['探测', 'exploration'],
  ['最新进展', ''], ['研究', 'research'], ['论文', 'paper'],
];

function glossaryQuery(q) {
  let out = q;
  for (const [zh, en] of GLOSSARY) if (en) out = out.split(zh).join(` ${en} `);
  return out.replace(/[\u4e00-\u9fff]+/g, ' ').replace(/\s+/g, ' ').trim() || q;
}

/* ---------------- 公共翻译端点 ---------------- */

async function fetchText(url, timeout = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally { clearTimeout(timer); }
}

/** Google 公开接口（无密钥） */
async function googleTranslate(text, sl, tl) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx'
    + `&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`;
  const raw = await fetchText(url, 6000);
  const data = JSON.parse(raw);
  const parts = Array.isArray(data?.[0]) ? data[0].map((s) => s?.[0] || '').join('') : '';
  if (!parts.trim()) throw new Error('空结果');
  return parts;
}

/** MyMemory 公开接口（无密钥，按 450 字符切片） */
async function myMemoryTranslate(text, sl, tl) {
  const chunks = [];
  let rest = text;
  while (rest.length) {
    let cut = Math.min(450, rest.length);
    if (cut < rest.length) {
      const sp = rest.lastIndexOf(' ', cut);
      if (sp > 200) cut = sp;
    }
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  const out = [];
  for (const c of chunks) {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(c)}&langpair=${sl}|${tl}`;
    const data = JSON.parse(await fetchText(url, 12000));
    const t = data?.responseData?.translatedText;
    if (!t) throw new Error(data?.responseDetails || '翻译失败');
    out.push(t);
    await new Promise((r) => setTimeout(r, 120));
  }
  return out.join(' ');
}

const LANG = { zh: 'zh-CN', en: 'en' };

async function translateOne(text, target = 'zh', source = 'en') {
  const sl = LANG[source] || source;
  const tl = LANG[target] || target;
  const errors = [];
  for (const engine of [googleTranslate, myMemoryTranslate]) {
    try {
      const out = await engine(text, sl, tl);
      if (out?.trim()) return out.trim();
    } catch (e) { errors.push(e.message); }
  }
  const err = new Error(`翻译服务暂不可用（${errors.join(' / ')}）`);
  err.code = 'NO_ENGINE';
  throw err;
}

/** 批量翻译（磁盘缓存） */
export async function translateBatch(texts, { target = 'zh', source = 'en' } = {}) {
  const out = new Array(texts.length).fill(null);
  const pending = [];
  for (let i = 0; i < texts.length; i++) {
    const text = String(texts[i] ?? '').trim();
    if (!text) { out[i] = ''; continue; }
    const key = `v2:${source}>${target}:${hash(text)}`;
    const hit = await cache.get(key);
    if (hit != null) out[i] = hit;
    else pending.push({ i, text, key });
  }
  let lastErr = null;
  for (const p of pending) {
    try {
      const zh = await translateOne(p.text, target, source);
      out[p.i] = zh;
      cache.set(p.key, zh);
    } catch (e) { lastErr = e; }
  }
  if (pending.length && out.every((v) => v == null) && lastErr) throw lastErr;
  return out;
}

/** 中文检索词 → 英文检索词 */
export async function toEnglishQuery(query) {
  const q = String(query || '').trim();
  if (!q || !/[\u4e00-\u9fff]/.test(q)) return q;
  const key = `q2:${hash(q)}`;
  const hit = await keyCache.get(key);
  if (hit) return hit;
  try {
    const en = (await translateOne(q, 'en', 'zh')).replace(/^["'`]|["'`]$/g, '').replace(/\s+/g, ' ').trim();
    if (en && !/[\u4e00-\u9fff]/.test(en)) { keyCache.set(key, en); return en; }
  } catch { /* 退回术语表 */ }
  return glossaryQuery(q);
}

/* ---------------- 抽取式进展简报（本地，不调用大模型） ---------------- */

const STOP = new Set(('the a an and or of to in for on with by is are was were be been this that these those we our their its as at from can could may might will would should not but also more most than then there here which who whom whose what when where how all any both each few other some such no nor only own same so too very s t don now it he she they them his her'.split(' ')));

function sentences(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 40 && s.length < 420);
}

function keywords(papers) {
  const freq = new Map();
  for (const p of papers) {
    for (const w of String(p.abstract || '').toLowerCase().match(/[a-z][a-z-]{3,}/g) || []) {
      if (STOP.has(w)) continue;
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  return new Set([...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([w]) => w));
}

const CUE = {
  method: /(we (use|used|present|report|measure|observe|analyse|analyze|model|derive)|observation|observations|data|simulation|simulations|spectra|spectroscop|telescope|instrument|survey|mission|detect|measurement)/i,
  debate: /(however|but |yet |remains? (unclear|unknown|uncertain)|controvers|debate|unresolved|puzzle|tension|discrepan|suggest(s|ing)? that|may (be|have)|might|cannot (be|exclude)|alternative|challenge)/i,
  future: /(future|upcoming|next|will (be|allow|enable|provide)|plan(ned)?|forthcoming|should be (tested|verified)|follow-?up|promise)/i,
};

function score(sentence, kw, idx, total) {
  const lower = sentence.toLowerCase();
  let s = 0;
  for (const w of lower.match(/[a-z][a-z-]{3,}/g) || []) if (kw.has(w)) s += 1;
  s += Math.max(0, 1.2 - idx / Math.max(1, total)) * 2;   // 摘要开头通常更重要
  return s;
}

/** 生成中文（原文英文）抽取式简报 */
export async function summarizeProgress(topic, papers) {
  const list = papers.slice(0, 8).filter((p) => p.abstract);
  if (!list.length) return '（这些来源未提供摘要，无法生成简报。可打开原文阅读。）';
  const kw = keywords(list);
  const pool = [];
  list.forEach((p, n) => {
    sentences(p.abstract).forEach((text, i, arr) => {
      pool.push({ text, ref: n + 1, score: score(text, kw, i, arr.length), title: p.title });
    });
  });
  const pick = (re, limit) => pool.filter((x) => re.test(x.text)).sort((a, b) => b.score - a.score).slice(0, limit);
  const used = new Set();
  const take = (items) => items.filter((x) => { const k = x.text.slice(0, 60); if (used.has(k)) return false; used.add(k); return true; });

  // 先按主题抽取（下一步 / 争议 / 方法），剩余的最高分句子作为核心结论
  const future = take(pick(CUE.future, 3));
  const debate = take(pick(CUE.debate, 4));
  const method = take(pick(CUE.method, 4));
  let core = take(pick(/./, 5));
  if (core.length < 3) {
    const fill = pick(/./, 6).filter((x) => !core.some((c) => c.text === x.text));
    core = core.concat(fill.slice(0, 3 - core.length));
  }

  const bullet = (arr) => arr.map((x) => `- ${x.text}（据 [${x.ref}]）`).join('\n');
  const titleOf = (n) => `[${n}] ${list[n - 1].title}`;

  const parts = [
    `## 核心结论`,
    bullet(core) || '- （摘要信息不足）',
    '',
    `## 方法与观测`,
    bullet(method) || '- （未从摘要中提取到明确的方法描述）',
    '',
    `## 争议与未解问题`,
    bullet(debate) || '- （摘要中未明确提及争议）',
    '',
    `## 值得关注的下一步`,
    bullet(future) || '- （摘要中未明确提及后续计划）',
    '',
    `## 参考论文`,
    list.map((p, i) => `- ${titleOf(i + 1)} — ${p.year ?? '—'} · ${p.source}`).join('\n'),
    '',
    `> 本简报由本地抽取式摘要生成（不调用任何在线大模型）：要点直接摘自各篇摘要原句，未做改写或推断；`,
    `> 主题：${topic}。如需更深入解读，请点开原文。`,
  ];
  return parts.join('\n');
}

/** 服务端翻译引擎是否可用（恒为 true，客户端会优先用浏览器内置翻译） */
export async function hasKey() { return true; }
