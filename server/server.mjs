#!/usr/bin/env node
/**
 * 小小宇宙 · 本地服务
 *   · 静态资源：web/（前端）、data/（数据集）
 *   · 自建论文元搜索引擎：/api/research/*
 *   · 中英翻译（DeepSeek，磁盘缓存）：/api/research/translate
 * 零第三方依赖，Node 18+。
 */
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchPapers } from './lib/papers.mjs';
import { translateBatch, summarizeProgress } from './lib/translate.mjs';
import { createLogger } from './lib/log.mjs';
import { runSelfCheck } from './lib/selfcheck.mjs';
import {
  sourceStatus, runPipeline, isRunning,
  listWatchTopics, scanResearch, readQueue, dismissCandidate, clearDismissed,
  readOverrides, addOverride, removeOverride,
} from './lib/datacenter.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const DATA = path.join(ROOT, 'data');

/**
 * 统一日志。挂上进程级兜底：未捕获异常 / 未处理 Promise 都会留下带栈的记录，
 * 而不是让进程无声无息地消失（那种"服务自己就没了"最难查）。
 */
const log = createLogger(ROOT, { scope: 'server' }).captureProcessErrors();

const PORT = Number((process.argv.find((a) => a.startsWith('--port=')) || '').slice(7)) || Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';
/** 真正在用的端口。起始端口被占用时会自动顺延，所以它不一定等于 PORT——自检需要知道实况。 */
let actualPort = null;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.bin': 'application/octet-stream', '.glb': 'model/gltf-binary',
};

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
};

const fail = (res, code, message, extra = {}) => json(res, code, { ok: false, error: message, ...extra });

async function readBody(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('请求体不是合法 JSON'); }
}

/* ---------------- 静态文件 ---------------- */
const ROOTS = [
  { prefix: '/data/', dir: DATA },
  { prefix: '/', dir: WEB },
];

async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const entry = ROOTS.find((r) => rel.startsWith(r.prefix));
  if (!entry) return false;
  const sub = rel.slice(entry.prefix.length);
  const dirAbs = path.resolve(entry.dir);
  const file = path.resolve(dirAbs, sub);
  // 必须落在本根目录之内。比较时要带上路径分隔符——否则 `web` 与 `webX`
  // 这类同前缀的兄弟目录会被 startsWith 放行。
  if (file !== dirAbs && !file.startsWith(dirAbs + path.sep)) { fail(res, 403, '非法路径'); return true; }
  try {
    const info = await stat(file);
    if (info.isDirectory()) return false;
    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const etag = `W/"${info.size}-${info.mtimeMs.toString(36)}"`;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304).end(); return true; }
    res.writeHead(200, {
      'content-type': type,
      'content-length': info.size,
      etag,
      /* ⚠️ 2026-10-12：.js/.mjs/.css 改 `no-cache`（靠 ETag 304 revalidate）。
       *   旧值 `max-age=300` 让「改完代码 → 用户普通刷新」在 5 分钟内拿到旧模块
       *   ——实测发生过：三处视觉修复后用户看到的还是旧 galaxy.js（环还在），
       *   还以为桌面快捷方式没更新。ETag 已在（96 行），no-cache 只多一次往返，
       *   正确性优先；大体积贴图（.jpg 等）保留 300s 浏览器缓存不动。 */
      'cache-control': (ext === '.html' || ext === '.js' || ext === '.mjs' || ext === '.css')
        ? 'no-cache' : 'public, max-age=300',
      'access-control-allow-origin': '*',
    });
    if (req.method === 'HEAD') { res.end(); return true; }
    createReadStream(file).pipe(res);
    return true;
  } catch { return false; }
}

/**
 * 这个路径看起来是在要一个静态资源，还是在做页面导航？
 * 判断依据：末段带一个我们认识的扩展名（.jpg / .js / .json …）。
 */
