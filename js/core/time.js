/** 仿真时钟：以儒略日为主轴，速率 = 每真实秒推进的仿真秒数 */
import { julianDate, dateFromJulian } from '../util/kepler.js';

export class SimClock {
  constructor() {
    this.jd = julianDate(new Date());
    this.rate = 86400;      // 1 真实秒 = 1 天
    this.playing = true;
    this.listeners = new Set();
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(this); }

  update(dtSeconds) {
    if (!this.playing) return false;
    const before = this.jd;
    this.jd += (dtSeconds * this.rate) / 86400;
    return this.jd !== before;
  }

  get date() { return dateFromJulian(this.jd); }
  setDate(date) { this.jd = julianDate(date); this.emit(); }
  setJulian(jd) { this.jd = jd; this.emit(); }
  now() { this.jd = julianDate(new Date()); this.emit(); }
  setRate(r) { this.rate = r; this.emit(); }
  toggle() { this.playing = !this.playing; this.emit(); return this.playing; }

  /** 相对现在的偏移（天） */
  get offsetDays() { return this.jd - julianDate(new Date()); }

  rateLabel() {
    if (this.rate === 1) return '实时';
    const units = [[31557600, '年'], [2592000, '月'], [604800, '周'], [86400, '天'], [3600, '小时'], [60, '分钟'], [1, '秒']];
    for (const [s, name] of units) {
      if (this.rate >= s) {
        const v = this.rate / s;
        return `1 秒 ≈ ${Number.isInteger(v) ? v : v.toFixed(1)} ${name}`;
      }
    }
    return `1 秒 = ${this.rate} 秒`;
  }
}
