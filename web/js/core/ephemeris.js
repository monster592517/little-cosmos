/**
 * 星历核心：天体在任意时刻的真实位置
 *
 *  数据源：astronomy-engine（MIT）—— 行星用 VSOP87 截断级数，月球用 ELP2000-82B，
 *  木卫一~四用专用模型；与 JPL 星历相比误差约 1 角分，且可离线计算任意日期。
 *  统一坐标系：黄道 J2000 直角坐标（AU），与 JPL SBDB 的小天体轨道要素同框，
 *  因此行星、卫星、小行星可以在同一个场景里对齐。
 *
 *  校验工具：node tools/verify-ephemeris.mjs
 */
import * as A from 'astronomy-engine';
import { julianDate, dateFromJulian, Orbit } from '../util/kepler.js';

const AU_KM = 149597870.7;
const DEG = Math.PI / 180;
const C_KMS = 299792.458;

/** 赤道 J2000（EQJ）→ 黄道 J2000 的固定旋转矩阵 */
const R_EQJ_ECL = A.Rotation_EQJ_ECL();

/** 行星 id → astronomy-engine 天体 */
const AE_BODY = {
  mercury: A.Body.Mercury,
  venus: A.Body.Venus,
  earth: A.Body.Earth,
  mars: A.Body.Mars,
  jupiter: A.Body.Jupiter,
  saturn: A.Body.Saturn,
  uranus: A.Body.Uranus,
  neptune: A.Body.Neptune,
  pluto: A.Body.Pluto,
};

const GALILEAN = new Set(['io', 'europa', 'ganymede', 'callisto']);

const V = {
  add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }),
  sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }),
  len: (a) => Math.hypot(a.x, a.y, a.z),
  cross: (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }),
  norm: (a) => { const l = V.len(a) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l }; },
  dot: (a, b) => a.x * b.x + a.y * b.y + a.z * b.z,
};

const ecl = (v) => A.RotateVector(R_EQJ_ECL, v);

/** 以 z 为极点、参考方向 ref 构造正交基 */
function basisFromPole(pole, ref = { x: 0, y: 0, z: 1 }) {
  const z = V.norm(pole);
  let r = ref;
  if (Math.abs(V.dot(z, r)) > 0.95) r = { x: 1, y: 0, z: 0 };
  const x = V.norm(V.cross(r, z));
  const y = V.cross(z, x);
  return { x, y, z };
}

export class Ephemeris {
  constructor(dataset) {
    this.ds = dataset;
    this._pathCache = new Map();
    this._poleCache = new Map();
  }

  /** Date → 儒略日 / 儒略日 → Date */
  static jd(date) { return julianDate(date); }
  static date(jd) { return dateFromJulian(jd); }

  /** 母星自转轴（黄道 J2000 单位向量） */
  poleOf(id, date) {
    const key = `${id}|${date.toISOString().slice(0, 13)}`;
    if (this._poleCache.has(key)) return this._poleCache.get(key);
    let pole;
    const body = AE_BODY[id];
    if (body) {
      const ax = A.RotationAxis(body, date);
      pole = V.norm(ecl(ax.north));
    } else {
      // 无模型的天体：按轴倾角近似（绕 x 轴倾斜）
      const b = this.ds.get(id);
      const tilt = (b?.axialTilt ?? 0) * DEG;
      pole = V.norm({ x: Math.sin(tilt), y: 0, z: Math.cos(tilt) });
    }
    this._poleCache.set(key, pole);
    return pole;
  }

  /** 日心黄道 J2000 位置（AU） */
  helio(id, date) {
    if (id === 'sun') return { x: 0, y: 0, z: 0 };
    const body = AE_BODY[id];
    if (body) return ecl(A.HelioVector(body, date));

    const b = this.ds.get(id);
    if (!b) return { x: 0, y: 0, z: 0 };

    if (b.type === 'moon') {
      return V.add(this.helio(b.parent, date), this.satelliteOffset(b, date));
    }
    if (b.type === 'probe') return this.probeHelio(b, date);
    // 已离开太阳系的星际天体：轨道是双曲线，改用「日心距离 + 方向」线性外推
    if (b.departed && b.helio) {
      const h = b.helio;
      const years = (julianDate(date) - (b.epochJD ?? 2461261.5)) / 365.25;
      const au = Math.max(0.1, h.au + (h.speedAuPerYear ?? 0) * years);
      const lat = (h.latDeg ?? 0) * DEG, lon = (h.lonDeg ?? 0) * DEG;
      const c = Math.cos(lat);
      return { x: au * c * Math.cos(lon), y: au * c * Math.sin(lon), z: au * Math.sin(lat) };
    }
    if (b._orbit) return b._orbit.positionAt(julianDate(date));
    if (b.type === 'region') return { x: 0, y: 0, z: 0 };
    return { x: 0, y: 0, z: 0 };
  }

