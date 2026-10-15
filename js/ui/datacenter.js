/**
 * 数据更新中心
 *
 *  四件事，按「诚实程度」排序：
 *   1. 看状态  —— 每个数据源现在是什么版本、多少条、什么时候构建的（现场读，不是缓存字段）
 *   2. 做更新  —— 一键重抓重建，日志流式回传，不再让人对着空白转圈
 *   3. 盯前沿  —— 按监测主题扫最新论文，把可能与本地数据冲突的结论摆进待复核队列
 *   4. 人拍板  —— 采纳 / 忽略。自动抓到的东西永远不会绕过这一步直接改程序数据
 *
 *  这里刻意不做的一件事：假装自己能读懂论文并自动判定冲突。
 *  监测结果只是「线索」，不是「结论」——界面上也是这么写的。
 */
import { esc } from '../util/fmt.js';

/**
 * 把 "web/js/data/solar-system.js → jupiter.moons" 解析成可编辑的实体与路径。
 * 实体名就在箭头后面那段的第一节（jupiter），剩下的是字段路径（moons）。
 * 中文描述型目标（如「各任务 status」）解析不出来，返回 null 交给人工填。
 */
function parseTarget(target) {
  if (typeof target !== 'string') return null;
  const field = (target.split('→')[1] || '').trim();
  if (!field || /[\u4e00-\u9fa5]/.test(field)) return null;
  const m = /^([A-Za-z_][A-Za-z0-9_:-]*)((?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])+)?$/.exec(field);
  if (!m) return null;
  const entityId = m[1];
  const path = (m[2] || '').replace(/^\./, '');
  return { entityId, path };
}

const fmtBytes = (n) => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
};