const ASSET_EXT = new Set(Object.keys(MIME));
function looksLikeAsset(urlPath) {
  const base = urlPath.slice(urlPath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;            // 没有扩展名，或以 . 开头的隐藏段
  return ASSET_EXT.has(base.slice(dot).toLowerCase());
}

/* ---------------- 检索缓存 ---------------- */
const searchCache = new Map();
const SEARCH_TTL = 10 * 60 * 1000;

function cacheKey(q, opts) { return `${q}|${opts.limit}|${opts.sort}|${opts.astroOnly}`; }

async function handleResearch(url, res, req) {
  const q = url.searchParams.get('q') || '';
  const opts = {
    limit: Math.min(40, Math.max(4, Number(url.searchParams.get('limit')) || 24)),
    sort: url.searchParams.get('sort') || 'relevance',
    astroOnly: url.searchParams.get('astro') !== '0',
  };
  if (!q.trim()) return fail(res, 400, '缺少检索词 q');
  const key = cacheKey(q, opts);
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < SEARCH_TTL) return json(res, 200, { ok: true, cached: true, ...hit.data });
  const t0 = Date.now();
  try {
    const data = await searchPapers(q, opts);
    searchCache.set(key, { at: Date.now(), data });
    if (searchCache.size > 200) searchCache.delete(searchCache.keys().next().value);
    // 四源检索总会有个别源超时/限流，那不是错误而是常态——只记下来，方便看"哪个源最近老不出活"
    const partial = (data.errors && Object.keys(data.errors).length) ? data.errors : null;
    log.info('论文检索', { q, limit: opts.limit, hits: (data.results || []).length, ms: Date.now() - t0, ...(partial ? { errors: partial } : {}) });
    json(res, 200, { ok: true, cached: false, ...data });
  } catch (e) {
    log.exception('论文检索失败', e);
    throw e;
  }
}

