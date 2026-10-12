/** 导航：宇宙尺度条 + 当前层级的视角按钮 + 目的地搜索 + 命令面板（Ctrl+K） */
import { VIEW_ENTRIES, viewsForLevel } from '../data/dataset.js';
import { SCALE_CHAIN, SCALE_BY_ID } from '../core/scales.js';
import { esc } from '../util/fmt.js';

export class Nav {
  constructor(app) {
    this.app = app;
    this.scaleEl = document.getElementById('scale-nav');
    this.navEl = document.getElementById('level-nav');
    this.input = document.getElementById('dest-input');
    this.results = document.getElementById('dest-results');
    this.palette = document.getElementById('palette');
    this.paletteInput = document.getElementById('palette-input');
    this.paletteList = document.getElementById('palette-list');
    this.crumb = document.getElementById('crumb');
    this.activeIndex = -1;
    this.mode = 'dest';
    this.views = [];
    this.#buildScaleBar();
    this.#buildViews('solar');
    this.#bind();
  }

  /** 宇宙尺度条：六档尺度，点一下直接跳 */
  #buildScaleBar() {
    if (!this.scaleEl) return;
    this.scaleEl.innerHTML = SCALE_CHAIN.map((s) =>
      `<button data-scale="${s.id}" title="${esc(s.subtitle)}\n${esc(s.unitNote)}">
        <span class="nm">${esc(s.name)}</span><small>${esc(s.unit)}</small>
      </button>`).join('');
    this.scaleEl.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-scale]');
      if (btn) this.app.gotoScale(btn.dataset.scale);
    });
  }

  /** 重建当前层级可用的视角按钮 */
  #buildViews(levelId) {
    this.views = viewsForLevel(levelId);
    if (!this.navEl) return;
    this.navEl.innerHTML = this.views
      .map((v, i) => `<button data-view="${v.view}" data-i="${i}" title="${esc(v.sub)}">${esc(v.name)}</button>`)
      .join('');
  }

  /** 当前层级的视角预设（数字键 1–9 用） */
  currentViews() { return this.views; }

  /** 引擎切层时调用：更新尺度条高亮与视角按钮 */
  onLevel(level) {
    this.#buildViews(level?.id || 'solar');
    this.syncScaleBar();
    const s = SCALE_BY_ID.get(level?.id);
    if (s) this.setCrumb(s.name, s.subtitle);
  }

  /** 同步尺度条的高亮状态（含「上一档/下一档」是否可用的提示） */
  syncScaleBar() {
    if (!this.scaleEl) return;
    const cur = this.app.engine?.current?.id;
    for (const b of this.scaleEl.querySelectorAll('button[data-scale]')) {
      b.classList.toggle('active', b.dataset.scale === cur);
    }
    const out = document.getElementById('zoom-out');
    const inn = document.getElementById('zoom-in');
    if (out) out.disabled = !this.app.engine?.canZoomOut;
    if (inn) inn.disabled = !this.app.engine?.canZoomIn;
  }

  setActiveView(view) {
    for (const b of this.navEl.querySelectorAll('button')) b.classList.toggle('active', b.dataset.view === view);
    const entry = this.views.find((v) => v.view === view);
    if (entry) this.setCrumb(entry.name, entry.sub);
  }

  setCrumb(title, sub = '') {
    this.crumb.innerHTML = `<b>${esc(title)}</b>${sub ? `<span>·</span><span>${esc(sub)}</span>` : ''}` +
      '<span class="hint">· 拖动旋转 · 滚轮缩放 · 点击天体看资料</span>';
  }

  #bind() {
    // 视角按钮（每次切层会重建按钮，所以用事件委托，只绑一次）
    this.navEl.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-view]');
      if (btn) this.app.setView(btn.dataset.view);
    });

    this.input.addEventListener('input', () => this.#renderResults(this.input.value, 'dest'));
    this.input.addEventListener('focus', () => this.#renderResults(this.input.value, 'dest'));
    this.input.addEventListener('keydown', (e) => this.#onKey(e, 'dest'));
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.dest')) this.results.hidden = true;
    });

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); this.openPalette(); }
      else if (e.key === 'Escape') { this.closePalette(); this.results.hidden = true; }
      else if (e.key === '/' && document.activeElement === document.body) { e.preventDefault(); this.openPalette(); }
    });
    this.palette.addEventListener('click', (e) => { if (e.target === this.palette) this.closePalette(); });
    this.paletteInput.addEventListener('input', () => this.#renderResults(this.paletteInput.value, 'palette'));
    this.paletteInput.addEventListener('keydown', (e) => this.#onKey(e, 'palette'));
  }

  openPalette() {
    this.palette.hidden = false;
    this.paletteInput.value = '';
    this.#renderResults('', 'palette');
    this.paletteInput.focus();
  }

  closePalette() {
    this.palette.hidden = true;
    this.activeIndex = -1;
  }

  #commands() {
    const scaleCmds = SCALE_CHAIN.map((s, i) => ({
      id: `cmd-scale-${s.id}`,
      name: `尺度：${s.name}`,
      type: 'cmd',
      typeLabel: '尺度',
      sub: s.subtitle,
      action: () => this.app.gotoScale(s.id),
      _order: i,
    }));
    const header = { id: 'cmd-header-scale', name: `—— 宇宙尺度（共 ${SCALE_CHAIN.length} 层，滚轮拉到底也可切换）——`, type: 'head', typeLabel: '' };
    return [
      ...scaleCmds,
      header,
      { id: 'cmd-earth', name: '聚焦：地球', type: 'cmd', action: () => this.app.gotoDestination('earth'), typeLabel: '指令', sub: '' },
      { id: 'cmd-catalog', name: '打开：天体目录', type: 'cmd', action: () => this.app.ui.catalog.show(), typeLabel: '面板', sub: '含过于渺小已隐藏的天体' },
      { id: 'cmd-research', name: '打开：研究前沿（论文检索）', type: 'cmd', action: () => this.app.ui.research.open(), typeLabel: '面板', sub: '' },
      { id: 'cmd-datacenter', name: '打开：数据更新中心', type: 'cmd', action: () => this.app.ui.datacenter?.open(), typeLabel: '面板', sub: '数据源状态 · 一键重抓 · 最新科研监测' },
      { id: 'cmd-settings', name: '打开：设置（含显卡与性能）', type: 'cmd', action: () => this.app.ui.hud.open(), typeLabel: '面板', sub: '' },
      { id: 'cmd-play', name: '播放 / 暂停时间', type: 'cmd', action: () => this.app.ui.hud.togglePlay(), typeLabel: '指令', sub: '空格' },
      { id: 'cmd-now', name: '时间回到此刻', type: 'cmd', action: () => this.app.clock.now(), typeLabel: '指令', sub: '' },
      { id: 'cmd-zoomout', name: '拉远到更大尺度', type: 'cmd', action: () => this.app.engine.zoomOut(), typeLabel: '指令', sub: 'PageUp' },
      { id: 'cmd-zoomin', name: '拉近到更小尺度', type: 'cmd', action: () => this.app.engine.zoomIn(), typeLabel: '指令', sub: 'PageDown' },
    ];
  }

  #renderResults(query, mode) {
    this.mode = mode;
    const box = mode === 'dest' ? this.results : this.paletteList;
    const items = [...this.app.dataset.search(query, mode === 'dest' ? 9 : 14)];
    if (mode === 'palette') {
      const cmds = this.#commands().filter((c) => !query || c.name.includes(query) || c.id.includes(query));
      items.unshift(...cmds);
    }
    this.currentItems = items;
    this.activeIndex = items.length ? 0 : -1;
    if (!items.length) {
      box.innerHTML = `<div class="empty">没有找到「${esc(query)}」<br><small>试试：木卫二 / 土卫六 / 谷神星 / 哈雷彗星 / 地球</small></div>`;
      box.hidden = false;
      return;
    }
    box.innerHTML = items.map((it, i) => {
      if (it.type === 'head') return `<div class="row head"><span class="nm">${esc(it.name)}</span></div>`;
      const icon = ICONS[it.type] || '•';
      const scaleTag = it.levelName && !isSolarLevel(it.level)
        ? `<span class="lv">${esc(it.levelName)}</span>` : '';
      return `<div class="row${i === this.activeIndex ? ' active' : ''}" data-i="${i}">
        <span class="ic" style="width:18px;text-align:center;color:#67e8f9">${icon}</span>
        <span class="nm">${highlight(it.name, query)}${it.en && it.en !== it.name ? ` <span style="color:#64789a;font-size:11px">${esc(it.en)}</span>` : ''}${scaleTag}</span>
        <span class="sub">${esc(it.sub || it.typeLabel || '')}</span>
      </div>`;
    }).join('');
    box.hidden = false;
    box.querySelectorAll('.row:not(.head)').forEach((row) => {
      row.addEventListener('mouseenter', () => {
        this.activeIndex = Number(row.dataset.i);
        box.querySelectorAll('.row').forEach((r) => r.classList.toggle('active', r === row));
      });
      row.addEventListener('click', () => this.#choose(Number(row.dataset.i)));
    });
  }

  #onKey(e, mode) {
    const box = mode === 'dest' ? this.results : this.paletteList;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!this.currentItems?.length) return;
      this.activeIndex = (this.activeIndex + (e.key === 'ArrowDown' ? 1 : -1) + this.currentItems.length) % this.currentItems.length;
      box.querySelectorAll('.row').forEach((r, i) => r.classList.toggle('active', i === this.activeIndex));
      box.querySelectorAll('.row')[this.activeIndex]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (this.activeIndex >= 0) this.#choose(this.activeIndex);
    } else if (e.key === 'Escape') {
      if (mode === 'dest') { this.results.hidden = true; this.input.blur(); }
      else this.closePalette();
    }
  }

  #choose(i) {
    const item = this.currentItems?.[i];
    if (!item || item.type === 'head') return;
    this.results.hidden = true;
    this.closePalette();
    if (item.type === 'cmd') { item.action(); return; }
    // 视角与天体都交给 gotoDestination —— 它会处理跨尺度切层
    this.app.gotoDestination(item.id);
  }
}

/** 搜索结果里的类型图标 */
const ICONS = {
  cmd: '⌘', view: '◎', star: '✦', planet: '●', dwarf: '◍', moon: '○',
  asteroid: '⬤', comet: '☄', tno: '◇', region: '▢', probe: '⛭', ring: '◌',
  galaxy: '🌀', cluster: '❋', supercluster: '✦', group: '❋', dwarfgalaxy: '🌀',
  spiral: '🌀', elliptical: '⬭', irregular: '🌀', attractor: '🕳',
  filament: '〰', cmb: '◯', core: '◉', arm: '〰', halo: '◎', stream: '≈',
  globular: '❋', opencluster: '✧', nebula: '☁', planetarynebula: '◎',
  snr: '💥', doublestar: '⁂', exoplanet: '🪐',
};

function isSolarLevel(level) { return !level || level === 'solar'; }

function highlight(text, query) {
  const q = String(query || '').trim();
  if (!q) return esc(text);
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return esc(text);
  return `${esc(text.slice(0, i))}<em>${esc(text.slice(i, i + q.length))}</em>${esc(text.slice(i + q.length))}`;
}