  /** 探测器日心位置 */
  probeHelio(probe, date) {
    const host = probe.host ? this.ds.get(probe.host) : null;
    if (probe.mode === 'orbit' && host) {
      return V.add(this.helio(host.id, date), this.probeOffset(probe, date));
    }
    if (probe.mode === 'landed' && host) {
      return V.add(this.helio(host.id, date), this.surfaceOffset(host, probe.landing?.lat ?? 0, probe.landing?.lon ?? 0, date));
    }
    if (probe.mode === 'ended' && host) return this.helio(host.id, date);
    if (probe.orbit) return new Orbit(probe.orbit).positionAt(julianDate(date));
    const h = probe.helio;
    if (!h) return { x: 0, y: 0, z: 0 };
    const years = (julianDate(date) - (probe.epochJD ?? 2461261.5)) / 365.25;
    const au = Math.max(0.01, h.au + (h.speedAuPerYear ?? 0) * years);
    const lat = (h.latDeg ?? 0) * DEG, lon = (h.lonDeg ?? 0) * DEG;
    const c = Math.cos(lat);
    return { x: au * c * Math.cos(lon), y: au * c * Math.sin(lon), z: au * Math.sin(lat) };
  }

  /** 环绕探测器的相对偏移（母星赤道面内的平均轨道） */
  probeOffset(probe, date) {
    const host = this.ds.get(probe.host);
    if (!host) return { x: 0, y: 0, z: 0 };
    const o = probe.orbitKm || {};
    return this.#meanOrbit({
      aKm: o.aKm, e: o.e ?? 0, incline: o.iDeg ?? 0, node: o.nodeDeg ?? 0,
      phase: o.phaseDeg ?? 0, periodDays: o.periodDays ?? 1, epochJD: probe.epochJD,
    }, host, date);
  }

  /** 天体表面某经纬度的偏移（黄道 J2000，AU） */
  surfaceOffset(body, latDeg, lonDeg, date) {
    const pole = this.poleOf(body.id, date);
    const { x: ex, y: ey, z: ez } = basisFromPole(pole);
    const mult = body.radiusKm > 3000 ? 1.02 : 1.05;
    const r = (body.radiusKm / AU_KM) * mult;
    const lat = latDeg * DEG, lon = lonDeg * DEG;
    const c = Math.cos(lat);
    const lx = c * Math.cos(lon), ly = c * Math.sin(lon), lz = Math.sin(lat);
    return {
      x: (lx * ex.x + ly * ey.x + lz * ez.x) * r,
      y: (lx * ex.y + ly * ey.y + lz * ez.y) * r,
      z: (lx * ex.z + ly * ey.z + lz * ez.z) * r,
    };
  }

  /** 地心黄道 J2000 位置（AU） */
  geo(id, date) {
    return V.sub(this.helio(id, date), this.helio('earth', date));
  }

  /** 卫星相对母星的偏移（黄道 J2000，AU） */
  satelliteOffset(moon, date) {
    const parent = this.ds.get(moon.parent);
    if (!parent) return { x: 0, y: 0, z: 0 };

    // 地球的月球：ELP2000 真实模型
    if (moon.id === 'moon') return ecl(A.GeoMoon(date));

    // 木卫一~四：专用模型（jovicentric, EQJ）
    if (parent.id === 'jupiter' && GALILEAN.has(moon.id)) {
      return ecl(A.JupiterMoons(date)[moon.id]);
    }

    // 其余卫星：在母星赤道面内做平均轨道运动（半径/周期/倾角取真实值）
    return this.#meanOrbit(moon, parent, date);
  }

  #meanOrbit(moon, parent, date) {
    const pole = this.poleOf(parent.id, date);
    const { x: ex, y: ey, z: ez } = basisFromPole(pole);
    const a = (moon.aKm ?? moon.orbitRadiusKm) / AU_KM;
    const e = moon.e ?? 0;
    const inc = (moon.incline ?? 0) * DEG;
    const node = (moon.node ?? 0) * DEG;
    const epoch = moon.epochJD ?? 2451545.0;
    const period = moon.periodDays || 1;
    const M = ((moon.phase ?? 0) * DEG) + (2 * Math.PI * (julianDate(date) - epoch)) / period;

    // 椭圆轨道（近似：用偏近点角展开到一阶）
    const r = a * (1 - e * Math.cos(M));
    const px = r * Math.cos(M);
    const py = r * Math.sin(M);

    // 先绕极点旋转 node，再绕节点线倾斜 inc
    const cn = Math.cos(node), sn = Math.sin(node);
    const ci = Math.cos(inc), si = Math.sin(inc);
    const x1 = px * cn - py * ci * sn;
    const y1 = px * sn + py * ci * cn;
    const z1 = py * si;

    return {
      x: x1 * ex.x + y1 * ey.x + z1 * ez.x,
      y: x1 * ex.y + y1 * ey.y + z1 * ez.y,
      z: x1 * ex.z + y1 * ey.z + z1 * ez.z,
    };
  }

  /** 轨道周期（天） */
  periodOf(id) {
    const b = this.ds.get(id);
    if (!b) return 365.25;
    if (AE_BODY[id] && id !== 'earth') return A.PlanetOrbitalPeriod(AE_BODY[id]);
    if (id === 'earth') return A.PlanetOrbitalPeriod(A.Body.Earth);
    if (b.type === 'moon') return Math.abs(b.periodDays || 27.32);
    if (b.type === 'probe') return b.orbitKm?.periodDays || b.periodDays || 365.25;
    if (b._orbit?.periodDays) return b._orbit.periodDays;
    return b.periodDays || 365.25;
  }

  /**
   * 轨道路径：直接用真实位置采样一圈（因此天体永远落在自己画出的轨道线上）
   * @returns {Float32Array} 顶点数组（场景坐标由调用方映射）
   */
  path(id, date, count = 240) {
    const key = `${id}|${date.toISOString().slice(0, 10)}|${count}`;
    const hit = this._pathCache.get(key);
    if (hit) return hit;

    const b = this.ds.get(id);
    if (!b) return new Float32Array(0);
    if (b.type === 'probe') return new Float32Array(0);   // 探测器轨迹单独绘制

    const period = this.periodOf(id);
    const pts = new Float32Array((count + 1) * 3);
    const isMoon = b.type === 'moon';

    for (let i = 0; i <= count; i++) {
      const t = date.getTime() + (i / count) * period * 86400000;
      const p = isMoon ? this.satelliteOffset(b, new Date(t)) : this.helio(id, new Date(t));
      pts[i * 3] = p.x; pts[i * 3 + 1] = p.z; pts[i * 3 + 2] = -p.y;
    }
    this._pathCache.set(key, pts);
    if (this._pathCache.size > 200) this._pathCache.delete(this._pathCache.keys().next().value);
    return pts;
  }

  /** 实时物理量（用于资料面板） */
  live(id, date) {
    const b = this.ds.get(id);
    if (!b) return null;
    const helio = this.helio(id, date);
    const earth = this.helio('earth', date);
    const geo = V.sub(helio, earth);
    const rHelio = V.len(helio);
    const rGeo = V.len(geo);
    const lon = ((Math.atan2(helio.y, helio.x) / DEG) + 360) % 360;
    const lat = Math.atan2(helio.z, Math.hypot(helio.x, helio.y)) / DEG;

    // 轨道速度（中心差分）
    const dt = 0.5 * 86400000;
    const p1 = this.helio(id, new Date(date.getTime() - dt));
    const p2 = this.helio(id, new Date(date.getTime() + dt));
    const vAuDay = V.len(V.sub(p2, p1)) / 1.0;
    const speedKms = (vAuDay * AU_KM) / 86400;

    const out = {
      rHelioAu: rHelio,
      rGeoAu: rGeo,
      lonDeg: lon,
      latDeg: lat,
      lightTimeSec: (rGeo * AU_KM) / C_KMS,
      speedKms,
      angularDiameterArcsec: b.radiusKm ? (2 * Math.asin(Math.min(1, b.radiusKm / (rGeo * AU_KM))) / DEG) * 3600 : null,
    };

    const body = AE_BODY[id];
    if (body) {
      try {
        const il = A.Illumination(body, date);
        out.mag = il.mag;
        out.phaseAngleDeg = il.phase_angle;
        out.phaseFraction = il.phase_fraction;
        out.ringTilt = il.ring_tilt ?? null;
      } catch { /* 某些天体无光照模型 */ }
    }
    if (id === 'moon') {
      out.mag = null;
      out.phaseFraction = A.Illumination(A.Body.Moon, date).phase_fraction;
      out.phaseAngleDeg = A.Illumination(A.Body.Moon, date).phase_angle;
    }
    if (b.type === 'probe') {
      out.mag = null;
      if (b.host) {
        const hp = this.helio(b.host, date);
        out.rHostAu = V.len(V.sub(helio, hp));
      }
    }
    return out;
  }

  /** 由日心位置与速度反推轨道要素（用于展示「当前轨道」） */
  elementsAt(id, date) {
    const b = this.ds.get(id);
    if (!b || b.type === 'region' || b.type === 'probe') return null;
    const p = this.helio(id, date);
    const dt = 0.5 * 86400000;
    const p1 = this.helio(id, new Date(date.getTime() - dt));
    const p2 = this.helio(id, new Date(date.getTime() + dt));
    const v = V.sub(p2, p1);                 // AU/天
    const r = V.len(p), vv = V.len(v);
    if (!r || !vv) return null;

    const MU = 1.32712440018e11;             // 太阳引力常数 km³/s²
    const rKm = r * AU_KM;
    const vKms = (vv * AU_KM) / 86400;
    const energy = (vKms * vKms) / 2 - MU / rKm;
    const a = -MU / (2 * energy) / AU_KM;    // AU
    const h = V.cross(p, v);
    const hKm = (V.len(h) * AU_KM * AU_KM) / 86400;   // km²/s
    const e = Math.sqrt(Math.max(0, 1 + (2 * energy * hKm * hKm) / (MU * MU)));
    const inc = Math.acos(Math.max(-1, Math.min(1, h.z / (V.len(h) || 1)))) / DEG;
    return { a, e, inc, speedKms: vKms };
  }
}

export { V as vec };
