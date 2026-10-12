/**
 * 数据中心：数据源状态、管线更新、科研监测、人工覆盖。
 *
 *  设计前提（很重要）：
 *   1. 「状态」永远是现场读出来的——文件 mtime、体积、meta 里的记录数。
 *      不在 sources.json 里缓存「上次更新时间」这类字段，那种字段注定会过期。
 *   2. 「更新」以管线（pipeline）为单位。恒星表与系外行星表共用同一条抓取链路，
 *      拆成互不相干的独立按钮只是视觉上的谎言。
 *   3. 「科研监测」不假装自己能读懂论文并自动判定冲突。它把最新论文、
 *      关键词命中信号、以及可能受影响的本地字段摆出来，由人拍板。
 *      自动抓到的结论一律进待复核队列，绝不会直接覆盖程序数据。
 *
 * 零第三方依赖，Node 18+。
 */
import { readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

const UA = 'LittleCosmos/1.0 (local educational visualization; mailto:little-cosmos@localhost)';
const ASTRO_CATS = '(cat:astro-ph.EP OR cat:astro-ph.SR OR cat:astro-ph.GA OR cat:astro-ph.CO OR cat:astro-ph.HE)';

/**
 * 允许被管线调用的脚本白名单——即使 sources.json 被改坏也跑不出这个集合。
 *
 * ⚠️ **这张表与 `data/sources.json` 里的 `pipelines[].steps[].bin` 是一对必须同步的表。**
 *    `runPipeline()` 会拒绝任何不在本表里的 bin（报 `BAD_STEP`）。
 *    曾经踩过：`compact` 管线登记了 `fetch-compact`，但白名单里漏了它 ——
 *    于是「致密天体」这条管线**在界面上能点、一跑必报未授权脚本**，
 *    而当时的自检只核对脚本文件存在与否、**不核对白名单**，两张表就这样静默分叉了。
 *    ⇒ 现在由自检 `shell.pipeline-bins` 双向核对，改为 `export` 让自检能读到真值。
 */
export const BIN_WHITELIST = new Set([
  'fetch-assets', 'build-data', 'build-deepsky', 'fetch-gallery',
  'fetch-textures', 'fetch-maps', 'find-maps', 'fetch-compact',
  'fetch-mboss', 'fetch-quasars', 'fetch-localgroup',
]);

/* ============================================================
   基础工具
   ============================================================ */
const readJson = async (p, fallback = null) => {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return fallback; }
};

async function fileStat(p) {
  try {
    const s = await stat(p);
    return { exists: true, bytes: s.size, mtime: s.mtime.toISOString() };
  } catch { return { exists: false, bytes: 0, mtime: null }; }
}

const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);

/* ============================================================
   一、数据源状态
   ============================================================ */
/**
 * 把 sources.json 的「身份信息」与现场读到的「实际状态」合并。
 * 返回 { generatedAt, pipelines, datasets, monitors, totals }
 */