/* ---------------- 主处理 ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' });
      return res.end();
    }

    if (p === '/api/diag') {
      // 前端把用户操作轨迹打过来。这是排查"用户说点了没反应"的第二只手电筒——
      // 第一只手电筒是服务端日志，但它看不见前端做了什么。
      log.debug('前端轨迹', { m: url.searchParams.get('m') || '', from: req.headers.referer || '' });
      res.writeHead(204, { 'access-control-allow-origin': '*' }).end();
      return;
    }

    /* ---------------- 日志与自检 ---------------- */
    if (p === '/api/logs') {
      const n = Math.min(2000, Math.max(1, Number(url.searchParams.get('n')) || 200));
      const level = url.searchParams.get('level') || 'debug';
      // 优先用内存缓冲；进程刚重启时缓冲是空的，退回读今天的日志文件。
      const ring = log.tail(n, level);
      const records = ring.length ? ring : log.tailFile(n, level);
      return json(res, 200, {
        ok: true, file: path.relative(ROOT, log.file), writable: log.writable,
        source: ring.length ? 'memory' : 'file', counts: log.counts(), records,
      });
    }

    if (p === '/api/selfcheck') {
      const r = await runSelfCheck(ROOT, { logger: log, port: actualPort });
      log.info('执行自检', { ok: r.ok, ...r.summary, ms: r.elapsedMs });
      return json(res, 200, r);
    }

    if (p === '/api/health') {
      let datasets = [];
      try {
        datasets = (await readdir(DATA)).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
      } catch { /* data 目录尚未生成 */ }
      return json(res, 200, {
        ok: true, service: '小小宇宙', version: '1.2.0', translate: true,
        engines: ['浏览器内置翻译（离线）', 'Google 公开接口', 'MyMemory 公开接口'],
        datasets, sources: ['arXiv', 'OpenAlex', 'Crossref', 'Semantic Scholar'],
      });
    }

    if (p === '/api/research/search') return await handleResearch(url, res, req);

    if (p === '/api/research/translate' && req.method === 'POST') {
      const body = await readBody(req);
      const texts = Array.isArray(body.texts) ? body.texts.slice(0, 24) : [];
      if (!texts.length) return fail(res, 400, '缺少 texts 数组');
      try {
        const items = await translateBatch(texts, { target: body.target || 'zh', source: body.source || 'en' });
        return json(res, 200, { ok: true, engine: 'server', items });
      } catch (e) {
        if (e.code === 'NO_ENGINE') return fail(res, 503, e.message, { code: 'NO_ENGINE' });
        throw e;
      }
    }

    if (p === '/api/research/summarize' && req.method === 'POST') {
      const body = await readBody(req);
      const papers = Array.isArray(body.papers) ? body.papers.slice(0, 8) : [];
      if (!papers.length) return fail(res, 400, '缺少 papers');
      try {
        const md = await summarizeProgress(body.topic || '该天体', papers);
        return json(res, 200, { ok: true, markdown: md, engine: 'local-extractive' });
      } catch (e) {
        return fail(res, 500, e.message);
      }
    }

    if (p === '/api/data/manifest') {
      const out = {};
      try {
        for (const f of await readdir(DATA)) {
          if (!f.endsWith('.json')) continue;
          const s = await stat(path.join(DATA, f));
          out[f] = s.size;
        }
      } catch { /* ignore */ }
      return json(res, 200, { ok: true, files: out });
    }

    /* ---------------- 数据更新中心 ---------------- */

    if (p === '/api/data/status') {
      try {
        return json(res, 200, await sourceStatus(ROOT));
      } catch (e) {
        if (e.code === 'NO_REGISTRY') return fail(res, 500, '缺少 data/sources.json，数据更新中心不可用');
        throw e;
      }
    }

    /** SSE：更新过程逐行回传，前端不必盯着空白转圈 */
    if (p === '/api/data/update/stream') {
      const pipeline = url.searchParams.get('pipeline') || '';
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no',
        'access-control-allow-origin': '*',
      });
      const send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* 客户端已断开 */ } };

      if (isRunning()) {
        send({ type: 'error', code: 'BUSY', message: `已有管线「${isRunning()}」在运行` });
        log.warn('更新被拒：有管线在跑', { wanted: pipeline, running: isRunning() });
        return res.end();
      }
      send({ type: 'open', pipeline });
      const t0 = Date.now();
      log.info('开始更新管线', { pipeline });
      try {
        const result = await runPipeline(ROOT, pipeline, ({ stream, line }) => send({ type: 'log', stream, line }));
        const ok = result.ok !== false;
        if (ok) log.info('管线更新完成', { pipeline, ms: Date.now() - t0 });
        else log.error('管线更新未完成', { pipeline, ms: Date.now() - t0, failedStep: result.failedStep });
        send({ type: 'done', ok, result });
      } catch (e) {
        log.exception('管线更新异常', e);
        send({ type: 'error', code: e.code || 'FAILED', message: e.message });
      }
      return res.end();
    }

    if (p === '/api/data/update' && req.method === 'POST') {
      const body = await readBody(req);
      if (isRunning()) return fail(res, 409, `已有管线「${isRunning()}」在运行`, { code: 'BUSY' });
      const t0 = Date.now();
      log.info('开始更新管线（非流式）', { pipeline: body.pipeline || '' });
      try {
        const result = await runPipeline(ROOT, body.pipeline || '', () => {});
        log.info('管线更新完成（非流式）', { pipeline: body.pipeline || '', ms: Date.now() - t0 });
        return json(res, 200, { ok: true, result });
      } catch (e) {
        log.exception('管线更新失败（非流式）', e);
        if (e.code === 'UNKNOWN_PIPELINE') return fail(res, 400, e.message, { code: e.code });
        if (e.code === 'BAD_STEP') return fail(res, 400, e.message, { code: e.code });
        if (e.code === 'BUSY') return fail(res, 409, e.message, { code: e.code });
        throw e;
      }
    }

    if (p === '/api/data/watch/topics') {
      const t = await listWatchTopics(ROOT);
      return json(res, 200, { ok: true, defaults: t.defaults, topics: t.topics });
    }

    if (p === '/api/data/watch/queue') {
      const q = await readQueue(ROOT);
      return json(res, 200, {
        ok: true,
        lastScan: q.lastScan || null,
        lastScanAdded: q.lastScanAdded ?? null,
        candidates: q.candidates || [],
        pending: (q.candidates || []).filter((c) => c.status === 'pending').length,
      });
    }

    if (p === '/api/data/watch/scan' && req.method === 'POST') {
      try {
        const r = await scanResearch(ROOT, () => {});
        return json(res, 200, r);
      } catch (e) {
        if (e.code === 'NO_TOPICS') return fail(res, 500, '缺少 data/watch-topics.json');
        throw e;
      }
    }

    if (p === '/api/data/watch/dismiss' && req.method === 'POST') {
      const body = await readBody(req);
      try { return json(res, 200, await dismissCandidate(ROOT, body.id)); }
      catch (e) { return fail(res, e.code === 'NOT_FOUND' ? 404 : 400, e.message); }
    }

    if (p === '/api/data/watch/clear' && req.method === 'POST') {
      return json(res, 200, await clearDismissed(ROOT));
    }

    if (p === '/api/data/overrides') {
      if (req.method === 'GET') return json(res, 200, { ok: true, ...(await readOverrides(ROOT)) });
      if (req.method === 'POST') {
        const body = await readBody(req);
        try { return json(res, 200, await addOverride(ROOT, body)); }
        catch (e) { return fail(res, e.code === 'BAD_INPUT' ? 400 : 500, e.message); }
      }
    }

    if (p === '/api/data/overrides/remove' && req.method === 'POST') {
      const body = await readBody(req);
      try { return json(res, 200, await removeOverride(ROOT, body.id)); }
      catch (e) { return fail(res, e.code === 'NOT_FOUND' ? 404 : 400, e.message); }
    }

    if (p.startsWith('/api/')) return fail(res, 404, `未知接口 ${p}`);

    if (await serveStatic(req, res, p)) return;

    // SPA 回退只管「页面导航」。带已知扩展名的路径是在要静态资源，
    // 找不到就应该老实报 404 —— 回退成 index.html 会让浏览器把一坨 HTML
    // 当成图片或脚本去解码，把「贴图名写错了」这种硬错误变成静默故障。
    if (looksLikeAsset(p)) {
      // 这不是噪声，是硬错误：前端按名字找贴图/脚本，找不到说明名字写错了或文件没打包进来。
      log.warn('静态资源缺失', { path: p });
      return fail(res, 404, `静态资源不存在：${p}`);
    }

    const index = path.join(WEB, 'index.html');
    const html = await readFile(index);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
  } catch (e) {
    log.exception('请求处理异常', e, { method: req.method, url: req.url });
    if (!res.headersSent) fail(res, 500, e.message || '内部错误');
  }
});

