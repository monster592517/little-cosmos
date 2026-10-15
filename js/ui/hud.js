/** 底部 HUD：时间控制与显示选项；设置 / 帮助面板 */
import { dateCN, esc } from '../util/fmt.js';
import { TIERS, TIER_ORDER, PREFERENCES } from '../core/gpu.js';

export class Hud {
  constructor(app) {
    this.app = app;
    this.dateEl = document.getElementById('clock-date');
    this.rateEl = document.getElementById('clock-rate');
    this.playBtn = document.getElementById('btn-play');
    this.speedEl = document.getElementById('speed');
    this.scalebar = document.getElementById('scalebar');
    this.fpsEl = document.getElementById('fps');
    this.#bind();
  }

  #bind() {
    const { clock, engine } = this.app;
    this.playBtn.addEventListener('click', () => this.togglePlay());
    this.speedEl.addEventListener('change', () => clock.setRate(Number(this.speedEl.value)));
    document.getElementById('btn-now').addEventListener('click', () => {
      clock.now();
      this.app.toast('时间已回到此刻');
    });
    document.getElementById('scale-true').addEventListener('change', (e) => {
      engine.setOptions({ trueScale: e.target.checked });
      this.app.toast(e.target.checked ? '已切换到真实比例（天体尺寸按实际半径绘制）' : '已切换到视觉增强比例');
    });
    document.getElementById('opt-orbits').addEventListener('change', (e) => engine.setOptions({ orbits: e.target.checked }));
    document.getElementById('opt-labels').addEventListener('change', (e) => engine.setOptions({ labels: e.target.checked }));
    document.getElementById('opt-rotate').addEventListener('change', (e) => engine.setOptions({ autoRotate: e.target.checked }));
    document.getElementById('btn-settings').addEventListener('click', () => this.open());
    document.getElementById('btn-help').addEventListener('click', () => this.help());
  }

  togglePlay() {
    const playing = this.app.clock.toggle();
    this.playBtn.textContent = playing ? '⏸' : '▶';
    this.playBtn.title = playing ? '暂停' : '播放';
    return playing;
  }

  tick() {
    const c = this.app.clock;
    this.dateEl.textContent = dateCN(c.date);
    this.rateEl.textContent = c.playing ? c.rateLabel() : '已暂停 · ' + c.rateLabel();
    const lv = this.app.engine.current;
    if (lv) {
      const s = lv.scaleLabelText;
      this.scalebar.textContent = s ? `视野 ≈ ${s}` : '';
    }
    this.app.ui.info?.tick();
  }

  setFps(v) { this.fpsEl.textContent = `${v} FPS`; }

  /** 构建场景时的忙提示（null 表示结束） */
  setBusy(text) {
    if (!this.busyEl) {
      this.busyEl = document.createElement('div');
      this.busyEl.className = 'toast';
      this.busyEl.style.position = 'fixed';
      this.busyEl.style.left = '50%';
      this.busyEl.style.top = '50%';
      this.busyEl.style.transform = 'translate(-50%,-50%)';
      this.busyEl.style.zIndex = '65';
      this.busyEl.style.pointerEvents = 'none';
      document.body.appendChild(this.busyEl);
    }
    if (text) {
      this.busyEl.innerHTML = `<span class="spinner"></span> ${esc(text)}`;
      this.busyEl.style.display = '';
    } else {
      this.busyEl.style.display = 'none';
    }
  }

  open() {
    const { engine } = this.app;
    const gpu = this.app.gpu;
    const o = engine.options;
    const t = engine.tier || (gpu ? gpu.tier : TIERS.balanced);

    const gpuBlock = gpu ? `
      <div class="section"><h3>显卡与性能</h3>
        <div class="setting col">
          <div class="lab">检测到的显卡
            <small>${esc(gpu.gpuLabel)}${gpu.gpu.webgl2 ? ' · 支持 WebGL2' : ' · 仅 WebGL1'}
            ${gpu.gpu.cores ? ` · ${gpu.gpu.cores} 逻辑核心` : ''}${gpu.gpu.memoryGb ? ` · ${gpu.gpu.memoryGb} GB 内存` : ''}<br>
            ${gpu.describe().map((s) => esc(s)).join('<br>')}</small>
          </div>
        </div>

        <div class="setting">
          <div class="lab">用哪颗 GPU<small id="gpu-pref-note">${esc(gpu.pref.desc)}</small></div>
          <select id="set-gpu-pref">
            ${Object.values(PREFERENCES).map((pr) => `<option value="${pr.id}" ${gpu.preference === pr.id ? 'selected' : ''}>${esc(pr.label)}</option>`).join('')}
          </select>
        </div>

        <div class="setting">
          <div class="lab">画质档位<small id="gpu-tier-note">${esc(t.desc)}</small></div>
          <select id="set-tier">
            ${TIER_ORDER.map((id) => `<option value="${id}" ${t.id === id ? 'selected' : ''}>${esc(TIERS[id].label)}</option>`).join('')}
          </select>
        </div>

        <div class="setting">
          <div class="lab">离开页面时暂停渲染<small>切到别的窗口 / 标签页时完全停帧，把显卡让给前台程序。强烈建议保持开启。</small></div>
          <input type="checkbox" id="set-pause-hidden" ${gpu.pauseWhenHidden ? 'checked' : ''}>
        </div>

        <div class="setting">
          <div class="lab">帧率上限<small>限制每秒最多渲染多少帧，进一步压低功耗与发热。</small></div>
          <select id="set-framecap">
            <option value="0" ${!gpu.frameCap ? 'selected' : ''}>不限制</option>
            <option value="30" ${gpu.frameCap === 30 ? 'selected' : ''}>30 FPS</option>
            <option value="60" ${gpu.frameCap === 60 ? 'selected' : ''}>60 FPS</option>
          </select>
        </div>

        <div class="btn-row" style="margin:2px 0 0">
          <button class="ghost" id="set-gpu-reset">按硬件重新自动适配</button>
        </div>
        <div class="note" style="margin-top:8px;font-size:11px;line-height:1.55">
          浏览器的 WebGL 只能<b>建议</b>用哪一类显卡，无法指定具体某一颗——真正的选择权在浏览器和驱动手里。
          切换「用哪颗 GPU」会重建渲染上下文，画面会闪一下，属正常现象。<br>
          「离开页面时暂停渲染」与「帧率上限」<b>立即生效</b>，无需刷新。
        </div>
      </div>` : '';

    const ovApplied = this.app.dataset?.overridesApplied?.length || 0;
    const ovFailed = this.app.dataset?.overridesFailed?.length || 0;
    const dataBlock = `
      <div class="section"><h3>数据与更新</h3>
        <div class="setting col">
          <div class="lab">数据更新中心
            <small>
              查看每个数据源现在是什么版本、多少条、什么时候构建的；一键重抓重建；
              按监测主题扫描 arXiv 最新论文，把可能与本地数据冲突的结论摆进待复核队列，由你拍板是否采纳。<br>
              ${ovApplied ? `当前已生效 <b>${ovApplied}</b> 条人工修正。` : '当前没有人工修正。'}
              ${ovFailed ? `<br><b>注意：本次加载有 ${ovFailed} 条修正未能应用</b>（详见控制台）。` : ''}
            </small>
          </div>
        </div>
        <div class="btn-row" style="margin:2px 0 0">
          <button class="primary" id="set-datacenter">打开数据更新中心</button>
        </div>
        <div class="note" style="margin-top:8px;font-size:11px;line-height:1.55">
          自动更新的只是<b>抓取型数据源</b>（恒星表、系外行星、小天体轨道、深空目录、贴图与影像）。<br>
          行星物理参数、探测器任务状态、天体文字资料属<b>人工维护</b>，无法自动重抓——
          它们只能靠科研监测产出线索、人工确认后以 overrides 落地，绝不会被自动流程直接改写。
        </div>
      </div>`;

    this.app.ui.panel.open('设置', `
      ${dataBlock}
      ${gpuBlock}
      <div class="section"><h3>显示</h3>
        <div class="setting">
          <div class="lab">真实比例<small>开启后行星与卫星按真实半径绘制，视觉上会变得极小——这是真实情况。</small></div>
          <input type="checkbox" id="set-true" ${o.trueScale ? 'checked' : ''}>
        </div>
        <div class="setting">
          <div class="lab">轨道线<small>显示行星与小天体的轨道；在「邻近恒星系」层还会用青色圆环标出<b>有已确认行星</b>的恒星。⚠️ 这一层的行星尺寸与轨道半径都做过<b>放大 + 非线性压缩</b>（按真实比例，整个行星系会小到看不见），只保证大小次序与相对远近是对的。</small></div>
          <input type="checkbox" id="set-orbits" ${o.orbits ? 'checked' : ''}>
        </div>
        <div class="setting">
          <div class="lab">名称标签<small>关闭可提升低配设备的帧率。</small></div>
          <input type="checkbox" id="set-labels" ${o.labels ? 'checked' : ''}>
        </div>
        <div class="setting">
          <div class="lab">镜头自动旋转<small>空闲时镜头缓慢环绕，画面不会显得呆板。</small></div>
          <input type="checkbox" id="set-rotate" ${o.autoRotate ? 'checked' : ''}>
        </div>
        <div class="setting">
          <div class="lab">泛光效果<small>让恒星、行星辉光与城市灯光发光。低配设备可关闭以提升帧率。</small></div>
          <input type="checkbox" id="set-bloom" ${o.bloom !== false ? 'checked' : ''}>
        </div>
        <div class="setting">
          <div class="lab">渲染分辨率<small>像素比越高越清晰，也越吃显卡。</small></div>
          <input type="range" id="set-dpr" min="0.6" max="2" step="0.1" value="${engine.renderer.getPixelRatio()}">
        </div>
      </div>
      <div class="section"><h3>宇宙尺度</h3>
        <div class="note">
          当前项目覆盖六个尺度层级，由近到远：<br>
          <b>太阳系</b>（1 单位 = 1 AU）→ <b>邻近恒星系</b>（1 光年）→ <b>银河系</b>（1 千光年）
          → <b>本星系群</b>（1 百万光年）→ <b>室女座超星系团</b>（1 亿光年）→ <b>可观测宇宙</b>（10 亿光年）。<br>
          每一层都有独立的场景与长度单位——1 AU 与 1 Gly 相差 20 个数量级，混在一个场景里浮点精度会直接崩掉。<br>
          切层方式：顶部尺度条、右下角 ⤢/⤡ 按钮、<b>PageUp / PageDown</b>，或把滚轮一直拉到底。
        </div>
      </div>
      <div class="section"><h3>数据来源</h3>
        <div class="note">
          太阳与行星贴图：Solar System Scope 8K（CC BY 4.0）<br>
          卫星 / 矮行星 / 小天体全球图：Celestia Content（NASA · USGS · JPL 影像）<br>
          深空天体目录：OpenNGC（CC BY-SA 4.0，NGC + IC 共约 1.3 万条）<br>
          恒星表：HYG Database v41（CC BY-SA 4.0，全量 10.9 万颗，取至 3262 光年）<br>
          系外行星：NASA Exoplanet Archive（TAP / pscomppars）<br>
          天体位置：astronomy-engine（VSOP87 / ELP2000 / 木卫专用模型，MIT）<br>
          轨道要素：JPL SBDB · JPL/Standish 行星近似要素表 · JPL SSD 卫星要素<br>
          物理参数：NASA Planetary Fact Sheet · JPL SSD · IAU 命名表<br>
          真实影像：NASA Image and Video Library（已本地化，可离线浏览）<br>
          论文检索：arXiv · OpenAlex · Crossref · Semantic Scholar<br>
          进展简报：本地抽取式摘要（不调用在线大模型）
        </div>
      </div>
    `);

    const body = this.app.ui.panel.bodyEl;
    body.querySelector('#set-datacenter')?.addEventListener('click', () => this.app.ui.datacenter?.open());
    body.querySelector('#set-true').addEventListener('change', (e) => { engine.setOptions({ trueScale: e.target.checked }); document.getElementById('scale-true').checked = e.target.checked; });
    body.querySelector('#set-orbits').addEventListener('change', (e) => { engine.setOptions({ orbits: e.target.checked }); document.getElementById('opt-orbits').checked = e.target.checked; });
    body.querySelector('#set-labels').addEventListener('change', (e) => { engine.setOptions({ labels: e.target.checked }); document.getElementById('opt-labels').checked = e.target.checked; });
    body.querySelector('#set-rotate').addEventListener('change', (e) => { engine.setOptions({ autoRotate: e.target.checked }); document.getElementById('opt-rotate').checked = e.target.checked; });
    body.querySelector('#set-bloom').addEventListener('change', (e) => engine.setOptions({ bloom: e.target.checked }));
    body.querySelector('#set-dpr').addEventListener('change', (e) => {
      engine.renderer.setPixelRatio(Number(e.target.value));
      engine.resize();
    });

    if (gpu) {
      body.querySelector('#set-gpu-pref').addEventListener('change', (e) => {
        const id = e.target.value;
        const changed = gpu.preference !== id;
        gpu.setPreference(id);
        if (!changed) { this.open(); return; }
        const ok = engine.setGpuPreferences(gpu);
        this.app.toast(ok
          ? `已切换为「${gpu.pref.label}」，画质档位：${gpu.tier.label}`
          : '切换 GPU 偏好失败，请按 F5 手动刷新页面', ok ? '' : 'err');
        this.open();
      });

      body.querySelector('#set-tier').addEventListener('change', (e) => {
        const id = e.target.value;
        gpu.setTier(id);
        engine.applyTier(id);
        this.app.toast(`画质档位已切换为「${TIERS[id].label}」，立即生效`);
        this.open();
      });

      body.querySelector('#set-pause-hidden').addEventListener('change', (e) => {
        gpu.setFine({ pauseWhenHidden: e.target.checked });
        this.app.toast(e.target.checked ? '已开启：离开页面时暂停渲染' : '已关闭：后台仍会继续渲染（更耗电）');
      });

      body.querySelector('#set-framecap').addEventListener('change', (e) => {
        gpu.setFine({ frameCap: Number(e.target.value) });
        this.app.toast(Number(e.target.value) ? `帧率上限已设为 ${e.target.value} FPS` : '已取消帧率上限');
      });

      body.querySelector('#set-gpu-reset').addEventListener('click', () => {
        gpu.resetAuto();
        const ok = engine.setGpuPreferences(gpu);
        this.app.toast(ok
          ? `已按硬件重新适配：${gpu.gpuShort} → ${gpu.tier.label} 档`
          : '重新适配失败，请按 F5 手动刷新页面', ok ? '' : 'err');
        this.open();
      });
    }
  }

  /** 画质档位变化时同步界面（面板开着就刷新下拉，否则只更新 FPS 提示） */
  syncTier() {
    const engine = this.app.engine;
    const body = this.app.ui.panel?.bodyEl;
    const sel = body?.querySelector?.('#set-tier');
    if (sel && engine?.tier) sel.value = engine.tier.id;
    const note = body?.querySelector?.('#gpu-tier-note');
    if (note && engine?.tier) note.textContent = engine.tier.desc;
    const prefNote = body?.querySelector?.('#gpu-pref-note');
    if (prefNote && this.app.gpu) prefNote.textContent = this.app.gpu.pref.desc;
    if (this.fpsEl && engine?.tier) this.fpsEl.title = `画质档位：${engine.tier.label}`;
  }

  help() {
    this.app.ui.panel.open('使用说明', `
      <div class="section"><h3>视角</h3>
        <ul class="facts">
          <li>顶部按钮一键切换视角：太阳系全景 / 内行星 / 外行星 / 小行星带 / 柯伊伯带。</li>
          <li>搜索框输入中文或英文名即可跳转（如「木卫二」「土卫六」「谷神星」）；<b>Ctrl + K</b> 打开命令面板（也可按 <b>/</b>）。</li>
          <li>数字键 <b>1–5</b> 切视角，<b>空格</b> 暂停/继续时间，<b>F</b> 聚焦并跟随当前选中的天体。</li>
        </ul>
      </div>
      <div class="section"><h3>三维操作</h3>
        <ul class="facts">
          <li>左键拖动旋转，滚轮缩放，右键（或双指）平移。</li>
          <li>直接点击天体本身即可打开属性面板——即使它在屏幕上只是一个光点也能点中。</li>
          <li>「聚焦并跟随」会把镜头锁定到该天体，时间推进时镜头跟着走。</li>
        </ul>
      </div>
      <div class="section"><h3>天体位置</h3>
        <ul class="facts">
          <li>行星位置由 <b>VSOP87</b> 行星理论实时计算，月球用 <b>ELP2000</b> 理论，木卫一~四用专用模型，与 JPL 星历偏差约 1 角分。</li>
          <li>轨道线是用真实位置采样出来的，所以天体永远落在自己画出的轨道上。</li>
          <li>调快时间流速就能看到行星按真实周期运动——地球一年一圈，海王星要 165 年。</li>
        </ul>
      </div>
      <div class="section"><h3>研究前沿</h3>
        <ul class="facts">
          <li>点「研究」按钮或天体资料里的「查看最新研究进展」，会用自建检索器同时查询 arXiv、OpenAlex、Crossref 与 Semantic Scholar。</li>
          <li>中文检索词会自动翻译成英文关键词再检索，命中率更高。</li>
          <li>「译为中文」把摘要翻成中文：优先用<b>浏览器内置翻译</b>（本地模型、可离线、不花钱），不支持时自动回退公共翻译接口；每条结果右下角的「整页翻译」可交给浏览器自带的网页翻译。</li>
          <li>「生成进展简报」在本地做抽取式摘要（核心结论 / 方法与观测 / 争议 / 下一步），每条要点标注来源论文编号，不调用任何在线大模型。</li>
          <li>翻译与简报结果都会缓存到本地，重复查看不再联网。</li>
        </ul>
      </div>
      <div class="section"><h3>目录与探测器</h3>
        <ul class="facts">
          <li>「目录」会在<b>界面左侧</b>展开一棵常驻的目录树，切换天体时不会消失；再点一次「目录」收起。</li>
          <li>目录按母天体组织：卫星与行星环挂在各自行星下，小行星带收录带内天体，彗星与星际天体单独成组。</li>
          <li>点名称进入天体（右侧出现详情），点三角箭头展开/收起子目录；当前选中的天体在目录里高亮。</li>
          <li>所有天体都有三维模型——包括直径只有几公里的小卫星与小行星，放大后即可看到。</li>
          <li>探测器按当前位置归位：在轨的画轨道，着陆的用十字准星标出着陆点，飞向星际的画真实飞行轨迹。</li>
        </ul>
      </div>
      <div class="section"><h3>建模与图片来源</h3>
        <ul class="facts">
          <li>每个天体的详情页底部都有「3D 建模与影像来源」：写明贴图来自哪套影像、分辨率、原始影像（如 Juno JunoCam、Cassini ISS、Voyager 2）、授权，并给出建模所用贴图的缩略图。</li>
          <li>细节不足的影像会生成<b>法线贴图</b>（由灰度梯度 + 程序化撞击坑），在真实光照下表现出起伏，相当于把模糊照片「还原」成有立体感的模型。</li>
          <li>没有公开影像的天体会标注「暂无图片」，三维模型由程序化贴图生成。</li>
          <li>每张图都标出类型：<b>原始影像</b>（直接拍摄）、<b>后处理增强</b>（多帧叠加/轨道跟踪/去噪）、
            <b>科学模拟/艺术家重建</b>（无直接影像时按掩星、光谱与组成元素推测的表面）。</li>
          <li>已离开太阳系的星际天体（奥陌陌、鲍里索夫、3I/ATLAS）都有模型与影像，
            包括 VLT 深场叠加影像、哈勃原始观测与科学家重建的外形。</li>
        </ul>
      </div>
      <div class="section"><h3>关于「体积过小」</h3>
        <p class="obj-desc">直径只有几公里到几十公里的小卫星、小行星与彗核，在全景视角下不到一个像素（标注「体积过小 · 放大后可见」）。
        它们同样有三维模型与完整资料——在目录或搜索里点一下，镜头就会推进到它的全貌图。</p>
      </div>
    `);
  }
}
