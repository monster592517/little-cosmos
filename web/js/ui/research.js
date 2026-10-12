/** 研究前沿面板：自建论文搜索引擎 + 中文翻译 + 本地进展简报 */
import { esc, num } from '../util/fmt.js';
import { translator } from '../core/translator.js';

const ALL_SOURCES = ['arXiv', 'OpenAlex', 'Crossref', 'Semantic Scholar'];

export class Research {
  constructor(app) {
    this.app = app;
    this.query = '';
    this.sort = 'relevance';
    this.sources = new Set(ALL_SOURCES);
    this.papers = [];
    this.translated = new Map();
    this.state = new Map();
    this.loading = false;
    this.engine = 'server';
  }

  async checkHealth() {
    try {
      const r = await fetch('/api/health').then((x) => x.json());
      this.serverTranslate = Boolean(r.translate);
    } catch { this.serverTranslate = false; }
    this.engine = await translator.availability();
  }

  get engineNote() {
    if (this.engine === 'browser') {
      return '翻译使用<b style="color:#67e8f9">浏览器内置翻译</b>（本地模型，可离线，不联网、不消耗任何额度）。';
    }
    return '翻译优先使用<b style="color:#67e8f9">浏览器内置翻译</b>；当前浏览器未启用该能力，将回退到<b style="color:#67e8f9">公共翻译接口</b>（无需 API Key）。'
      + '若译文长时间无响应，可用每条结果右下角的「整页翻译」交给浏览器自带翻译。';
  }

  open(query = '', topicName = '') {
    this.query = query || this.query;
    this.topicName = topicName;
    this.#render();
    if (this.query && (!this.papers.length || this.lastQuery !== this.query)) this.search(this.query);
  }

