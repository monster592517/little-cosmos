/**
 * 开普勒轨道力学
 *  - 输入：经典轨道六要素（a, e, i, Ω, ω, M）＋历元
 *  - 输出：J2000 黄道直角坐标（单位 AU，x 指向春分点）
 *  - 支持 JPL/Standish 线性变化率（每世纪），用于八大行星的长期精度
 */

export const J2000 = 2451545.0;
export const DEG = Math.PI / 180;

export function julianDate(date = new Date()) {
  return date.getTime() / 86400000 + 2440587.5;
}

export function dateFromJulian(jd) {
  return new Date((jd - 2440587.5) * 86400000);
}

/** 解开普勒方程 M = E - e·sinE（牛顿迭代） */
export function solveKepler(M, e) {
  let E = M;
  if (e > 0.8) E = Math.PI;
  for (let k = 0; k < 60; k++) {
    const f = E - e * Math.sin(E) - M;
    const fp = 1 - e * Math.cos(E);
    const d = f / fp;
    E -= d;
    if (Math.abs(d) < 1e-12) break;
  }
  return E;
}

const norm360 = (d) => ((d % 360) + 360) % 360;

export class Orbit {
  /**
   * @param {object} el
   *   a 半长轴(AU) | e 偏心率 | i 倾角(°) | om 升交点黄经(°) | w 近日点幅角(°)
   *   M0 历元平近点角(°) | epoch 历元儒略日 | rates {a,e,i,om,w,M} 每世纪变化率
   *   若提供 L / longPeri / longNode，则自动换算为 w 与 M0
   */
  constructor(el) {
    this.a = el.a;
    this.e = el.e ?? 0;
    this.i = el.i ?? 0;
    this.om = el.om ?? el.longNode ?? 0;
    this.w = el.w ?? 0;
    this.M0 = el.M0 ?? 0;
    if (el.L != null && el.longPeri != null) {
      this.M0 = el.L - el.longPeri;
      this.w = el.longPeri - this.om;
    }
    this.epoch = el.epoch ?? J2000;
    // 变化率：既接受 {a,e,i,om,w,M}，也接受 Standish 的 {a,e,i,L,longPeri,longNode}
    let rates = el.rates ?? null;
    if (rates && (rates.L != null || rates.longPeri != null || rates.longNode != null)) {
      const rL = rates.L ?? 0, rP = rates.longPeri ?? 0, rN = rates.longNode ?? 0;
      rates = { a: rates.a ?? 0, e: rates.e ?? 0, i: rates.i ?? 0, om: rN, w: rP - rN, M: rL - rP };
    }
    this.rates = rates;
    this.parentRadiusAU = el.parentRadiusAU ?? 0;
  }

  /** 在给定儒略日下的六要素（含长期变化） */
  elementsAt(jd) {
    const T = (jd - this.epoch) / 36525;
    const r = this.rates;
    if (!r) return this;
    return {
      a: this.a + (r.a ?? 0) * T,
      e: this.e + (r.e ?? 0) * T,
      i: this.i + (r.i ?? 0) * T,
      om: this.om + (r.om ?? 0) * T,
      w: this.w + (r.w ?? 0) * T,
      M0: this.M0 + (r.M ?? 0) * T,
    };
  }

  /**
   * 平近点角（度）
   *  - 有长期变化率时（八大行星的 Standish 表）：M0 已含每世纪变化，直接使用；
   *  - 无变化率时（JPL SBDB 的小天体要素）：按开普勒第三定律推进 M = M0 + 360·(t−epoch)/P。
   */
  meanAnomalyAt(jd) {
    if (this.rates) return this.M0 + (this.rates.M ?? 0) * ((jd - this.epoch) / 36525);
    const a = Math.abs(this.a) || 1;
    const period = this._periodDays ?? (365.2568983 * Math.pow(a, 1.5));
    return this.M0 + (360 * (jd - this.epoch)) / period;
  }

  /** 位置（AU，黄道坐标系） */
  positionAt(jd, out = { x: 0, y: 0, z: 0 }) {
    const el = this.elementsAt(jd);
    const e = Math.min(0.999999, Math.max(0, el.e));
    const M = norm360(this.meanAnomalyAt(jd)) * DEG;
    const E = solveKepler(M, e);
    const a = el.a;
    const xp = a * (Math.cos(E) - e);
    const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);

    const w = el.w * DEG, om = el.om * DEG, inc = el.i * DEG;
    const cw = Math.cos(w), sw = Math.sin(w);
    const co = Math.cos(om), so = Math.sin(om);
    const ci = Math.cos(inc), si = Math.sin(inc);

    out.x = (cw * co - sw * so * ci) * xp + (-sw * co - cw * so * ci) * yp;
    out.y = (cw * so + sw * co * ci) * xp + (-sw * so + cw * co * ci) * yp;
    out.z = (sw * si) * xp + (cw * si) * yp;
    return out;
  }

  /** 轨道周期（天） */
  get periodDays() {
    if (this._periodDays) return this._periodDays;
    if (this.a <= 0) return null;
    return 365.2568983 * Math.pow(Math.abs(this.a), 1.5);
  }

  /** 近/远日点距离（AU） */
  get perihelion() { return this.a * (1 - this.e); }
  get aphelion() { return this.a * (1 + this.e); }

  /** 采样整条轨道（用于画线），返回 Float32Array 顶点 */
  sample(count = 512, jd = J2000) {
    const el = this.elementsAt(jd);
    const e = Math.min(0.999999, Math.max(0, el.e));
    const a = el.a;
    const w = el.w * DEG, om = el.om * DEG, inc = el.i * DEG;
    const cw = Math.cos(w), sw = Math.sin(w);
    const co = Math.cos(om), so = Math.sin(om);
    const ci = Math.cos(inc), si = Math.sin(inc);
    const pts = new Float32Array(count * 3);
    for (let k = 0; k < count; k++) {
      const E = (k / count) * Math.PI * 2;
      const xp = a * (Math.cos(E) - e);
      const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
      pts[k * 3] = (cw * co - sw * so * ci) * xp + (-sw * co - cw * so * ci) * yp;
      pts[k * 3 + 1] = (cw * so + sw * co * ci) * xp + (-sw * so + cw * co * ci) * yp;
      pts[k * 3 + 2] = (sw * si) * xp + (cw * si) * yp;
    }
    return pts;
  }
}

/** 由半径与周期构造圆轨道（卫星用，真实值） */
export function circularOrbit({ radiusKm, periodDays, inclination = 0, node = 0, phase = 0, epoch = J2000 }) {
  const AU = 149597870.7;
  return new Orbit({
    a: radiusKm / AU,
    e: 0,
    i: inclination,
    om: node,
    w: 0,
    M0: phase,
    epoch,
    _periodDays: periodDays,
  });
}
