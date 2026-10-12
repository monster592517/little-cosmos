/**
 * 论文元搜索引擎（自建）
 *
 *  并行聚合 4 个开放学术数据源，统一归一化 → 去重 → 相关性/时效性/影响力排序：
 *    · arXiv        （Atom API，预印本，天文分类过滤）
 *    · OpenAlex     （开放学术图谱，摘要需从倒排索引还原）
 *    · Crossref     （DOI 注册库，元数据权威）
 *    · Semantic Scholar（引用与开放 PDF，免费额度有限，失败自动降级）
 *
 *  中文查询先经 DeepSeek 转英文关键词，保证命中率。
 */
import { toEnglishQuery } from './translate.mjs';

const UA = 'LittleCosmos/1.0 (local educational visualization; mailto:little-cosmos@localhost)';
const ASTRO_CATS = '(cat:astro-ph.EP OR cat:astro-ph.SR OR cat:astro-ph.GA OR cat:astro-ph.CO OR cat:astro-ph.HE OR cat:astro-ph.IM)';

async function fetchJson(url, { timeout = 20000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': UA, accept: 'application/json', ...headers } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}

async function fetchText(url, { timeout = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally { clearTimeout(timer); }
}

const decode = (s = '') => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

function pick(block, tag) {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  return m ? decode(m[1]) : '';
}

/* ---------------- arXiv ---------------- */
async function searchArxiv(query, limit) {
  const q = `${query} AND ${ASTRO_CATS}`;
  const url = 'https://export.arxiv.org/api/query?search_query=' + encodeURIComponent(q) +
    `&start=0&max_results=${limit}&sortBy=submittedDate&sortOrder=descending`;
  const xml = await fetchText(url);
  const entries = xml.split(/<entry>/i).slice(1);
  return entries.map((block) => {
    const idUrl = pick(block, 'id');
    const arxivId = (/([0-9]{4}\.[0-9]{4,5}|[a-z-]+\/\d{7})(v\d+)?/i.exec(idUrl) || [])[0] || '';
    const pdf = (/<link[^>]*title="pdf"[^>]*href="([^"]+)"/i.exec(block) || [])[1] || (arxivId ? `https://arxiv.org/pdf/${arxivId}` : '');
    const authors = [...block.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/gi)].map((m) => decode(m[1]));
    const published = pick(block, 'published') || pick(block, 'updated');
    return {
      source: 'arXiv',
      sourceId: arxivId,
      title: pick(block, 'title'),
      abstract: pick(block, 'summary'),
      authors,
      year: published ? Number(published.slice(0, 4)) : null,
      date: published ? published.slice(0, 10) : null,
      venue: 'arXiv 预印本',
      url: idUrl,
      pdf,
      doi: pick(block, 'arxiv:doi') || null,
      citations: null,
    };
  });
}

/* ---------------- OpenAlex ---------------- */
function fromInverted(idx) {
  if (!idx) return '';
  const slots = [];
  for (const [word, positions] of Object.entries(idx)) for (const p of positions) slots[p] = word;
  return slots.filter(Boolean).join(' ');
}

async function searchOpenAlex(query, limit) {
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${limit}` +
    `&sort=publication_date:desc&filter=from_publication_date:2012-01-01&mailto=little-cosmos@localhost`;
  const data = await fetchJson(url);
  return (data.results || []).map((w) => ({
    source: 'OpenAlex',
    sourceId: w.id,
    title: w.title || w.display_name || '',
    abstract: fromInverted(w.abstract_inverted_index),
    authors: (w.authorships || []).slice(0, 12).map((a) => a.author?.display_name).filter(Boolean),
    year: w.publication_year ?? null,
    date: w.publication_date ?? null,
    venue: w.primary_location?.source?.display_name || 'OpenAlex 收录',
    url: w.doi ? `https://doi.org/${w.doi.replace(/^https?:\/\/doi.org\//, '')}` : w.id,
    pdf: w.best_oa_location?.pdf_url || w.primary_location?.pdf_url || null,
    doi: w.doi ? w.doi.replace(/^https?:\/\/doi.org\//, '') : null,
    citations: w.cited_by_count ?? 0,
  }));
}

/* ---------------- Crossref ---------------- */
async function searchCrossref(query, limit) {
  const url = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}&rows=${limit}` +
    `&sort=published&order=desc&select=DOI,title,abstract,author,issued,container-title,URL,is-referenced-by-count,type`;
  const data = await fetchJson(url);
  return (data.message?.items || []).map((w) => {
    const issued = w.issued?.['date-parts']?.[0] || [];
    return {
      source: 'Crossref',
      sourceId: w.DOI,
      title: (w.title || [])[0] || '',
      abstract: decode(w.abstract || ''),
      authors: (w.author || []).slice(0, 12).map((a) => [a.given, a.family].filter(Boolean).join(' ')),
      year: issued[0] ?? null,
      date: issued.length ? issued.map((n, i) => String(n).padStart(i ? 2 : 4, '0')).join('-') : null,
      venue: (w['container-title'] || [])[0] || 'Crossref 收录',
      url: w.URL,
      pdf: null,
      doi: w.DOI,
      citations: w['is-referenced-by-count'] ?? 0,
    };
  }).filter((p) => p.title);
}

/* ---------------- Semantic Scholar ---------------- */
async function searchSemantic(query, limit) {
  const fields = 'title,abstract,year,publicationDate,authors,externalIds,openAccessPdf,venue,citationCount,url';
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${limit}&fields=${fields}`;
  const data = await fetchJson(url, { timeout: 15000 });
  return (data.data || []).map((w) => ({
    source: 'Semantic Scholar',
    sourceId: w.paperId,
    title: w.title || '',
    abstract: w.abstract || '',
    authors: (w.authors || []).slice(0, 12).map((a) => a.name),
    year: w.year ?? null,
    date: w.publicationDate ?? null,
    venue: w.venue || 'Semantic Scholar 收录',
    url: w.url || (w.externalIds?.DOI ? `https://doi.org/${w.externalIds.DOI}` : ''),
    pdf: w.openAccessPdf?.url || null,
    doi: w.externalIds?.DOI || null,
    citations: w.citationCount ?? 0,
  }));
}