  #render() {
    this.app.ui.panel.open('研究前沿 · 论文检索', `
      <div class="research-search">
        <input id="rs-input" type="search" placeholder="检索论文：木星磁层 / Europa ocean / TRAPPIST-1 atmosphere…" value="${esc(this.query)}" autocomplete="off">
        <button class="primary" id="rs-go">检索</button>
      </div>
      <div class="filters" id="rs-sources">
        ${ALL_SOURCES.map((s) => `<span class="chip${this.sources.has(s) ? ' on' : ''}" data-src="${s}">${s}</span>`).join('')}
      </div>
      <div class="filters" id="rs-sort">
        <span class="chip${this.sort === 'relevance' ? ' on' : ''}" data-sort="relevance">相关度</span>
        <span class="chip${this.sort === 'recent' ? ' on' : ''}" data-sort="recent">最新</span>
        <span class="chip${this.sort === 'cited' ? ' on' : ''}" data-sort="cited">引用最多</span>
      </div>
      <div class="note" id="rs-status">${this.engineNote}</div>
      <div id="rs-results"></div>
    `);
    this.#bind();
    if (this.papers.length) this.#renderResults();
  }

  #bind() {
    const body = this.app.ui.panel.bodyEl;
    const input = body.querySelector('#rs-input');
    body.querySelector('#rs-go').addEventListener('click', () => this.search(input.value));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.search(input.value); });
    body.querySelectorAll('#rs-sources .chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const s = chip.dataset.src;
        if (this.sources.has(s)) this.sources.delete(s); else this.sources.add(s);
        if (!this.sources.size) this.sources.add(s);
        chip.classList.toggle('on', this.sources.has(s));
      });
    });
    body.querySelectorAll('#rs-sort .chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        this.sort = chip.dataset.sort;
        body.querySelectorAll('#rs-sort .chip').forEach((c) => c.classList.toggle('on', c === chip));
        if (this.papers.length) this.search(this.query);
      });
    });
  }

  async search(query, { silent = false } = {}) {
    const q = String(query || '').trim();
    if (!q) return;
    this.query = q;
    this.lastQuery = q;
    this.loading = true;
    const status = this.app.ui.panel.bodyEl.querySelector('#rs-status');
    const results = this.app.ui.panel.bodyEl.querySelector('#rs-results');
    if (status) status.innerHTML = `<span class="spinner"></span> 正在检索 ${[...this.sources].join(' · ')} …`;
    if (results) results.innerHTML = '';
    try {
      const url = `/api/research/search?q=${encodeURIComponent(q)}&limit=24&sort=${this.sort}`;
      const data = await fetch(url).then((r) => r.json());
      this.papers = data.results || [];
      this.state.clear();
      const srcInfo = Object.entries(data.sources || {}).map(([k, v]) => `${k} ${v}`).join(' · ');
      if (status) {
        status.innerHTML = `命中 <b style="color:#67e8f9">${this.papers.length}</b> 篇${data.englishQuery && data.englishQuery !== q ? `（英文检索词：<b>${esc(data.englishQuery)}</b>）` : ''}<br><span style="opacity:.7">来源：${esc(srcInfo)}${(data.errors || []).length ? ' · 部分源暂不可用：' + esc(data.errors.join('；')) : ''}</span>`;
      }
      this.#renderResults();
    } catch (e) {
      if (status) status.innerHTML = `<span style="color:#ffb4b4">检索失败：${esc(e.message)}</span>`;
    } finally {
      this.loading = false;
    }
  }

  #renderResults() {
    const box = this.app.ui.panel.bodyEl.querySelector('#rs-results');
    if (!box) return;
    if (!this.papers.length) { box.innerHTML = '<div class="note">没有结果。</div>'; return; }
    box.innerHTML = `
      <div class="btn-row" style="margin:0 0 12px">
        <button class="ghost small" id="rs-translate-all">翻译前 8 篇摘要</button>
        <button class="ghost small" id="rs-summary">生成进展简报（本地，不联网）</button>
      </div>
      ${this.papers.map((p, i) => this.#paperCard(p, i)).join('')}
      <div id="rs-summary-box"></div>`;

    box.querySelector('#rs-translate-all')?.addEventListener('click', () => {
      this.papers.slice(0, 8).forEach((p, i) => this.translateOne(i));
    });
    box.querySelector('#rs-summary')?.addEventListener('click', () => this.#summary());
    box.querySelectorAll('[data-translate]').forEach((btn) => {
      btn.addEventListener('click', () => this.translateOne(Number(btn.dataset.translate)));
    });
    box.querySelectorAll('[data-toggle]').forEach((el) => {
      el.addEventListener('click', () => {
        const abs = box.querySelector(`#abs-${el.dataset.toggle}`);
        abs?.classList.toggle('open');
        el.textContent = abs?.classList.contains('open') ? '收起' : '展开';
      });
    });
  }

  #paperCard(p, i) {
    const st = this.state.get(i) || {};
    const zh = this.translated.get(i);
    const authors = (p.authors || []).slice(0, 4).join('、') + ((p.authors || []).length > 4 ? ' 等' : '');
    return `<div class="paper">
      <h4>${esc(p.title)}</h4>
      <div class="meta">
        <span class="src">${esc(p.source)}</span>
        ${p.alsoIn?.length ? `<span style="opacity:.6">＋${esc(p.alsoIn.join('/'))}</span>` : ''}
        <span>${p.year ?? '—'}</span>
        ${p.venue ? `<span>${esc(p.venue)}</span>` : ''}
        ${p.citations ? `<span>被引 ${num(p.citations, 0)}</span>` : ''}
      </div>
      ${authors ? `<div class="meta" style="margin-top:-3px">${esc(authors)}</div>` : ''}
      ${p.abstract ? `<div class="abs${st.open ? ' open' : ''}" id="abs-${i}">${esc(zh || p.abstract)}</div>` : '<div class="note">该来源未提供摘要，可打开原文查看。</div>'}
      <div class="paper-actions">
        ${p.abstract ? `<button data-translate="${i}" class="${zh ? 'on' : ''}">${zh ? '已翻译' : '译为中文'}</button>` : ''}
        ${p.abstract ? `<span class="abs-toggle" data-toggle="${i}" style="align-self:center">展开</span>` : ''}
        ${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">原文</a>` : ''}
        ${p.url ? `<a href="${esc(translator.pageTranslateUrl(p.url))}" target="_blank" rel="noopener" title="交给浏览器自带的整页翻译">整页翻译</a>` : ''}
        ${p.pdf ? `<a href="${esc(p.pdf)}" target="_blank" rel="noopener">PDF</a>` : ''}
        ${p.doi ? `<a href="https://doi.org/${esc(p.doi)}" target="_blank" rel="noopener">DOI</a>` : ''}
      </div>
    </div>`;
  }

  async translateOne(i) {
    const p = this.papers[i];
    if (!p?.abstract) return;
    if (this.translated.has(i)) return;
    const box = this.app.ui.panel.bodyEl.querySelector(`#abs-${i}`);
    if (box) box.innerHTML = '<span class="spinner"></span> 翻译中…';
    try {
      const r = await translator.translate(p.abstract, { target: 'zh', source: 'en' });
      if (r.text) {
        this.translated.set(i, r.text);
        if (box) { box.textContent = r.text; box.classList.add('zh'); }
        const btn = this.app.ui.panel.bodyEl.querySelector(`[data-translate="${i}"]`);
        if (btn) { btn.classList.add('on'); btn.textContent = '已翻译'; }
        const note = this.app.ui.panel.bodyEl.querySelector('#rs-status');
        if (note && r.engine) note.dataset.engine = r.engine;
      } else {
        if (box) box.textContent = p.abstract;
        this.app.toast('翻译失败', 'err');
      }
    } catch (e) {
      if (box) box.textContent = p.abstract;
      this.app.toast(`翻译失败：${e.message}（可点「整页翻译」用浏览器自带翻译）`, 'err');
    }
  }

  async #summary() {
    const box = this.app.ui.panel.bodyEl.querySelector('#rs-summary-box');
    if (!box) return;
    box.innerHTML = '<div class="note"><span class="spinner"></span> 正在本地生成抽取式简报…</div>';
    try {
      const r = await fetch('/api/research/summarize', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topic: this.topicName || this.query, papers: this.papers.slice(0, 8) }),
      }).then((x) => x.json());
      if (r.ok) box.innerHTML = `<div class="section"><h3>最新进展简报</h3><div class="progress-md">${mdToHtml(r.markdown)}</div></div>`;
      else box.innerHTML = `<div class="note" style="color:#ffb4b4">${esc(r.error || '生成失败')}</div>`;
    } catch (e) {
      box.innerHTML = `<div class="note" style="color:#ffb4b4">生成失败：${esc(e.message)}</div>`;
    }
  }
}

function mdToHtml(md) {
  const lines = String(md || '').split(/\r?\n/);
  let html = '', inList = false;
  for (const line of lines) {
    const l = line.trim();
    if (/^###\s+/.test(l)) { if (inList) { html += '</ul>'; inList = false; } html += `<h3>${esc(l.replace(/^###\s+/, ''))}</h3>`; }
    else if (/^##\s+/.test(l)) { if (inList) { html += '</ul>'; inList = false; } html += `<h2>${esc(l.replace(/^##\s+/, ''))}</h2>`; }
    else if (/^[-*]\s+/.test(l)) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${inline(l.replace(/^[-*]\s+/, ''))}</li>`; }
    else if (!l) { if (inList) { html += '</ul>'; inList = false; } }
    else { if (inList) { html += '</ul>'; inList = false; } html += `<p>${inline(l)}</p>`; }
  }
  if (inList) html += '</ul>';
  return html;
}
function inline(s) {
  return esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`(.+?)`/g, '<code>$1</code>');
}
