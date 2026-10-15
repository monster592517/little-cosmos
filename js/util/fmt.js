/** 数字 / 单位格式化（中文习惯：万、亿、万亿） */

export function num(v, digits = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs === 0) return '0';
  if (abs >= 1e12) return (v / 1e12).toFixed(digits) + ' 万亿';
  if (abs >= 1e8) return (v / 1e8).toFixed(digits) + ' 亿';
  if (abs >= 1e4) return (v / 1e4).toFixed(digits) + ' 万';
  if (abs >= 100) return v.toFixed(Math.max(0, digits - 1));
  if (abs >= 1) return v.toFixed(digits);
  if (abs >= 0.01) return v.toFixed(digits + 1);
  return v.toExponential(2);
}

/** 距离：km / AU / 光年 / 秒差距 / 万光年 / 亿光年 */
export function distance(km) {
  if (km == null) return '—';
  const AU = 149597870.7;
  if (km < 1e5) return `${num(km, 1)} km`;
  if (km < 0.05 * AU) return `${num(km / 1e4, 1)} 万 km`;
  const au = km / AU;
  if (au < 1000) return `${num(au, au < 10 ? 3 : 2)} AU`;
  const ly = km / 9.4607e12;
  if (ly < 1e4) return `${num(ly, 2)} 光年`;
  const kly = ly / 1e3;
  if (kly < 1e4) return `${num(kly, 2)} 千光年`;
  const mly = ly / 1e6;
  if (mly < 1e4) return `${num(mly, 2)} 百万光年`;
  return `${num(ly / 1e9, 2)} 十亿光年`;
}

export function lightTime(km) {
  if (km == null) return '—';
  const s = km / 299792.458;
  if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)} 秒`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(1)} 分钟`;
  const h = m / 60;
  if (h < 48) return `${h.toFixed(1)} 小时`;
  return `${(h / 24).toFixed(1)} 天`;
}

export function period(days) {
  if (days == null) return '—';
  if (days < 1) return `${num(days * 24, 1)} 小时`;
  if (days < 400) return `${num(days, 1)} 天`;
  const y = days / 365.25;
  if (y < 1e4) return `${num(y, 1)} 年`;
  return `${num(y, 0)} 年`;
}

export function temp(k) {
  if (k == null) return '—';
  return `${num(k, 0)} K（${(k - 273.15).toFixed(0)} °C）`;
}

export function mass(kg) {
  if (kg == null) return '—';
  const earth = 5.97237e24;
  if (kg < 1e20) return `${num(kg, 2)} kg`;
  return `${num(kg / earth, kg / earth < 10 ? 3 : 2)} 地球质量`;
}

export function radius(km) {
  if (km == null) return '—';
  const earth = 6371;
  if (km < 1) return `${num(km * 1000, 0)} m`;
  return `${num(km, km < 100 ? 2 : 0)} km（${num(km / earth, 3)} 地球半径）`;
}

export function speed(ms) {
  if (ms == null) return '—';
  if (Math.abs(ms) < 1000) return `${num(ms, 1)} m/s`;
  return `${num(ms / 1000, 2)} km/s`;
}

/** 角度：角秒 → 度/分/秒 */
export function angle(arcsec) {
  if (arcsec == null || !Number.isFinite(arcsec)) return '—';
  const a = Math.abs(arcsec);
  if (a >= 3600) return `${num(arcsec / 3600, 3)}°`;
  if (a >= 60) return `${Math.floor(a / 60)}′ ${(a % 60).toFixed(1)}″`;
  return `${num(arcsec, a < 1 ? 3 : 2)}″`;
}

/** 把「度」格式化成人类可读的方位 */
export function deg(v, digits = 2) {
  if (v == null) return '—';
  return `${num(v, digits)}°`;
}

export function dateCN(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '—';
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${date.getUTCFullYear()} 年 ${p(date.getUTCMonth() + 1)} 月 ${p(date.getUTCDate())} 日 ${p(date.getUTCHours())}:${p(date.getUTCMinutes())} UTC`;
}

export function dateShort(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '—';
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