export async function sourceStatus(ROOT) {
  const DATA = path.join(ROOT, 'data');
  const reg = await readJson(path.join(DATA, 'sources.json'));
  if (!reg) throw Object.assign(new Error('缺少 data/sources.json'), { code: 'NO_REGISTRY' });

  const cache = new Map();
  const statOf = async (rel) => {
    if (!cache.has(rel)) cache.set(rel, fileStat(path.join(ROOT, rel)));
    return cache.get(rel);
  };

  /** 从数据集声明的 metaFile 里读记录数（meta 结构各文件不同，做兼容） */
  const countOf = async (rel) => {
    if (!rel) return null;
    const j = await readJson(path.join(ROOT, rel));
    if (!j) return null;
    const m = j.meta || {};
    if (typeof m.count === 'number') return m.count;
    if (typeof m.total === 'number') return m.total;
    if (Array.isArray(j.objects)) return j.objects.length;
    if (Array.isArray(j.systems)) return j.systems.length;
    if (Array.isArray(j.rows)) return j.rows.length;
    if (j.bodies && typeof j.bodies === 'object') return Object.keys(j.bodies).length;
    if (Array.isArray(j.findings)) return j.findings.length;
    if (Array.isArray(j.overrides)) return j.overrides.length;
    return null;
  };

  const datasets = [];
  for (const d of reg.datasets || []) {
    const files = [];
    let latestMtime = null;
    let totalBytes = 0;
    for (const rel of d.files || []) {
      const s = await statOf(rel);
      // 目录类条目（以 / 结尾）单独统计
      if (rel.endsWith('/')) {
        let n = 0, bytes = 0, mtime = null;
        try {
          for (const f of await readdir(path.join(ROOT, rel))) {
            const fs2 = await fileStat(path.join(ROOT, rel, f));
            n++; bytes += fs2.bytes;
            if (fs2.mtime && (!mtime || fs2.mtime > mtime)) mtime = fs2.mtime;
          }
        } catch { /* 目录还不存在 */ }
        files.push({ path: rel, exists: n > 0, bytes, mtime, fileCount: n });
        totalBytes += bytes;
        if (mtime && (!latestMtime || mtime > latestMtime)) latestMtime = mtime;
        continue;
      }
      files.push({ path: rel, ...s });
      totalBytes += s.bytes;
      if (s.mtime && (!latestMtime || s.mtime > latestMtime)) latestMtime = s.mtime;
    }
    datasets.push({
      id: d.id,
      label: d.label,
      provider: d.provider,
      license: d.license,
      url: d.url,
      mode: d.mode,
      cadence: d.cadence,
      pipeline: d.pipeline || null,
      note: d.note || '',
      files,
      bytes: totalBytes,
      updatedAt: latestMtime,
      records: await countOf(d.metaFile),
    });
  }

  // 管线附带「上次运行结果」——由 /api/data/update 落盘
  const runs = await readJson(path.join(DATA, 'update-runs.json'), { runs: {} });
  const pipelines = (reg.pipelines || []).map((p) => ({
    id: p.id,
    label: p.label,
    summary: p.summary,
    steps: p.steps.map((s) => ({ bin: s.bin, args: s.args, label: s.label })),
    outputs: p.outputs,
    durationHint: p.durationHint,
    lastRun: runs.runs?.[p.id] || null,
  }));

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    pipelines,
    datasets,
    monitors: reg.monitors || [],
    policy: reg.updatePolicy || {},
    totals: {
      datasets: datasets.length,
      fetchable: datasets.filter((d) => d.mode === 'fetch').length,
      curated: datasets.filter((d) => d.mode === 'curated').length,
      bytes: datasets.reduce((a, d) => a + d.bytes, 0),
    },
  };
}

/* ============================================================
   二、管线更新
   ============================================================ */
/** 同一时刻只允许一条管线在跑——两条并发重建会互相覆盖产出文件 */
let RUNNING = null;

export const isRunning = () => RUNNING;

/**
 * 执行一条管线。onLog({ stream, line }) 逐行回调。
 * 返回 { ok, pipeline, steps: [{ label, code, ms, tail }], outputs }
 */
export async function runPipeline(ROOT, id, onLog = () => {}, { stepTimeoutMs = 15 * 60 * 1000 } = {}) {
  if (RUNNING) {
    throw Object.assign(new Error(`已有管线「${RUNNING}」在运行，请等它结束`), { code: 'BUSY' });
  }
  const reg = await readJson(path.join(ROOT, 'data', 'sources.json'));
  const pipeline = (reg?.pipelines || []).find((p) => p.id === id);
  if (!pipeline) throw Object.assign(new Error(`未知管线「${id}」`), { code: 'UNKNOWN_PIPELINE' });

  // 校验每一步，任何一步不合法就整条拒绝——不要跑一半才报错
  for (const s of pipeline.steps) {
    if (!BIN_WHITELIST.has(s.bin)) {
      throw Object.assign(new Error(`管线步骤引用了未授权的脚本「${s.bin}」`), { code: 'BAD_STEP' });
    }
    if (!Array.isArray(s.args) || s.args.some((a) => typeof a !== 'string' || a.length > 200)) {
      throw Object.assign(new Error(`管线步骤参数不合法`), { code: 'BAD_STEP' });
    }
  }

  RUNNING = id;
  const startedAt = Date.now();
  const steps = [];
  try {
    for (const s of pipeline.steps) {
      const script = path.join(ROOT, 'tools', `${s.bin}.mjs`);
      onLog({ stream: 'meta', line: `▶ ${s.label} — node tools/${s.bin}.mjs ${s.args.join(' ')}` });
      const t0 = Date.now();
      const res = await runStep(ROOT, script, s.args, onLog, stepTimeoutMs);
      steps.push({ label: s.label, bin: s.bin, code: res.code, ms: Date.now() - t0, tail: res.tail });
      if (res.code !== 0) {
        onLog({ stream: 'meta', line: `✗ ${s.label} 退出码 ${res.code}，管线中止（原有数据保持不变）` });
        return await recordRun(ROOT, id, {
          at: new Date().toISOString(), ok: false, ms: Date.now() - startedAt,
          failedStep: s.label, steps,
        });
      }
      onLog({ stream: 'meta', line: `✓ ${s.label} 完成（${((Date.now() - t0) / 1000).toFixed(1)}s）` });
    }
    onLog({ stream: 'meta', line: `✅ 管线「${pipeline.label}」全部完成` });
    return await recordRun(ROOT, id, {
      at: new Date().toISOString(), ok: true, ms: Date.now() - startedAt, steps,
    });
  } finally {
    RUNNING = null;
  }
}