function listen(port, attempt = 0) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && attempt < 12) {
      log.warn('端口被占用，顺延重试', { port, next: port + 1 });
      listen(port + 1, attempt + 1);
    } else {
      log.exception('服务监听失败，进程退出', e, { port });
      process.exit(1);
    }
  });
  server.listen(port, HOST, async () => {
    actualPort = port;
    // `data/.port` 只记「日常那个服务」的端口，供自检的 svc.port 比对。
    // ⚠️ 检查脚本自管的临时服务器**必须**跳过这一步（env LC_NO_PORT_RECORD=1）：
    //    它们跑在 8792+ 的临时端口上、几秒后就退出，如果也往这里写，
    //    日常服务（8787）再启动时自检就会报「端口与记录不一致」——
    //    一个由**测试工具自己制造**的假告警。误报会训练人忽略自检。
    if (process.env.LC_NO_PORT_RECORD !== '1') {
      try { await writeFile(path.join(DATA, '.port'), String(port), 'utf8'); } catch { /* 只读目录时忽略 */ }
    }
    log.info('服务已启动', { host: HOST, port, pid: process.pid, node: process.versions.node });
    console.log('');
    console.log('  ╭──────────────────────────────────────────────╮');
    console.log('  │   小小宇宙 · Little Cosmos                   │');
    console.log('  ╰──────────────────────────────────────────────╯');
    console.log(`  地址   http://${HOST}:${port}`);
    console.log('  翻译   浏览器内置翻译优先（离线）；不可用时自动回退公共翻译接口');
    console.log('  简报   本地抽取式摘要，不需要任何 API Key');
    console.log(`  日志   ${path.relative(ROOT, log.file)}${log.writable ? '' : '（目录不可写，仅控制台）'}`);
    console.log('  按 Ctrl+C 停止');
    console.log('');
  });
}

listen(PORT);

process.on('SIGINT', async () => {
  log.warn('收到 Ctrl+C，正在关闭');
  console.log('\n正在关闭…');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
});
