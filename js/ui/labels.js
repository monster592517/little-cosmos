/**
 * 三维标签层：把世界坐标投影到屏幕，用 DOM 渲染文字（清晰、可点击、可中文）。
 *
 * 性能口径（2026-09-11 实测，见 tools/perf-probe.py --label-cost）
 * ──────────────────────────────────────────────────────────
 * 六个尺度里只有「邻近恒星系」这一层值得优化：**5,429 个标签、4.26 ms/帧**，
 * 占 60fps 一帧预算（16.7ms）的 25.5%；其余五层都在 0.3 ms 以下，忽略。
 *
 * 优化前每帧有两笔冤枉开销，都在下面 `update()` 里注明：
 *   ① 每个标签做**两次**矩阵乘法（世界→视图、视图→裁剪），其实可以合并成一次；
 *   ② 每个标签**无条件**写一次 `style.display` —— 5,429 个里 5,000 多个写的是
 *      `'none'`（远处已剔除），写完值还没变。**这笔比矩阵乘法贵得多**。
 *
 * ⚠ **不要去优化那层防重叠的 O(n²)**：它跑在「这一帧真正显示出来的」标签上
 *   （实测 314 个 ≈ 4.9 万次比较 ≈ 0.05ms），不是总标签数。
 *   把 5,429² = 1,470 万这个数当成它的规模，是一个已经犯过的估算错误。
 */
import * as THREE from 'three';

const _v = new THREE.Vector3();
const _mvp = new THREE.Matrix4();

/**
 * 优先级标签的「距离宽容」系数。
 * ⚠️ **不是装饰**：`priority > 0` 的标签允许待在 `maxDist` 的 2.2 倍距离上。
 * solar 层靠这一条活着 —— `labelOptions.maxDistance = 140` 而视图最远 320 AU，
 * 去掉它，行星标签会在拉远时集体消失。**写 maxDist 时先把它乘进去。**
 */
export const PRIORITY_SLACK = 2.2;

/** 候选标签在屏幕上的最小排斥间距（px）。默认值 = 旧行为。 */
const GAP_X = 46, GAP_Y = 15;

export class LabelLayer {
  constructor(container) {
    this.container = container;
    this.items = new Map();
    this.visible = true;
    this.pool = [];
  }

  clear() {
    for (const el of this.items.values()) { el.remove(); this.pool.push(el); }
    this.items.clear();
  }

  /** 新增或更新标签 */
  add(id, { text, sub = '', position, className = '', onClick = null, priority = 0, maxDist = null }) {
    let el = this.items.get(id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'label';
      el.addEventListener('click', (e) => { e.stopPropagation(); onClick?.(); });
      this.container.appendChild(el);
      this.items.set(id, el);
      el._data = {};
    }
    const d = el._data;
    d.position = position;
    d.priority = priority;
    d.maxDist = maxDist;
    d.onClick = onClick;
    if (d.text !== text || d.sub !== sub) {
      el.innerHTML = `${text}${sub ? `<small>${sub}</small>` : ''}`;
      d.text = text; d.sub = sub;
    }
    const cls = `label ${className}`.trim();
    if (el.className !== cls) el.className = cls;
    return el;
  }

  get(id) { return this.items.get(id); }
  remove(id) {
    const el = this.items.get(id);
    if (el) { el.remove(); this.items.delete(id); this.pool.push(el); }
  }

  setVisible(v) {
    this.visible = v;
    this.container.style.display = v ? '' : 'none';
  }