function runStep(ROOT, script, args, onLog, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: ROOT,
      // 更名遗留：原来是 LSS_PIPELINE（旧品牌前缀），已改为 LC_PIPELINE。
      // ⚠️ 现状：**目前没有任何子脚本读它**。保留是为了让脚本能识别
      //    「我正被管线调用」——例如管线模式下不该交互式提问、不该写 data/.port
      //    （同 server.mjs 里 LC_NO_PORT_RECORD 的用法）。若确认永不需要，可删。
      env: { ...process.env, LC_PIPELINE: '1' },
      windowsHide: true,
    });
    const tail = [];
    const push = (stream, buf) => {
      const text = buf.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 60) tail.shift();
        onLog({ stream, line });
      }
    };
    child.stdout.on('data', (b) => push('stdout', b));
    child.stderr.on('data', (b) => push('stderr', b));
    const timer = setTimeout(() => {
      onLog({ stream: 'meta', line: `✗ 步骤超时（${Math.round(timeoutMs / 60000)} 分钟），已终止` });
      try { child.kill(); } catch { /* ignore */ }
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, tail: [...tail, `spawn 失败：${e.message}`] });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, tail });
    });
  });
}

async function recordRun(ROOT, id, result) {
  const p = path.join(ROOT, 'data', 'update-runs.json');
  const j = (await readJson(p, { runs: {} })) || { runs: {} };
  j.runs = j.runs || {};
  j.runs[id] = result;
  j.updatedAt = new Date().toISOString();
  try { await writeFile(p, JSON.stringify(j, null, 2), 'utf8'); } catch { /* 只读目录忽略 */ }
  return result;
}

/* ============================================================
   三、科研监测
   ============================================================ */