const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const ago = (iso) => {
  if (!iso) return '';
  const d = new Date(iso).getTime();
  if (!Number.isFinite(d)) return '';
  const days = Math.floor((Date.now() - d) / 86400000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${(days / 365).toFixed(1)} 年前`;
};

const MODE_LABEL = {
  fetch: { text: '可自动更新', cls: 'ok' },
  curated: { text: '人工维护', cls: 'warn' },
};

export class DataCenter {
  constructor(app) {
    this.app = app;
    this.status = null;
    this.queue = null;
    this.busy = false;
    this.src = null;       // 正在进行的 EventSource
    this._overrides = [];  // 已生效的人工修正
  }

  /* ---------------- 入口 ---------------- */
  async open() {
    const p = this.app.ui.panel;
    p.open('数据更新中心', '<div class="note">正在读取数据源状态…</div>');
    await this.loadOverridesList();
    await this.reload(true);
  }

  async reload(renderAll = false) {
    const p = this.app.ui.panel;
    try {
      const [st, q] = await Promise.all([
        fetch('/api/data/status', { cache: 'no-store' }).then((r) => r.json()),
        fetch('/api/data/watch/queue', { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ candidates: [] })),
      ]);
      this.status = st;
      this.queue = q;
    } catch (e) {
      p.open('数据更新中心', `
        <div class="section"><h3>无法连接本地服务</h3>
          <div class="note">
            数据更新中心需要本地服务支持。请用 <code>npm start</code>（或双击「启动小小宇宙.bat」）启动后，
            通过 <code>http://127.0.0.1:8787</code> 访问本程序。<br>
            错误：${esc(e.message)}
          </div>
        </div>`);
      return;
    }
    if (renderAll || !p.bodyEl.querySelector('#dc-root')) {
      p.open('数据更新中心', this.#html());
      this.#bind();
    } else {
      this.#patch();
    }
  }

  #patch() {
    const body = this.app.ui.panel.bodyEl;
    const root = body.querySelector('#dc-root');
    if (!root) { body.innerHTML = this.#html(); this.#bind(); return; }
    // 只重绘状态相关区块，避免打断日志区与已展开的表单
    const overview = root.querySelector('#dc-overview');
    const pipelines = root.querySelector('#dc-pipelines');
    const watch = root.querySelector('#dc-watch');
    const overrides = root.querySelector('#dc-overrides');
    const detail = root.querySelector('#dc-detail');
    if (overview) overview.innerHTML = this.#overviewHtml();
    if (pipelines) pipelines.innerHTML = this.#pipelinesHtml();
    if (watch) watch.innerHTML = this.#watchHtml();
    if (overrides) overrides.innerHTML = this.#overridesHtml();
    if (detail) detail.innerHTML = this.#detailHtml();
    this.#bind();
  }

  /* ---------------- 视图 ---------------- */
  #html() {
    return `<div id="dc-root">
      <div id="dc-overview">${this.#overviewHtml()}</div>
      <div id="dc-pipelines">${this.#pipelinesHtml()}</div>
      <div id="dc-logwrap" hidden>
        <div class="section"><h3>更新日志</h3>
          <div class="dc-log" id="dc-log"></div>
          <div class="btn-row"><button class="ghost" id="dc-log-clear">清空日志</button></div>
        </div>
      </div>
      <div id="dc-watch">${this.#watchHtml()}</div>
      <div id="dc-overrides">${this.#overridesHtml()}</div>
      <div id="dc-detail">${this.#detailHtml()}</div>
      <div id="dc-selfcheck">${this.#selfcheckHtml()}</div>
    </div>`;
  }

  #overviewHtml() {
    const s = this.status;
    if (!s) return '';
    const t = s.totals || {};
    const pend = (this.queue?.candidates || []).filter((c) => c.status === 'pending').length;
    return `<div class="section"><h3>概览</h3>
      <div class="dc-stats">
        <div class="dc-stat"><b>${t.datasets ?? 0}</b><span>数据源</span></div>
        <div class="dc-stat"><b>${t.fetchable ?? 0}</b><span>可自动更新</span></div>
        <div class="dc-stat"><b>${t.curated ?? 0}</b><span>人工维护</span></div>
        <div class="dc-stat"><b>${fmtBytes(t.bytes)}</b><span>数据体积</span></div>
        <div class="dc-stat ${pend ? 'hl' : ''}"><b>${pend}</b><span>待复核</span></div>
      </div>
      <div class="note" style="margin-top:10px">
        状态是<b>现场读取</b>的：文件的最后修改时间、体积、以及各数据集 meta 里记录的条目数。
        这里不缓存「上次更新于某日」这类字段——那种字段注定会过期，然后开始骗人。
      </div>
    </div>`;
  }

  #pipelinesHtml() {
    const s = this.status;
    if (!s) return '';
    return `<div class="section"><h3>更新管线</h3>
      <div class="note" style="margin-bottom:10px">
        更新以<b>管线</b>为单位，不以单个数据源为单位——恒星表与系外行星表共用同一条抓取链路，
        拆成互不相干的独立按钮只是视觉上的谎言。点「立即更新」会依次跑完该管线的全部步骤，
        任一步失败即中止，<b>原有数据保持不变</b>。
      </div>
      ${s.pipelines.map((p) => {
        const lr = p.lastRun;
        return `<div class="dc-pipe">
          <div class="dc-pipe-head">
            <div>
              <div class="dc-pipe-title">${esc(p.label)}</div>
              <div class="dc-pipe-sum">${esc(p.summary)}</div>
            </div>
            <button class="ghost dc-run" data-pipeline="${esc(p.id)}" ${this.busy ? 'disabled' : ''}>立即更新</button>
          </div>
          <div class="dc-pipe-meta">
            <span>耗时参考：${esc(p.durationHint || '—')}</span>
            <span>产出：${p.outputs.map((o) => `<code>${esc(o)}</code>`).join(' ')}</span>
          </div>
          ${lr ? `<div class="dc-pipe-run ${lr.ok ? 'ok' : 'err'}">
            ${lr.ok ? '✓ 上次更新成功' : `✗ 上次失败于「${esc(lr.failedStep || '未知步骤')}」`}
            · ${fmtDate(lr.at)}（${((lr.ms || 0) / 1000).toFixed(1)}s）
          </div>` : '<div class="dc-pipe-run">尚未通过本中心运行过</div>'}
        </div>`;
      }).join('')}
    </div>`;
  }

  #watchHtml() {
    const s = this.status;
    if (!s) return '';
    const cands = (this.queue?.candidates || []).filter((c) => c.status === 'pending');
    const done = (this.queue?.candidates || []).filter((c) => c.status !== 'pending');
    return `<div class="section"><h3>最新科研监测</h3>
      <div class="note" style="margin-bottom:10px">
        按 9 个「高风险主题」检索 arXiv 最新预印本，每篇必须<b>同时命中一个天体词与一个话题词</b>
        才会进入队列——只要求命中 <code>jwst</code> 这类泛词的话，半个宇宙的论文都会被塞进来。<br>
        <b>这不是自动判错。</b>监测器读不懂论文，它只负责把「可能与本地数据冲突」的线索摆到你面前，
        并指明可能受影响的具体字段。采纳与否由你决定。
      </div>
      <div class="btn-row">
        <button class="primary dc-scan" ${this.busy ? 'disabled' : ''}>扫描最新论文</button>
        <button class="ghost dc-subjects">查看监测主题</button>
        ${done.length ? '<button class="ghost dc-clear">清理已处理</button>' : ''}
      </div>
      <div class="dc-pipe-meta" style="margin-top:8px">
        <span>上次扫描：${this.queue?.lastScan ? `${fmtDate(this.queue.lastScan)}（新增 ${this.queue.lastScanAdded ?? 0} 条）` : '尚未扫描'}</span>
        <span>待复核 ${cands.length} 条 · 已处理 ${done.length} 条</span>
      </div>
      <div id="dc-subjects" hidden></div>
      ${cands.length ? cands.map((c) => this.#candHtml(c)).join('') : '<div class="dc-empty">队列是空的。点「扫描最新论文」去 arXiv 找找看。</div>'}
    </div>`;
  }

  #candHtml(c) {
    const riskCls = c.risk === '高' ? 'err' : c.risk === '中' ? 'warn' : '';
    // 从「可能影响」里挑一个能解析、且天体确实存在的目标作为预填，省得手打
    const guesses = (c.targets || []).map(parseTarget).filter(Boolean);
    const first = guesses.find((g) => this.app.dataset?.get(g.entityId)) || guesses[0] || { entityId: '', path: '' };
    const exists = first.entityId ? Boolean(this.app.dataset?.get(first.entityId)) : null;
    return `<div class="dc-cand" data-cand="${esc(c.id)}">
      <div class="dc-cand-head">
        <span class="dc-badge ${riskCls}">${esc(c.topicLabel)}</span>
        <span class="dc-badge">风险 ${esc(c.risk || '中')}</span>
        <span class="dc-cand-date">${esc(c.date || '')}</span>
        <span class="dc-rel">相关度 ${(c.relevance * 100) | 0}%</span>
      </div>
      <div class="dc-cand-title">${esc(c.title)}</div>
      <div class="dc-cand-authors">${esc((c.authors || []).slice(0, 4).join('、'))}${(c.authors || []).length > 4 ? ' 等' : ''}</div>
      <div class="dc-cand-abs">${esc((c.abstract || '').slice(0, 260))}${(c.abstract || '').length > 260 ? '…' : ''}</div>
      <div class="dc-cand-kw">
        命中天体词：${(c.matchedAnchors || []).map((k) => `<code>${esc(k)}</code>`).join(' ') || '—'}<br>
        命中话题词：${(c.matchedContext || []).map((k) => `<code>${esc(k)}</code>`).join(' ') || '—'}
      </div>
      ${c.targets?.length ? `<div class="dc-cand-targets">可能影响：${c.targets.map((t) => `<code>${esc(t)}</code>`).join(' ')}</div>` : ''}
      ${c.hint ? `<div class="dc-cand-hint">核查建议：${esc(c.hint)}</div>` : ''}
      <div class="btn-row">
        <button class="ghost dc-open">打开论文</button>
        <button class="ghost dc-accept">采纳为修正…</button>
        <button class="ghost dc-dismiss">忽略</button>
      </div>
      <div class="dc-acceptform" hidden>
        <div class="note" style="margin:6px 0">
          填写要改的字段。可选值只支持标量（字符串 / 数字 / 布尔）。
          修改会写入 <code>data/overrides.json</code>，在下次加载时生效，<b>不会改动源文件</b>。
        </div>
        <label class="dc-field">天体 id<input class="dc-in" data-k="entityId" value="${esc(first.entityId)}" placeholder="如 jupiter / bennu">${
          exists === true ? '<small class="dc-ok">✓ 该天体存在</small>'
          : exists === false ? '<small class="dc-bad">✗ 当前数据里找不到这个 id</small>' : ''}</label>
        <label class="dc-field">字段路径<input class="dc-in" data-k="path" value="${esc(first.path)}" placeholder="如 moons 或 facts[1]"></label>
        <label class="dc-field">新值<input class="dc-in" data-k="value" placeholder="如 293"></label>
        <label class="dc-field">备注<input class="dc-in" data-k="note" placeholder="为什么改（可留空）"></label>
        <div class="btn-row">
          <button class="primary dc-accept-go">确认采纳</button>
          <button class="ghost dc-accept-cancel">取消</button>
        </div>
      </div>
    </div>`;
  }

  #overridesHtml() {
    const list = this.status?.overrides || [];
    return `<div class="section"><h3>已生效的人工修正</h3>
      <div class="note" style="margin-bottom:8px">
        这些是人工采纳并已写入 <code>data/overrides.json</code> 的修正，加载时覆盖原始数据值。
      </div>
      <div id="dc-ovlist">${this.#ovListHtml()}</div>
    </div>`;
  }

  #ovListHtml() {
    const body = this.app.ui.panel.bodyEl;
    const list = this._overrides || [];
    if (!list.length) {
      const bad = this.app.dataset?.overridesFailed?.length || 0;
      return `<div class="dc-empty">当前没有人工修正。${bad ? `（本次加载有 ${bad} 条未能应用，见控制台）` : ''}</div>`;
    }
    return list.map((o) => `<div class="dc-ov">
      <code>${esc(o.entityId)}.${esc(o.path)}</code>
      <span class="dc-ov-val">${esc(String(o.value))}</span>
      <span class="dc-ov-note">${esc(o.note || '')}</span>
      <span class="dc-ov-date">${fmtDate(o.appliedAt)}</span>
      <button class="ghost dc-ov-del" data-ov="${esc(o.id)}">撤销</button>
    </div>`).join('');
  }

  #detailHtml() {
    const s = this.status;
    if (!s) return '';
    return `<div class="section"><h3>数据源明细</h3>
      <div class="dc-table">
        <div class="dc-tr dc-th">
          <span>数据源</span><span>类型</span><span>条目</span><span>体积</span><span>最后构建</span>
        </div>
        ${s.datasets.map((d) => {
          const m = MODE_LABEL[d.mode] || { text: d.mode, cls: '' };
          return `<div class="dc-tr">
            <span class="dc-name" title="${esc(d.note || '')}">${esc(d.label)}
              <small>${esc(d.provider)}${d.license ? ` · ${esc(d.license)}` : ''}</small></span>
            <span><span class="dc-badge ${m.cls}">${m.text}</span>
              ${d.pipeline ? `<small class="dc-pl">${esc(d.pipeline)}</small>` : ''}</span>
            <span>${d.records != null ? d.records.toLocaleString('en-US') : '—'}</span>
            <span>${fmtBytes(d.bytes)}</span>
            <span>${fmtDate(d.updatedAt)}<small>${ago(d.updatedAt)} · 节奏 ${esc(d.cadence || '—')}</small></span>
          </div>`;
        }).join('')}
      </div>
      <div class="note" style="margin-top:10px">
        「人工维护」的数据源无法自动重抓——它们的内容来自人工整理的资料表，
        只能靠科研监测产出线索、人工确认后以 overrides 落地。
      </div>
    </div>`;
  }

  /* ---------------- 系统自检 ---------------- */
  /**
   * 自检区块刻意做成「点了才跑」而不是打开面板就自动跑。
   * 原因：一次自检要遍历数据集、解析十来个 JSON、还要扫关键目录找旧名，实测 1–3 秒。
   * 把它塞进面板打开的路径上，等于每次开数据更新中心都先卡一下——这正是项目明令禁止的。
   */
  #selfcheckHtml() {
    return `<div class="section"><h3>系统自检</h3>
      <div class="note" style="margin-bottom:10px">
        六组检查：运行环境、程序骨架、数据集与登记表、人工覆盖与监测、本地服务、命名一致性。<br>
        每一项都带<b>「怎么办」</b>——只报「有问题」却不给处置办法的检查，等于给车主看仪表盘却把修理厂地址抠掉。
      </div>
      <div class="btn-row">
        <button class="primary dc-selfcheck">运行自检</button>
        <button class="ghost dc-logview">查看近期日志</button>
        <button class="ghost dc-logreload" hidden>刷新</button>
      </div>
      <div id="dc-sc-result"></div>
      <div id="dc-logview" hidden></div>
    </div>`;
  }

  #scResultHtml(r) {
    const s = r.summary || {};
    const head = `<div class="dc-stats" style="margin-top:12px">
      <div class="dc-stat"><b>${s.ok ?? 0}</b><span>通过</span></div>
      <div class="dc-stat ${s.warn ? 'hl' : ''}"><b>${s.warn ?? 0}</b><span>注意</span></div>
      <div class="dc-stat ${s.error ? 'hl' : ''}"><b>${s.error ?? 0}</b><span>故障</span></div>
    </div>
    <div class="sc-meta">${fmtDate(r.generatedAt)} · 耗时 ${r.elapsedMs} ms · ${
      r.ok ? '没有故障项' : `有 ${s.error} 项故障，按下面每条的「怎么办」处理`
    }</div>`;

    const body = (r.groups || []).map((g) => `<div class="sc-group">
      <div class="sc-group-title">${esc(g.label)}</div>
      ${g.checks.map((c) => `<div class="sc-item ${c.level === 'ok' ? '' : c.level}">
        <div class="sc-head">
          <span class="dc-badge ${c.level === 'ok' ? 'ok' : c.level === 'warn' ? 'warn' : 'err'}">${
            c.level === 'ok' ? '通过' : c.level === 'warn' ? '注意' : '故障'}</span>
          <span class="sc-title">${esc(c.title)}</span>
        </div>
        <div class="sc-detail">${esc(c.detail)}</div>
        ${c.level === 'ok' ? '' : `<div class="sc-fix"><b>怎么办：</b>${esc(c.fix)}</div>`}
      </div>`).join('')}
    </div>`).join('');

    return head + body;
  }

  #logViewHtml(r) {
    const rows = r.records || [];
    const counts = r.counts || {};
    if (!rows.length) return `<div class="dc-empty" style="margin-top:10px">今天的日志还是空的。</div>`;
    const lines = rows.map((x) => `<div class="log-row">
      <span class="log-t">${esc((x.t || '').slice(11, 19))}</span>
      <span class="log-lv ${esc(x.level)}">${esc(String(x.level).toUpperCase())}</span>
      <span class="log-msg">${esc(x.msg)}</span>
      ${x.data ? `<span class="log-data">${esc(JSON.stringify(x.data))}</span>` : ''}
    </div>`).join('');
    return `<div class="sc-meta" style="margin-top:10px">
      来源 ${esc(r.source)} · ${esc(r.file)}${r.writable ? '' : '（<b>目录不可写，已降级为仅控制台</b>）'} ·
      今日 ${counts.error || 0} 错误 / ${counts.warn || 0} 警告 / ${counts.info || 0} 信息
    </div>
    <div class="log-view">${lines}</div>`;
  }

  async #runSelfCheck() {
    const box = this.app.ui.panel.bodyEl?.querySelector('#dc-sc-result');
    const btn = this.app.ui.panel.bodyEl?.querySelector('.dc-selfcheck');
    if (!box) return;
    if (btn) { btn.disabled = true; btn.textContent = '自检中…'; }
    box.innerHTML = '<div class="note" style="margin-top:10px">正在检查…（要遍历数据集与文件，通常 1–3 秒）</div>';
    try {
      const r = await fetch('/api/selfcheck', { cache: 'no-store' }).then((x) => x.json());
      box.innerHTML = this.#scResultHtml(r);
      this.app.toast(r.ok ? '自检完成，没有故障项' : `自检发现 ${r.summary.error} 项故障`, r.ok ? '' : 'err');
    } catch (e) {
      box.innerHTML = `<div class="note" style="margin-top:10px">自检失败：${esc(e.message)}</div>`;
      this.app.toast('自检失败', 'err');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '运行自检'; }
    }
  }

  async #toggleLogs() {
    const box = this.app.ui.panel.bodyEl?.querySelector('#dc-logview');
    const reload = this.app.ui.panel.bodyEl?.querySelector('.dc-logreload');
    if (!box) return;
    if (!box.hidden) { box.hidden = true; if (reload) reload.hidden = true; return; }
    box.hidden = false;
    if (reload) reload.hidden = false;
    box.innerHTML = '<div class="note">读取日志…</div>';
    try {
      const r = await fetch('/api/logs?n=300', { cache: 'no-store' }).then((x) => x.json());
      box.innerHTML = this.#logViewHtml(r);
    } catch (e) {
      box.innerHTML = `<div class="note">读取失败：${esc(e.message)}</div>`;
    }
  }

  async #reloadLogs() {
    const box = this.app.ui.panel.bodyEl?.querySelector('#dc-logview');
    if (!box) return;
    box.innerHTML = '<div class="note">读取日志…</div>';
    try {
      const r = await fetch('/api/logs?n=300', { cache: 'no-store' }).then((x) => x.json());
      box.innerHTML = this.#logViewHtml(r);
    } catch (e) {
      box.innerHTML = `<div class="note">读取失败：${esc(e.message)}</div>`;
    }
  }

  /* ---------------- 交互 ---------------- */
  /**
   * 事件绑定。
   * 每次重绘区块后都要重新绑——区块是整体 innerHTML 替换的，旧节点连同监听器一起没了，
   * 所以这里不做「防重复绑定」标记（那样反而会让新按钮失效）。
   */
  #bind() {
    const body = this.app.ui.panel.bodyEl;
    if (!body) return;

    body.querySelectorAll('.dc-run').forEach((b) => b.addEventListener('click', () => this.#runPipeline(b.dataset.pipeline)));
    body.querySelector('.dc-scan')?.addEventListener('click', () => this.#scan());
    body.querySelector('.dc-subjects')?.addEventListener('click', () => this.#toggleSubjects());
    body.querySelector('.dc-clear')?.addEventListener('click', () => this.#clearDismissed());
    body.querySelector('.dc-selfcheck')?.addEventListener('click', () => this.#runSelfCheck());
    body.querySelector('.dc-logview')?.addEventListener('click', () => this.#toggleLogs());
    body.querySelector('.dc-logreload')?.addEventListener('click', () => this.#reloadLogs());
    body.querySelector('#dc-log-clear')?.addEventListener('click', () => {
      const log = body.querySelector('#dc-log'); if (log) log.innerHTML = '';
    });

    body.querySelectorAll('.dc-cand').forEach((card) => {
      const id = card.dataset.cand;
      card.querySelector('.dc-open')?.addEventListener('click', () => {
        const c = this.#cand(id);
        if (c?.url) window.open(c.url, '_blank', 'noopener');
      });
      card.querySelector('.dc-dismiss')?.addEventListener('click', () => this.#dismiss(id));
      card.querySelector('.dc-accept')?.addEventListener('click', () => {
        const f = card.querySelector('.dc-acceptform');
        if (f) f.hidden = !f.hidden;
      });
      card.querySelector('.dc-accept-cancel')?.addEventListener('click', () => {
        const f = card.querySelector('.dc-acceptform'); if (f) f.hidden = true;
      });
      card.querySelector('.dc-accept-go')?.addEventListener('click', () => this.#accept(card));
    });

    body.querySelectorAll('.dc-ov-del').forEach((b) => b.addEventListener('click', () => this.#deleteOverride(b.dataset.ov)));
  }

  #cand(id) { return (this.queue?.candidates || []).find((c) => c.id === id); }

  async #toggleSubjects() {
    const box = this.app.ui.panel.bodyEl.querySelector('#dc-subjects');
    if (!box) return;
    if (!box.hidden) { box.hidden = true; return; }
    box.hidden = false;
    if (box.dataset.loaded === '1') return;
    box.innerHTML = '<div class="note">读取中…</div>';
    try {
      const r = await fetch('/api/data/watch/topics', { cache: 'no-store' }).then((x) => x.json());
      box.innerHTML = `<div class="dc-subj-list">${(r.topics || []).map((t) => `
        <div class="dc-subj">
          <div class="dc-subj-head"><b>${esc(t.label)}</b>
            <span class="dc-badge ${t.risk === '高' ? 'err' : t.risk === '中' ? 'warn' : ''}">风险 ${esc(t.risk)}</span></div>
          <div class="dc-subj-why">${esc(t.why)}</div>
          <div class="dc-cand-kw">
            天体词：${(t.anchors || []).map((k) => `<code>${esc(k)}</code>`).join(' ')}<br>
            话题词：${(t.context || []).map((k) => `<code>${esc(k)}</code>`).join(' ')}
          </div>
          ${t.targets?.length ? `<div class="dc-cand-targets">对应字段：${t.targets.map((x) => `<code>${esc(x)}</code>`).join(' ')}</div>` : ''}
        </div>`).join('')}</div>`;
      box.dataset.loaded = '1';
    } catch (e) {
      box.innerHTML = `<div class="note">读取失败：${esc(e.message)}</div>`;
    }
  }

  /* ---------------- 更新管线（SSE） ---------------- */
  #runPipeline(id) {
    if (this.busy) { this.app.toast('已有任务在跑，请等它结束', 'err'); return; }
    const body = this.app.ui.panel.bodyEl;
    const wrap = body.querySelector('#dc-logwrap');
    const log = body.querySelector('#dc-log');
    if (wrap) wrap.hidden = false;
    if (log) log.innerHTML = '';
    this.busy = true;
    this.#appendLog('meta', `开始更新管线「${id}」…`);
    this.#setButtons(true);

    const src = new EventSource(`/api/data/update/stream?pipeline=${encodeURIComponent(id)}`);
    this.src = src;
    src.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'log') this.#appendLog(m.stream, m.line);
      else if (m.type === 'open') this.#appendLog('meta', '已连接本地服务');
      else if (m.type === 'done') {
        this.#appendLog(m.ok ? 'meta' : 'stderr', m.ok ? '✅ 全部完成，正在刷新状态…' : '✗ 管线未能完成');
        this.#finish(src, m.ok);
      } else if (m.type === 'error') {
        this.#appendLog('stderr', `✗ ${m.message}`);
        this.#finish(src, false, m.message);
      }
    };
    src.onerror = () => {
      // EventSource 在服务端正常关闭时也会触发 error——只有还没收到 done 才算真失败
      if (this.busy) {
        this.#appendLog('stderr', '✗ 与本地服务的连接中断');
        this.#finish(src, false, '连接中断');
      }
    };
  }

  #finish(src, ok, msg) {
    try { src.close(); } catch { /* ignore */ }
    this.src = null;
    this.busy = false;
    this.#setButtons(false);
    this.app.toast(ok ? '数据更新完成' : `更新未完成${msg ? `：${msg}` : ''}`, ok ? '' : 'err');
    this.reload().catch(() => {});
  }

  #setButtons(disabled) {
    this.app.ui.panel.bodyEl?.querySelectorAll('.dc-run, .dc-scan').forEach((b) => { b.disabled = disabled; });
  }

  #appendLog(stream, line) {
    const box = this.app.ui.panel.bodyEl?.querySelector('#dc-log');
    if (!box) return;
    const el = document.createElement('div');
    el.className = `dc-line ${stream === 'stderr' ? 'err' : stream === 'meta' ? 'meta' : ''}`;
    el.textContent = line;
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
    while (box.childElementCount > 600) box.removeChild(box.firstChild);
  }

  /* ---------------- 科研监测 ---------------- */
  async #scan() {
    if (this.busy) { this.app.toast('已有任务在跑', 'err'); return; }
    this.busy = true;
    this.#setButtons(true);
    const body = this.app.ui.panel.bodyEl;
    const wrap = body.querySelector('#dc-logwrap');
    const log = body.querySelector('#dc-log');
    if (wrap) wrap.hidden = false;
    if (log) log.innerHTML = '';
    this.#appendLog('meta', '正在检索 arXiv 上的最新论文…（9 个主题，按主题串行，可能需要 1–2 分钟）');
    try {
      const r = await fetch('/api/data/watch/scan', { method: 'POST' }).then((x) => x.json());
      if (r.ok) {
        this.#appendLog('meta', `✅ 扫描完成：${r.scanned} 个主题，新增 ${r.added} 条待复核线索`);
        this.app.toast(`扫描完成，新增 ${r.added} 条待复核线索`);
      } else {
        this.#appendLog('stderr', `✗ 扫描失败：${r.error || '未知错误'}`);
        this.app.toast('扫描失败', 'err');
      }
    } catch (e) {
      this.#appendLog('stderr', `✗ 扫描失败：${e.message}`);
      this.app.toast('扫描失败', 'err');
    } finally {
      this.busy = false;
      this.#setButtons(false);
      this.reload().catch(() => {});
    }
  }

  async #dismiss(id) {
    try {
      const r = await fetch('/api/data/watch/dismiss', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
      }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error || '失败');
      const c = this.#cand(id);
      if (c) c.status = 'dismissed';
      this.#patch();
      this.app.toast('已忽略该线索');
    } catch (e) { this.app.toast(`忽略失败：${e.message}`, 'err'); }
  }

  async #clearDismissed() {
    try {
      const r = await fetch('/api/data/watch/clear', { method: 'POST' }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error || '失败');
      this.app.toast(`已清理 ${r.removed} 条`);
      this.reload().catch(() => {});
    } catch (e) { this.app.toast(`清理失败：${e.message}`, 'err'); }
  }

  async #accept(card) {
    const id = card.dataset.cand;
    const c = this.#cand(id);
    const get = (k) => card.querySelector(`.dc-in[data-k="${k}"]`)?.value?.trim() ?? '';
    const entityId = get('entityId');
    const path = get('path');
    const raw = get('value');
    if (!entityId || !path || raw === '') { this.app.toast('天体 id、字段路径、新值都必须填', 'err'); return; }

    // 值转换：能当数字就当数字，true/false 当布尔，其余按字符串
    let value = raw;
    if (/^-?\d+(\.\d+)?$/.test(raw)) value = Number(raw);
    else if (raw === 'true' || raw === 'false') value = raw === 'true';

    try {
      const r = await fetch('/api/data/overrides', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          candidateId: id, entityId, path, value,
          note: get('note') || c?.title || '',
          origin: (c?.targets || [])[0] || '',
        }),
      }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error || '失败');
      this._overrides = r.overrides || [];
      if (c) c.status = 'accepted';
      this.app.toast(r.already ? '该修正已存在' : `已采纳：${entityId}.${path} = ${value}（下次加载生效）`);
      this.#patch();
    } catch (e) { this.app.toast(`采纳失败：${e.message}`, 'err'); }
  }

  async #deleteOverride(id) {
    try {
      const r = await fetch('/api/data/overrides/remove', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
      }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error || '失败');
      this._overrides = r.overrides || [];
      this.app.toast('已撤销该修正');
      this.#patch();
    } catch (e) { this.app.toast(`撤销失败：${e.message}`, 'err'); }
  }

  /** 打开面板时顺便把覆盖表拉进来（状态接口不含它） */
  async loadOverridesList() {
    try {
      const r = await fetch('/api/data/overrides', { cache: 'no-store' }).then((x) => x.json());
      this._overrides = r.overrides || [];
    } catch { this._overrides = []; }
  }
}