  /**
   * 每帧调用：投影 + 距离剔除 + **按优先级抢占有限名额**。
   *
   * ⚠️ 2026-09-11 第 21 轮改动的原因（不是优化，是修故障）：
   * 原来按 `items` 的**插入顺序**贪心占位 —— 谁先 `add` 谁先占，和「谁重要」毫无关系。
   * 银河系层把 600 个深空天体全部 `add` 进来、又**一个都没给 `maxDist`**，
   * 于是默认视角下 40 多个编号叠在银核上，把星系本身埋了（用户：「你这银河系真是假爆了」）。
   * 对照组：`solar.js` 早就做对了 —— 小天体 `maxDist: 6 / 12`，注释写着「避免全景图堆满文字」。
   * **所以这不是新想法，是银河系层漏了这一条。**
   *
   * 改成**两趟**：
   *   ① 先算出这一帧的候选（屏幕坐标 / 距离 / 优先级），顺手把不合格的藏掉；
   *   ② 按**优先级降序**（同级近者优先）贪心占位，占满 `maxLabels` 就停。
   * 排序只跑在候选上（实测几百个），**不是**总标签数 —— 别把 5,429 当成 sort 的规模。
   */
  update(camera, width, height, {
    maxDistance = Infinity,
    minPixelGap = 0,      // 保留旧参数位：老调用点仍在传
    maxLabels = 0,        // 0 = 不限
    gapX = GAP_X,
    gapY = GAP_Y,
  } = {}) {
    if (!this.visible) return;
    void minPixelGap;
    const half = { x: width / 2, y: height / 2 };

    // ① 「世界 → 裁剪」的两段矩阵，每帧先乘成一段。
    //    three 的 Vector3.project() 内部是 applyMatrix4(matrixWorldInverse) 再
    //    applyMatrix4(projectionMatrix) —— 逐个标签做两次矩阵乘法。
    //    合成一次之后每个标签只做一次：5,429 个标签，每帧省下五千多次矩阵乘法。
    //    结果与 project() 完全一致（同样的两个矩阵，只是换了结合顺序）。
    _mvp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

    // ② 记下上一次真的写进 DOM 的值，值没变就不写。
    //    原来每帧无条件写 display/transform/opacity —— 5,000 多个「本来就要藏起来」
    //    的标签也要写 5,000 多次 style.display='none'，这是标签层最贵的一笔。
    const hide = (el) => {
      const st = el._data._style;
      if (st.display !== 'none') { el.style.display = 'none'; st.display = 'none'; }
    };

    /* ---- 第一趟：算候选 ---- */
    const cand = [];
    for (const el of this.items.values()) {
      const d = el._data;
      if (!d._style) d._style = { display: null, tf: null, op: null };
      if (!d.position) { hide(el); continue; }
      _v.copy(d.position).applyMatrix4(_mvp);
      if (_v.z > 1 || _v.z < -1) { hide(el); continue; }
      const x = (_v.x * half.x) + half.x;
      const y = (-_v.y * half.y) + half.y;
      if (x < -120 || x > width + 120 || y < -40 || y > height + 40) { hide(el); continue; }
      const dist = camera.position.distanceTo(d.position);
      const limit = d.maxDist != null ? Math.min(maxDistance, d.maxDist) : maxDistance;
      if (dist > limit * (d.priority > 0 ? PRIORITY_SLACK : 1)) { hide(el); continue; }
      cand.push({ el, x, y, dist, priority: d.priority || 0 });
    }

    /* ---- 第二趟：优先级降序占位（同级近者优先），满了就藏 ---- */
    cand.sort((a, b) => (b.priority - a.priority) || (a.dist - b.dist));
    const placed = [];
    for (const c of cand) {
      if (maxLabels > 0 && placed.length >= maxLabels) { hide(c.el); continue; }
      let blocked = false;
      for (let j = 0; j < placed.length; j++) {
        const p = placed[j];
        if (Math.abs(p.x - c.x) < gapX && Math.abs(p.y - c.y) < gapY) { blocked = true; break; }
      }
      if (blocked) { hide(c.el); continue; }
      placed.push(c);

      const el = c.el, d = el._data, st = d._style;
      if (st.display !== '') { el.style.display = ''; st.display = ''; }
      const tf = `translate(-50%,-140%) translate(${c.x.toFixed(1)}px,${c.y.toFixed(1)}px)`;
      if (st.tf !== tf) { el.style.transform = tf; st.tf = tf; }
      const fade = Math.min(1, Math.max(0.25, 1 - c.dist / maxDistance));
      if (st.op !== fade) { el.style.opacity = String(fade); st.op = fade; }
    }
  }
}