async function fetchText(url, { timeout = 25000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally { clearTimeout(timer); }
}

const decodeXml = (s = '') => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const pickTag = (block, tag) => {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  return m ? decodeXml(m[1]) : '';
};

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 单个词组的命中测试（带词边界，允许复数）。
 *
 *   必须有词边界——否则 "proxima" 会命中 "proximal"，
 *   "neptune" 会命中 "neptunium" 这类无关词，队列立刻被污染。
 */
function hitTerm(hay, term) {
  const t = term.toLowerCase();
  const tail = /[a-z0-9]$/.test(t) ? 's?' : '';   // 允许复数，但只对以字母数字结尾的词
  const re = new RegExp(`(?<![a-z0-9])${esc(t)}${tail}(?![a-z0-9])`, 'i');
  return re.test(hay);
}

/**
 * 分诊线索：命中情况与相关性打分。
 *
 *   采用「合取」门槛——必须同时命中
 *     · 一个 anchor（天体/任务等强特征实体），且
 *     · 一个 context（该主题特有的话题词）
 *   才有资格进候选。
 *
 *   为什么要合取：光靠关键词分不清「JWST 观测系外行星大气」和「JWST 观测遥远星系」，
 *   只要求命中 "jwst" 的话，半个人文宇宙的论文都会被塞进队列。
 */
function keywordHits(text, topic) {
  const hay = text.toLowerCase();
  const anchorHits = (topic.anchors || []).filter((a) => hitTerm(hay, a));
  const contextHits = (topic.context || []).filter((c) => hitTerm(hay, c));

  const words = [...new Set(
    [topic.query, ...(topic.altQueries || []), topic.label]
      .join(' ')
      .toLowerCase()
      .split(/[^a-z0-9-]+/)
      .filter((w) => w.length >= 4 && !STOP.has(w)),
  )];
  const hits = words.filter((w) => hay.includes(w));
  const genericRatio = words.length ? hits.length / words.length : 0;

  const gated = anchorHits.length > 0 && contextHits.length > 0;
  const score = gated
    ? Math.min(1, 0.6 + 0.15 * anchorHits.length + 0.15 * contextHits.length + 0.1 * genericRatio)
    : 0;
  return { hits, anchorHits, contextHits, gated, score };
}

const STOP = new Set([
  'with', 'from', 'that', 'this', 'have', 'been', 'were', 'their', 'than', 'into', 'using',
  'observations', 'observation', 'study', 'results', 'evidence', 'analysis', 'detection',
]);

/**
 * 扫描最新论文，产出「待复核建议」。
 * 注意：这里不做语义冲突判定——只把论文 + 可能受影响的本地字段摆出来。
 */
export async function scanResearch(ROOT, onLog = () => {}) {
  const topics = await listWatchTopics(ROOT);
  const windowDays = topics.defaults?.windowDays ?? 180;
  const maxPerTopic = topics.defaults?.maxPerTopic ?? 6;
  const cutoff = Date.now() - windowDays * 86400000;

  const queue = await readQueue(ROOT);
  const seen = new Set(queue.candidates.map((c) => c.id));
  const added = [];

  for (const topic of topics.topics || []) {
    onLog({ stream: 'meta', line: `▶ 检索主题：${topic.label}` });
    const terms = [topic.query, ...(topic.altQueries || [])].join(' OR ');
    const q = `(${terms}) AND ${ASTRO_CATS}`;
    const url = 'https://export.arxiv.org/api/query?search_query=' + encodeURIComponent(q) +
      `&start=0&max_results=${Math.max(maxPerTopic * 4, 12)}&sortBy=submittedDate&sortOrder=descending`;
    let xml;
    try {
      xml = await fetchText(url);
    } catch (e) {
      onLog({ stream: 'meta', line: `  ✗ 检索失败（${e.message}），跳过该主题` });
      continue;
    }
    const entries = xml.split(/<entry>/i).slice(1);
    let picked = 0;
    for (const block of entries) {
      if (picked >= maxPerTopic) break;
      const published = pickTag(block, 'published') || pickTag(block, 'updated');
      const date = published ? published.slice(0, 10) : null;
      if (!date) continue;
      const t = Date.parse(date);
      if (Number.isFinite(t) && t < cutoff) continue;      // 窗口外的不看

      const title = pickTag(block, 'title');
      const abstract = pickTag(block, 'summary');
      const kw = keywordHits(`${title} ${abstract}`, topic);
      // 硬门槛：必须命中 anchor 且命中 context，且相关性达标
      const requireAnchor = topics.defaults?.requireAnchor !== false;
      const requireContext = topics.defaults?.requireContext !== false;
      if (requireAnchor && !kw.anchorHits.length) continue;
      if (requireContext && !kw.contextHits.length) continue;
      if (!kw.gated) continue;
      if (kw.score < (topics.defaults?.minRelevance ?? 0.5)) continue;

      const idUrl = pickTag(block, 'id');
      const arxivId = (/([0-9]{4}\.[0-9]{4,5}|[a-z-]+\/\d{7})(v\d+)?/i.exec(idUrl) || [])[0] || '';
      const cid = hash(`${topic.id}|${arxivId || title}`);
      if (seen.has(cid)) continue;

      const authors = [...block.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/gi)].map((m) => decodeXml(m[1]));
      const cand = {
        id: cid,
        topicId: topic.id,
        topicLabel: topic.label,
        risk: topic.risk || '中',
        title,
        authors: authors.slice(0, 8),
        date,
        url: idUrl,
        arxivId,
        pdf: arxivId ? `https://arxiv.org/pdf/${arxivId}` : null,
        abstract: abstract.slice(0, 700),
        matchedKeywords: kw.hits.slice(0, 8),
        matchedAnchors: kw.anchorHits.slice(0, 8),
        matchedContext: kw.contextHits.slice(0, 8),
        relevance: +kw.score.toFixed(2),
        targets: topic.targets || [],
        why: topic.why || '',
        hint: topic.hint || '',
        status: 'pending',       // pending | accepted | dismissed
        foundAt: new Date().toISOString(),
      };
      added.push(cand);
      seen.add(cid);
      picked++;
      onLog({ stream: 'meta', line: `  · 命中 ${date} ${title.slice(0, 60)}…` });
    }
    if (!picked) onLog({ stream: 'meta', line: `  · 窗口内无新的高相关论文` });
  }

  queue.candidates = [...dedupe([...added, ...queue.candidates])].slice(0, 300);
  queue.lastScan = new Date().toISOString();
  queue.lastScanAdded = added.length;
  await writeQueue(ROOT, queue);
  return { ok: true, added: added.length, scanned: (topics.topics || []).length, candidates: queue.candidates };
}

const dedupe = (list) => {
  const m = new Map();
  for (const c of list) if (!m.has(c.id)) m.set(c.id, c);
  return m.values();
};

export async function listWatchTopics(ROOT) {
  const t = await readJson(path.join(ROOT, 'data', 'watch-topics.json'));
  if (!t) throw Object.assign(new Error('缺少 data/watch-topics.json'), { code: 'NO_TOPICS' });
  return t;
}

