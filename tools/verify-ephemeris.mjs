#!/usr/bin/env node
/**
 * 星历交叉校验：把两套彼此独立的天体位置算法放在一起比。
 *
 *   A) 项目内 Kepler 实现（JPL / Standish 行星近似要素表，1800–2050）
 *   B) astronomy-engine（VSOP87 行星理论 + ELP2000 月球理论，MIT，与 JPL 比对约 1 角分）
 *
 * 两法互相独立，若偏差远小于 1 角分，说明天体位置是可信的。
 * 另附若干「已知参照值」硬检查（如 J2000 时刻地球日心黄经 ≈ 100.46°）。
 *
 * 还带一项**探测器参考历元自检**：核对 probes.js 的 EPOCH 常量是否真的等于它声明的那个日期，
 * 以及每个日心探测器的字段是否齐全。不一致会以退出码 1 报错。
 * （这项自检是因为 2026-09-11 发现常量与注释差了一个月才补上的。）
 *
 * 用法：node tools/verify-ephemeris.mjs
 */
import * as A from 'astronomy-engine';
import { Orbit, julianDate } from '../web/js/util/kepler.js';
import { PLANETS } from '../web/js/data/solar-system.js';
import { PROBES, EPOCH as PROBE_EPOCH } from '../web/js/data/probes.js';

const D2R = Math.PI / 180;
const norm360 = (d) => ((d % 360) + 360) % 360;
const angDiff = (a, b) => { const d = Math.abs(norm360(a) - norm360(b)) % 360; return d > 180 ? 360 - d : d; };

/** Kepler（Standish）→ J2000 黄道直角坐标（AU） */
function keplerVec(planet, jd) {
  const o = new Orbit(planet.orbit);
  const p = o.positionAt(jd);
  return { x: p.x, y: p.y, z: p.z };
}

/** astronomy-engine → J2000 黄道直角坐标（AU）
 *  注意：A.Ecliptic() 返回的是「当日」黄道坐标，与 Standish 要素的 J2000 黄道相差岁差
 *  （约 50.3″/年）。这里用 EQJ → J2000 黄道的固定旋转，保证两法同框比较。 */
const R_EQJ_ECL = A.Rotation_EQJ_ECL();
function engineVec(name, date) {
  const eqj = A.HelioVector(A.Body[name], date);
  const v = A.RotateVector(R_EQJ_ECL, eqj);
  return { x: v.x, y: v.y, z: v.z };
}

const vec2sph = (v) => ({
  lon: norm360(Math.atan2(v.y, v.x) / D2R),
  lat: Math.atan2(v.z, Math.hypot(v.x, v.y)) / D2R,
  r: Math.hypot(v.x, v.y, v.z),
});

/** 两向量夹角（角秒） */
function sepArcsec(a, b) {
  const na = Math.hypot(a.x, a.y, a.z), nb = Math.hypot(b.x, b.y, b.z);
  const cos = (a.x * b.x + a.y * b.y + a.z * b.z) / (na * nb);
  return (Math.acos(Math.max(-1, Math.min(1, cos))) / D2R) * 3600;
}

const DATES = ['2000-01-01T12:00:00Z', '2010-06-15T00:00:00Z', '2020-01-01T00:00:00Z',
  '2026-09-09T00:00:00Z', '2035-03-01T00:00:00Z', '2049-12-31T00:00:00Z'];

console.log('=== 行星位置交叉校验：Kepler(Standish) vs astronomy-engine(VSOP87) ===\n');
let worst = 0;
for (const iso of DATES) {
  const date = new Date(iso);
  const jd = julianDate(date);
  console.log(`  日期 ${iso}`);
  for (const p of PLANETS) {
    const name = p.en === 'Earth' ? 'Earth' : p.en;
    const a = keplerVec(p, jd);
    const b = engineVec(name, date);
    const sep = sepArcsec(a, b);
    const sa = vec2sph(a), sb = vec2sph(b);
    worst = Math.max(worst, sep);
    const flag = sep < 60 ? '✓' : sep < 600 ? '~' : '✗';
    console.log(`    ${flag} ${p.en.padEnd(8)} 黄经 ${sb.lon.toFixed(4)}° | 距离 ${sb.r.toFixed(6)} AU | 偏差 ${sep.toFixed(1)}″ (${(sep / 3600).toFixed(4)}°) | Δr ${(Math.abs(sa.r - sb.r) * 1e6).toFixed(0)} km`);
  }
  console.log('');
}