/* ---------------- 归一化 / 去重 / 排序 ---------------- */
const normTitle = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '').slice(0, 90);

function dedupe(list) {
  const out = [];
  const byTitle = new Map();
  const byDoi = new Map();
  for (const p of list) {
    if (!p.title) continue;
    const tk = `t:${normTitle(p.title)}`;
    const dk = p.doi ? `d:${p.doi.toLowerCase()}` : null;
    const prev = byTitle.get(tk) || (dk ? byDoi.get(dk) : null);
    if (!prev) {
      const item = { ...p, alsoIn: [] };
      out.push(item);
      byTitle.set(tk, item);
      if (dk) byDoi.set(dk, item);
      continue;
    }
    // 合并：保留信息最全的一条，记录其它来源
    const keepAbstract = (prev.abstract?.length || 0) >= (p.abstract?.length || 0) ? prev.abstract : p.abstract;
    const better = (p.abstract?.length || 0) > (prev.abstract?.length || 0) ? p : prev;
    Object.assign(prev, better, {
      abstract: keepAbstract,
      pdf: prev.pdf || p.pdf,
      doi: prev.doi || p.doi,
      citations: Math.max(prev.citations ?? 0, p.citations ?? 0),
      alsoIn: [...new Set([...(prev.alsoIn || []), prev.source, p.source])].filter((s) => s !== better.source),
    });
    // 新键并入同一对象，保证后续同标题/同 DOI 都能命中
    byTitle.set(tk, prev);
    if (prev.doi) byDoi.set(`d:${String(prev.doi).toLowerCase()}`, prev);
    if (dk) byDoi.set(dk, prev);
  }
  return out;
}

function score(papers, query) {
  const tokens = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  const now = Date.now();
  for (const p of papers) {
    const hay = `${p.title} ${p.abstract}`.toLowerCase();
    const rel = tokens.length ? tokens.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0) / tokens.length : 0.5;
    const ageYears = p.date ? (now - Date.parse(p.date)) / 3.15576e10 : 4;
    const recency = Math.exp(-Math.max(0, ageYears) / 5);
    const impact = Math.min(1, Math.log1p(p.citations ?? 0) / 7);
    const hasAbstract = p.abstract ? 1 : 0;
    p.score = 0.46 * rel + 0.3 * recency + 0.14 * impact + 0.1 * hasAbstract;
  }
  return papers;
}

export async function searchPapers(rawQuery, { limit = 24, sources = ['arXiv', 'OpenAlex', 'Crossref', 'Semantic Scholar'], astroOnly = true, sort = 'relevance' } = {}) {
  const query = String(rawQuery || '').trim();
  if (!query) return { query, englishQuery: '', results: [], sources: {}, errors: [] };

  const englishQuery = await toEnglishQuery(query);
  const per = Math.max(8, Math.min(40, limit));
  const jobs = [];
  const errors = [];
  if (sources.includes('arXiv')) jobs.push(searchArxiv(englishQuery, per).catch((e) => { errors.push(`arXiv: ${e.message}`); return []; }));
  if (sources.includes('OpenAlex')) jobs.push(searchOpenAlex(englishQuery, per).catch((e) => { errors.push(`OpenAlex: ${e.message}`); return []; }));
  if (sources.includes('Crossref')) jobs.push(searchCrossref(englishQuery, per).catch((e) => { errors.push(`Crossref: ${e.message}`); return []; }));
  if (sources.includes('Semantic Scholar')) jobs.push(searchSemantic(englishQuery, Math.min(per, 20)).catch((e) => { errors.push(`Semantic Scholar: ${e.message}`); return []; }));

  const groups = await Promise.all(jobs);
  const counts = {};
  let all = [];
  for (const g of groups) {
    if (!g.length) continue;
    counts[g[0].source] = g.length;
    all = all.concat(g);
  }
  let results = score(dedupe(all), englishQuery);
  if (sort === 'recent') {
    results.sort((a, b) => (Date.parse(b.date || 0) || 0) - (Date.parse(a.date || 0) || 0));
  } else if (sort === 'cited') {
    results.sort((a, b) => (b.citations ?? 0) - (a.citations ?? 0));
  } else {
    results.sort((a, b) => b.score - a.score);
  }
  results = results.filter((p) => p.year == null || p.year >= 1990).slice(0, limit);
  return { query, englishQuery, sources: counts, total: results.length, results, errors };
}

/** 为一个天体生成「最新研究进展」检索式 */
export function buildTopicQuery(name, englishName, extra = '') {
  const base = englishName || name;
  return extra ? `${base} ${extra}` : `${base} planet astronomy`;
}