export async function readQueue(ROOT) {
  return (await readJson(path.join(ROOT, 'data', 'watch-queue.json'), null))
    || { schema: 'lc.watch-queue/1', lastScan: null, candidates: [] };
}

async function writeQueue(ROOT, q) {
  await writeFile(path.join(ROOT, 'data', 'watch-queue.json'), JSON.stringify(q, null, 2), 'utf8');
}

export async function dismissCandidate(ROOT, id) {
  const q = await readQueue(ROOT);
  const c = q.candidates.find((x) => x.id === id);
  if (!c) throw Object.assign(new Error('找不到该建议'), { code: 'NOT_FOUND' });
  c.status = 'dismissed';
  c.dismissedAt = new Date().toISOString();
  await writeQueue(ROOT, q);
  return { ok: true, id };
}

export async function clearDismissed(ROOT) {
  const q = await readQueue(ROOT);
  const before = q.candidates.length;
  q.candidates = q.candidates.filter((c) => c.status !== 'dismissed');
  await writeQueue(ROOT, q);
  return { ok: true, removed: before - q.candidates.length };
}

/* ============================================================
   四、人工覆盖（overrides）
   ============================================================ */
export async function readOverrides(ROOT) {
  return (await readJson(path.join(ROOT, 'data', 'overrides.json'), null))
    || { schema: 'lc.overrides/1', overrides: [] };
}

/**
 * 采纳一条待复核建议 → 写进 overrides.json。
 *
 * payload: { candidateId, entityId, path, value, note, origin }
 *   entityId  运行时实体 id，如 'jupiter'（浏览器里能直接落地）
 *   path      实体内的点分路径，支持数组下标，如 'moons' / 'facts[1]'
 *   origin    可选，回溯到源文件与字段，如 'web/js/data/solar-system.js → jupiter.moons'
 *
 * 注意：这里只登记「要改哪个字段、改成什么」，真正的替换由前端加载时执行，
 * 保证原始人工整理表不被自动流程直接改写。
 */
export async function addOverride(ROOT, payload) {
  const { candidateId, entityId, path: fieldPath, value, note, origin } = payload || {};

  if (!entityId || typeof entityId !== 'string' || entityId.length > 120 || !/^[A-Za-z0-9_.:-]+$/.test(entityId)) {
    throw Object.assign(new Error('entityId 不合法'), { code: 'BAD_INPUT' });
  }
  if (!fieldPath || typeof fieldPath !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*$/.test(fieldPath) || fieldPath.length > 120) {
    throw Object.assign(new Error('path 不合法（形如 moons 或 facts[1] 或 ring.widthKm）'), { code: 'BAD_INPUT' });
  }
  if (value === undefined) throw Object.assign(new Error('缺少 value'), { code: 'BAD_INPUT' });
  if (value !== null && typeof value === 'object') {
    throw Object.assign(new Error('value 只接受标量（字符串 / 数字 / 布尔 / null）'), { code: 'BAD_INPUT' });
  }

  const doc = await readOverrides(ROOT);
  const id = hash(`${entityId}|${fieldPath}|${JSON.stringify(value)}`);
  if (doc.overrides.some((o) => o.id === id)) {
    return { ok: true, id, already: true, overrides: doc.overrides };
  }

  doc.overrides.push({
    id,
    entityId,
    path: fieldPath,
    value,
    note: typeof note === 'string' ? note.slice(0, 500) : '',
    origin: typeof origin === 'string' ? origin.slice(0, 300) : '',
    candidateId: candidateId || null,
    appliedAt: new Date().toISOString(),
  });
  doc.updatedAt = new Date().toISOString();
  await writeFile(path.join(ROOT, 'data', 'overrides.json'), JSON.stringify(doc, null, 2), 'utf8');

  if (candidateId) {
    const q = await readQueue(ROOT);
    const c = q.candidates.find((x) => x.id === candidateId);
    if (c) { c.status = 'accepted'; c.acceptedAt = new Date().toISOString(); c.overrideId = id; await writeQueue(ROOT, q); }
  }
  return { ok: true, id, overrides: doc.overrides };
}

export async function removeOverride(ROOT, id) {
  const doc = await readOverrides(ROOT);
  const before = doc.overrides.length;
  doc.overrides = doc.overrides.filter((o) => o.id !== id);
  if (doc.overrides.length === before) throw Object.assign(new Error('找不到该覆盖项'), { code: 'NOT_FOUND' });
  doc.updatedAt = new Date().toISOString();
  await writeFile(path.join(ROOT, 'data', 'overrides.json'), JSON.stringify(doc, null, 2), 'utf8');
  return { ok: true, overrides: doc.overrides };
}