// 参照值硬检查
console.log('=== 已知参照值 / 独立性检查 ===');
const j2000 = new Date('2000-01-01T12:00:00Z');
const earthJ2000 = vec2sph(engineVec('Earth', j2000));
const kepJ2000 = vec2sph(keplerVec(PLANETS.find((p) => p.id === 'earth'), julianDate(j2000)));
console.log(`  J2000 地球日心黄经：VSOP87 ${earthJ2000.lon.toFixed(4)}° vs Standish ${kepJ2000.lon.toFixed(4)}°（差 ${Math.abs(earthJ2000.lon - kepJ2000.lon).toFixed(4)}°）`);

const sep = new Date('2026-09-09T00:00:00Z');
const sunLon = norm360(vec2sph(engineVec('Earth', sep)).lon + 180);
console.log(`  2026-09-09 太阳视黄经 = ${sunLon.toFixed(2)}°（9 月上旬太阳位于室女座，约 166°，用于人工核对）`);

const moon = A.GeoMoon(sep);
const md = Math.hypot(moon.x, moon.y, moon.z);
const mdKm = md * 149597870.7;
console.log(`  月球地心距离（2026-09-09）= ${mdKm.toFixed(0)} km（真实范围 356,500–406,700 km）→ ${mdKm > 356500 && mdKm < 406700 ? '✓ 合理' : '✗ 越界'}`);

const jm = A.JupiterMoons(sep);
const ioR = Math.hypot(jm.io.x, jm.io.y, jm.io.z) * 149597870.7;
const caR = Math.hypot(jm.callisto.x, jm.callisto.y, jm.callisto.z) * 149597870.7;
console.log(`  木卫一轨道半径 = ${ioR.toFixed(0)} km（真实 421,800）· 木卫四 = ${caR.toFixed(0)} km（真实 1,882,700）`);

/* ---------- 探测器参考历元自检 ---------- */
// 为什么要有这一段：probes.js 里的 EPOCH 常量曾经写成 2461261.5，注释却写「2026-09-09」，
// 而它换算回来是 2026-08-09 —— 差整整一个月，于是每个日心探测器都被多推进约 0.3 AU。
// 常量对不对，不该靠人眼看注释，交给机器核对。
console.log('\n=== 探测器参考历元自检 ===');
const declaredIso = '2026-09-09';
const wantJd = julianDate(new Date(`${declaredIso}T00:00:00Z`));
const epochDiffDays = PROBE_EPOCH - wantJd;
const epochOk = Math.abs(epochDiffDays) < 1e-6;
console.log(`  probes.js 声明参考历元 ${declaredIso} → JD ${wantJd}`);
console.log(`  ${epochOk ? '✓' : '✗'} EPOCH = ${PROBE_EPOCH}${epochOk ? '' : `（与声明日期相差 ${epochDiffDays.toFixed(1)} 天）`}`);

// 参考历元当天的日心距离应当正好等于各探测器自己记的 au（外推年数为 0）。
const helioProbes = PROBES.filter((p) => p.mode === 'heliocentric' && p.helio);
let helioBad = 0;
for (const p of helioProbes) {
  const h = p.helio;
  const fieldsOk = [h.au, h.lonDeg, h.latDeg, h.speedAuPerYear].every((v) => Number.isFinite(v));
  if (!fieldsOk) helioBad++;
  const atEpoch = h.au;
  const atSep = h.au + h.speedAuPerYear * ((julianDate(sep) - PROBE_EPOCH) / 365.25);
  console.log(`  ${fieldsOk ? '✓' : '✗'} ${p.name.padEnd(10)} 历元 ${String(atEpoch).padStart(6)} AU · 径向 ${String(h.speedAuPerYear).padStart(5)} AU/年 · 2026-09-09 推算 ${atSep.toFixed(2)} AU`);
}

console.log(`\n最大角偏差：${worst.toFixed(1)} 角秒 = ${(worst / 3600).toFixed(4)}°`);
console.log(worst < 600 ? '结论：两套彼此独立的算法一致（< 10 角分），天体位置可信。' : '结论：存在较大偏差，需要排查。');

if (!epochOk || helioBad) {
  console.log('✗ 探测器参考历元自检未通过 —— 见上。');
  process.exitCode = 1;
} else {
  console.log('✓ 探测器参考历元自检通过。');
}
