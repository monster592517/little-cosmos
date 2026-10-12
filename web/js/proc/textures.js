/**
 * 程序化纹理工厂
 *  · 真实行星贴图来自 Solar System Scope（见 web/textures/）；
 *  · 卫星、小天体、星环、恒星辉光、星系盘等由本模块用噪声实时生成，
 *    既保证离线可用，也避免额外下载几十 MB 贴图。
 */
import * as THREE from 'three';

/* ---------------- 噪声 ---------------- */
function hash3(x, y, z, seed) {
  let h = x * 374761393 + y * 668265263 + z * 2147483647 + seed * 1013904223;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
const smooth = (t) => t * t * (3 - 2 * t);

function valueNoise3(x, y, z, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = smooth(x - xi), yf = smooth(y - yi), zf = smooth(z - zi);
  let acc = 0;
  for (let dz = 0; dz <= 1; dz++) {
    const wz = dz ? zf : 1 - zf;
    for (let dy = 0; dy <= 1; dy++) {
      const wy = dy ? yf : 1 - yf;
      for (let dx = 0; dx <= 1; dx++) {
        const wx = dx ? xf : 1 - xf;
        acc += wx * wy * wz * hash3(xi + dx, yi + dy, zi + dz, seed);
      }
    }
  }
  return acc;
}

export function fbm3(x, y, z, octaves = 4, seed = 1) {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise3(x * freq, y * freq, z * freq, seed + o * 37);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

/* ---------------- 颜色工具 ---------------- */

/** 解析失败的颜色记录（上限 50 条）。用 `colorParseFailures()` 取。
 *  存在的意义：把「画出黑贴图」这种**无声**故障变成**可查**的清单。 */
const colorFails = [];

/**
 * 解析颜色字符串 → [r,g,b]。
 *
 * 接受：`#rgb` / `#rrggbb` / `rgb(r,g,b)` / `rgba(r,g,b,a)`。
 * 项目里 `color` 字段的**口径是 `#rrggbb`**（见 `color/exo-temp.js` 的说明），
 * 这里额外接受 `rgb()` 属于**兼容**，不是第二套口径 ——
 * 早年 `starColorFromBV()` 就返回 `rgb(...)`，直接喂进来会被
 * `parseInt('rg', 16)` **静默**解析成 NaN，最后画出 `rgb(NaN,NaN,NaN)` 的贴图：
 * 不报错、不崩溃，只是那块东西变成黑色。这类故障最难查。
 *
 * 真解析不了（`undefined` / `null` / 数字 / 对象）时返回中性灰并记进 `colorFails`，
 * **不抛异常** —— 贴图生成发生在层级 build 里，抛出去会连带整层渲染失败。
 * 调用方要查有没有踩到，用 `colorParseFailures()`。
 */
function hexToRgb(hex) {
  if (typeof hex === 'string') {
    const s = hex.trim();
    const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(s);
    if (m) return [clamp255(+m[1]), clamp255(+m[2]), clamp255(+m[3])];
    const h = s.replace('#', '');
    if (/^[0-9a-fA-F]{3}$/.test(h)) {
      return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
    }
    if (/^[0-9a-fA-F]{6}$/.test(h)) {
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
  }
  if (colorFails.length < 50) colorFails.push(`${typeof hex}:${String(hex).slice(0, 40)}`);
  return [136, 136, 136];
}

/** 取（并清空）解析失败的颜色清单。`tools/check-scales.py` 靠它断言「一个都没有」。 */
export function colorParseFailures() {
  const out = colorFails.slice();
  colorFails.length = 0;
  return out;
}
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)));
const rgbCss = (c) => `rgb(${clamp255(c[0])},${clamp255(c[1])},${clamp255(c[2])})`;

function ramp(stops, t) {
  const x = Math.max(0, Math.min(1, t));
  for (let i = 0; i < stops.length - 1; i++) {
    const [p0, c0] = stops[i], [p1, c1] = stops[i + 1];
    if (x >= p0 && x <= p1) return mix(c0, c1, (x - p0) / (p1 - p0 || 1));
  }
  return stops[stops.length - 1][1];
}

const cache = new Map();
function cached(key, make) {
  if (cache.has(key)) return cache.get(key);
  const v = make();
  cache.set(key, v);
  return v;
}

/* ---------------- 球面贴图 ---------------- */
/**
 * 生成球体表面贴图
 * @param {object} o
 *   base 基色 | size [w,h] | seed | scale 噪声频率 | octaves
 *   mode 'rocky' | 'gas' | 'ice' | 'sun' | 'cratered'
 *   bandColor 条纹色（gas） | accent 高光色
 */
export function makePlanetTexture({ base = '#8a8078', accent = '#d8d0c4', size = [512, 256], seed = 7, scale = 3.2, octaves = 5, mode = 'rocky', bandColor = null, contrast = 1 }) {
  const key = `p|${base}|${accent}|${bandColor}|${size}|${seed}|${scale}|${octaves}|${mode}|${contrast}`;
  return cached(key, () => {
    const [W, H] = size;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    const img = g.createImageData(W, H);
    const d = img.data;
    const cBase = hexToRgb(base), cAcc = hexToRgb(accent);
    const cBand = bandColor ? hexToRgb(bandColor) : cAcc;

    for (let y = 0; y < H; y++) {
      const lat = (y / (H - 1) - 0.5) * Math.PI;
      const cy = Math.sin(lat), r = Math.cos(lat);
      for (let x = 0; x < W; x++) {
        const lon = (x / W) * Math.PI * 2;
        const px = Math.cos(lon) * r, py = cy, pz = Math.sin(lon) * r;
        let t;
        if (mode === 'gas' || mode === 'ice') {
          // 纬向条纹 + 湍流扰动
          const warp = (fbm3(px * 1.6, py * 1.6, pz * 1.6, 3, seed + 11) - 0.5) * (mode === 'gas' ? 0.55 : 0.22);
          const band = Math.sin((lat + warp) * (mode === 'gas' ? 16 : 7) + fbm3(px, py, pz, 2, seed) * 1.2);
          const detail = fbm3(px * scale * 1.4, py * scale * 1.4, pz * scale * 1.4, octaves, seed + 5);
          t = 0.5 + 0.5 * band * 0.62 + (detail - 0.5) * 0.5;
        } else if (mode === 'sun') {
          const gran = fbm3(px * scale * 2.2, py * scale * 2.2, pz * scale * 2.2, 4, seed);
          const spots = fbm3(px * 2.1, py * 2.1, pz * 2.1, 3, seed + 91);
          t = 0.62 + (gran - 0.5) * 0.9 - Math.max(0, spots - 0.72) * 2.4;
        } else if (mode === 'haze') {
          // 泰坦：橙黄色雾霾，几乎看不到地表
          const n = fbm3(px * 1.3, py * 1.3, pz * 1.3, 3, seed);
          const band = Math.sin(lat * 6 + n * 0.8) * 0.06;
          t = 0.5 + (n - 0.5) * 0.35 + band;
        } else if (mode === 'cantaloupe') {
          // 海卫一：哈密瓜皮状凹坑
          const cell = fbm3(px * 6, py * 6, pz * 6, 2, seed + 3);
          const rim = Math.abs(cell - 0.5) * 2;
          t = 0.42 + (1 - rim) * 0.32 + (fbm3(px * 2, py * 2, pz * 2, 3, seed) - 0.5) * 0.3;
        } else if (mode === 'volcanic') {
          // 木卫一：硫磺黄底 + 红褐火山斑 + 暗色破火山口
          const patch = fbm3(px * 2.4, py * 2.4, pz * 2.4, 4, seed);
          const vent = fbm3(px * 7, py * 7, pz * 7, 3, seed + 17);
          t = 0.42 + (patch - 0.5) * 1.5;
          if (vent > 0.66) t -= (vent - 0.66) * 2.6;
        } else if (mode === 'sponge') {
          // 土卫七：深孔洞
          const pit = fbm3(px * 5.5, py * 5.5, pz * 5.5, 4, seed + 7);
          t = 0.45 + (pit - 0.5) * 1.1 - Math.max(0, pit - 0.6) * 1.9;
        } else {
          const n = fbm3(px * scale, py * scale, pz * scale, octaves, seed);
          const n2 = fbm3(px * scale * 3.7, py * scale * 3.7, pz * scale * 3.7, 3, seed + 41);
          t = 0.5 + (n - 0.5) * 1.15 + (n2 - 0.5) * 0.35;
        }
        t = Math.max(0, Math.min(1, (t - 0.5) * contrast + 0.5));
        let col;
        if (mode === 'gas' || mode === 'ice') {
          col = ramp([[0, cBase], [0.45, mix(cBase, cBand, 0.55)], [0.62, cBand], [1, mix(cBand, cAcc, 0.7)]], t);
        } else if (mode === 'haze') {
          col = ramp([[0, mix(cBase, [90, 50, 10], 0.35)], [0.5, cBase], [1, mix(cBase, cAcc, 0.55)]], t);
        } else if (mode === 'volcanic') {
          col = ramp([[0, [60, 30, 20]], [0.28, cAcc], [0.52, cBase], [0.78, mix(cBase, [255, 250, 210], 0.5)], [1, [255, 252, 235]]], t);
        } else if (mode === 'cantaloupe') {
          col = ramp([[0, mix(cBase, [80, 60, 55], 0.45)], [0.5, cBase], [1, cAcc]], t);
        } else {
          col = ramp([[0, mix(cBase, [0, 0, 0], 0.42)], [0.4, cBase], [0.72, mix(cBase, cAcc, 0.65)], [1, cAcc]], t);
        }
        const i = (y * W + x) * 4;
        d[i] = clamp255(col[0]); d[i + 1] = clamp255(col[1]); d[i + 2] = clamp255(col[2]); d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);

    // 冰壳裂纹（欧罗巴 / 恩克拉多斯 / 天卫一…）
    if (mode === 'cracked') {
      const rnd = mulberry(seed * 613 + 29);
      g.lineCap = 'round';
      for (let k = 0; k < 130; k++) {
        const y0 = rnd() * H;
        const x0 = rnd() * W;
        const len = 60 + rnd() * 420;
        const ang = (rnd() - 0.5) * 0.7 + (rnd() < 0.5 ? 0.5 : -0.5);
        g.strokeStyle = `rgba(${cAcc[0]},${cAcc[1]},${cAcc[2]},${0.1 + rnd() * 0.4})`;
        g.lineWidth = 0.6 + rnd() * 2.4;
        g.beginPath();
        let x = x0, y = y0, a = ang;
        g.moveTo(x, y);
        for (let s = 0; s < 7; s++) {
          a += (rnd() - 0.5) * 0.5;
          x += Math.cos(a) * (len / 7);
          y += Math.sin(a) * (len / 7);
          g.lineTo(x, y);
        }
        g.stroke();
      }
    }

    // 土卫八：一面漆黑一面洁白
    if (mode === 'twotone') {
      const grad = g.createLinearGradient(0, 0, W, 0);
      grad.addColorStop(0, 'rgba(18,14,12,0.92)');
      grad.addColorStop(0.36, 'rgba(24,20,18,0.55)');
      grad.addColorStop(0.5, 'rgba(24,20,18,0)');
      grad.addColorStop(1, 'rgba(24,20,18,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, W, H);
    }

    // 撞击坑（rocky/cratered）
    if (mode === 'rocky' || mode === 'cratered' || mode === 'cracked' || mode === 'cantaloupe') {
      const rnd = mulberry(seed * 977 + 13);
      const count = mode === 'cratered' ? 260 : mode === 'rocky' ? 120 : 60;
      for (let k = 0; k < count; k++) {
        const cx = rnd() * W;
        const lat = (rnd() - 0.5) * 0.86 * Math.PI;
        const cy = (0.5 - lat / Math.PI) * H;
        const rr = (2 + rnd() * (mode === 'cratered' ? 13 : 8));
        const shade = 0.55 + rnd() * 0.5;
        const grad = g.createRadialGradient(cx, cy, rr * 0.15, cx, cy, rr);
        grad.addColorStop(0, `rgba(0,0,0,${0.34 * shade})`);
        grad.addColorStop(0.62, `rgba(0,0,0,${0.16 * shade})`);
        grad.addColorStop(0.78, `rgba(255,255,255,${0.13 * shade})`);
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grad;
        g.beginPath();
        g.arc(cx, cy, rr, 0, Math.PI * 2);
        g.fill();
      }
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    return tex;
  });
}

/** 从贴图派生一张粗糙度/凹凸用的灰度图 */
export function makeBumpFromTexture(src, strength = 0.6) {
  const key = `b|${src.uuid}|${strength}`;
  return cached(key, () => {
    const cv = document.createElement('canvas');
    cv.width = Math.min(512, src.image.width);
    cv.height = Math.min(256, src.image.height);
    const g = cv.getContext('2d');
    g.drawImage(src.image, 0, 0, cv.width, cv.height);
    const img = g.getImageData(0, 0, cv.width, cv.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114);
      const nv = clamp255(128 + (v - 128) * strength);
      d[i] = d[i + 1] = d[i + 2] = nv;
    }
    g.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = THREE.RepeatWrapping;
    return tex;
  });
}

/* ---------------- 星环 ---------------- */
export function makeRingTexture({ inner = 0.42, outer = 1, color = '#e8dcc0', seed = 5, bands = 90, gaps = 0.34 } = {}) {
  const key = `r|${inner}|${outer}|${color}|${seed}|${bands}|${gaps}`;
  return cached(key, () => {
    const W = 1024, H = 8;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    const img = g.createImageData(W, H);
    const d = img.data;
    const c = hexToRgb(color);
    const rnd = mulberry(seed * 1013 + 7);
    const noise = [];
    for (let i = 0; i < bands; i++) noise.push(0.35 + rnd() * 0.65);
    for (let x = 0; x < W; x++) {
      const t = x / (W - 1);
      let a = noise[Math.floor(t * bands) % bands] ?? 0.6;
      // 卡西尼环缝等大间隙
      const gapAt = [0.31, 0.52, 0.78];
      for (const gp of gapAt) a *= 1 - gaps * Math.exp(-Math.pow((t - gp) / 0.022, 2));
      a *= 0.55 + 0.45 * Math.sin(t * 47 + seed) * 0.5 + 0.35;
      const bright = 0.72 + 0.28 * Math.sin(t * 23.7 + 1.3);
      const edge = Math.min(1, Math.min(t, 1 - t) / 0.045);
      a = Math.max(0, Math.min(1, a * bright * edge));
      const col = mix(c, [255, 255, 255], (bright - 0.6) * 0.5);
      for (let y = 0; y < H; y++) {
        const i = (y * W + x) * 4;
        d[i] = clamp255(col[0]); d[i + 1] = clamp255(col[1]); d[i + 2] = clamp255(col[2]); d[i + 3] = clamp255(a * 255);
      }
    }
    g.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  });
}

/* ---------------- 行星环（四套真实结构，2026-10-11 重做） ----------------
 *
 * ⚠️⚠️ 为什么重做：旧口径只有两种——土星用 `saturn_ring.png`（偏暗），
 *   **其余行星一律用 `makeRingTexture({color})` + opacity 0.45**。实测后果：
 *   天王星 / 海王星被画成了土星级的大亮环，而真实情况是：
 *     · 天王星环 = 13 条**极窄**的暗环（1977 年掩星才发现），最亮的 ε 环也只是中性灰，
 *       且宽度只有几十公里 —— 在行星尺度上就是几根细线；
 *     · 海王星环 = 5 条暗环 + Adams 环上的亮度弧段，比天王星更暗；
 *     · 木星环 = 极暗的尘埃环（背光才看得见）。
 *   （这些行星 `ring` 数据里的 note 自己都写着「极暗」「细窄的暗环」——
 *    数据是对的，错的是渲染层把它们全画成了土星。）
 *
 * 四套都做成**径向条带**（W×H=1024×8，`makeRingMesh` 的 UV 沿半径展开），
 * 半径→参数 t 的映射写死在每套函数里，出处 = 实测环半径（NASA/IPAC 事实表）。
 * 结构区段一律用**真实半径**算 t，不拍脑袋分。 */

/** 土星环：C / B / 卡西尼缝 / A（含恩克缝）/ Roche 段 / F 环。
 *
 *  实测区段（km → t = (r−74500)/(140220−74500)）：
 *    C 环        74,658–92,000    t 0.002–0.266   暗棕、半透明（B 环的 ~35% 亮度）
 *    B 环        92,000–117,580   t 0.266–0.655   **亮象牙白**，有细环理
 *    卡西尼缝    117,580–122,170  t 0.655–0.725   近黑（不是没有物质，是稀薄）
 *    A 环        122,170–136,775  t 0.725–0.947   中亮（B 的 ~72%），恩克缝在 133,589（t≈0.899）
 *    Roche 段    136,775–140,180  t 0.947–0.998   近黑
 *    F 环        140,180          t ≈0.998        一根细亮线
 *  颜色基准：卡西尼号真彩里 B 环是亮象牙/淡金（不是照片滤镜的土黄），C 环偏暗褐。
 */
export function makeSaturnRingTexture({ seed = 5 } = {}) {
  return cached(`rsat|${seed}`, () => {
    const W = 1024, H = 8;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    const img = g.createImageData(W, H);
    const d = img.data;
    const rnd = mulberry(seed * 1013 + 7);
    const T = (km) => (km - 74500) / (140220 - 74500);
    const bands = [];
    for (let i = 0; i < 140; i++) bands.push(rnd());          // 细环理查表
    const bandAt = (t, k) => bands[Math.floor(t * bands.length + k * 37) % bands.length];
    // 各区段的（亮度, 颜色）——线性插值取点，细环理叠在上面
    const profile = (t) => {
      const seg = [
        [T(74658), 0.30, [176, 158, 136]],   // C 内缘
        [T(82000), 0.34, [180, 160, 134]],
        [T(92000), 0.42, [186, 168, 140]],   // C 外缘（C 环整体偏暗褐）
        [T(98000), 0.92, [238, 226, 198]],   // B 环内段（亮象牙）
        [T(108000), 0.86, [232, 220, 196]],
        [T(117580), 0.78, [228, 216, 194]],  // B 外缘
        [T(119000), 0.10, [120, 112, 104]],  // 卡西尼缝
        [T(122170), 0.09, [118, 112, 106]],
        [T(123500), 0.62, [222, 212, 192]],  // A 环内段
        [T(130000), 0.66, [224, 214, 194]],
        [T(133300), 0.60, [220, 210, 190]],
        [T(134200), 0.58, [218, 208, 188]],  // 恩克缝后
        [T(136775), 0.52, [214, 205, 186]],  // A 外缘
        [T(139000), 0.03, [110, 105, 100]],  // Roche 段
        [T(140100), 0.03, [110, 105, 100]],
      ];
      let v = seg[seg.length - 1];
      for (let i = 0; i < seg.length - 1; i++) {
        const [t0, a0, c0] = seg[i], [t1, a1, c1] = seg[i + 1];
        if (t >= t0 && t <= t1) {
          const u = (t - t0) / (t1 - t0 || 1);
          return [a0 + (a1 - a0) * u,
            [c0[0] + (c1[0] - c0[0]) * u, c0[1] + (c1[1] - c0[1]) * u, c0[2] + (c1[2] - c0[2]) * u]];
        }
      }
      return [v[1], v[2]];
    };
    for (let x = 0; x < W; x++) {
      const t = x / (W - 1);
      let [a, col] = profile(t);
      // 细环理：几个互质周期的噪声（不出现可见的规则条纹）
      a *= 0.88 + 0.12 * bandAt(t, 1) + 0.06 * bandAt(t, 2) - 0.06 * bandAt(t, 3);
      // 恩克缝（133,589 km，宽 325 km → Δt≈0.005）与 F 环
      a *= 1 - 0.82 * Math.exp(-Math.pow((t - T(133589)) / 0.004, 2));
      const fEdge = Math.exp(-Math.pow((t - T(140180)) / 0.0028, 2));
      const fCol = [236, 228, 208];
      const edge = Math.min(1, Math.min(t, 1 - t) / 0.004);
      a = Math.max(0, Math.min(1, a * edge));
      const cr = col[0] * (1 - fEdge) + fCol[0] * fEdge;
      const cg = col[1] * (1 - fEdge) + fCol[1] * fEdge;
      const cb = col[2] * (1 - fEdge) + fCol[2] * fEdge;
      const af = Math.min(1, a + fEdge * 0.55);
      for (let y = 0; y < H; y++) {
        const i = (y * W + x) * 4;
        d[i] = clamp255(cr); d[i + 1] = clamp255(cg); d[i + 2] = clamp255(cb);
        d[i + 3] = clamp255(af * 255);
      }
    }
    g.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  });
}

/** 天王星环：13 条窄环中最先确认的 10 条（1986 旅行者 2 号口径），ε 最宽最亮。
 *
 *  实测半径（×10³ km → t = (r−38000)/13150）：
 *    6:41.8 → 0.289 · 5:42.2 → 0.319 · 4:42.6 → 0.349 · α:44.7 → 0.509 · β:45.7 → 0.585
 *    η:47.2 → 0.699 · γ:47.6 → 0.730 · δ:48.3 → 0.783 · λ:50.0 → 0.912 · ε:51.15 → 0.996
 *  颜色：**中性灰**（反照率 ~0.05 的脏冰，不是蓝色）。ε 环宽 ~100 km、其余 1–10 km
 *  ——在环半径尺度上全是亚像素细线，用高斯线宽画。 */
export function makeUranusRingTexture() {
  return cached('rura', () => {
    const W = 1024, H = 8;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    const img = g.createImageData(W, H);
    const d = img.data;
    const T = (Mm) => (Mm * 1000 - 38000) / 13150;
    const rings = [
      [T(41.8), 0.20], [T(42.2), 0.18], [T(42.6), 0.18], [T(44.7), 0.30],
      [T(45.7), 0.32], [T(47.2), 0.24], [T(47.6), 0.30], [T(48.3), 0.30],
      [T(50.0), 0.16], [T(51.15), 0.55],   // ε 环：最亮
    ];
    const epsW = 0.006;                    // ε 环最宽（~100 km 相对量级）
    for (let x = 0; x < W; x++) {
      const t = x / (W - 1);
      let a = 0;
      for (const [tr, amp] of rings) {
        const w = tr > 0.95 ? epsW : 0.0016;
        a += amp * Math.exp(-Math.pow((t - tr) / w, 2));
      }
      a = Math.min(1, a);
      // 中性灰，略带暖（旅行者 2 号相片里 ε 环是灰白）
      for (let y = 0; y < H; y++) {
        const i = (y * W + x) * 4;
        d[i] = clamp255(150 + a * 70); d[i + 1] = clamp255(148 + a * 68); d[i + 2] = clamp255(146 + a * 64);
        d[i + 3] = clamp255(a * 255);
      }
    }
    g.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  });
}

/** 海王星环：Galle（宽而极暗）/ LeVerrier / Lassell（宽晕）/ Arago / Adams（含弧段）。
 *
 *  实测半径（×10³ km → t = (r−41900)/21030）：
 *    Galle 41,900（宽 ~2,000 km，极暗）→ t 0（带宽 0.095）
 *    LeVerrier 53,200 → 0.537 · Lassell 55,200–57,200 → 0.632–0.727（宽晕，最暗）
 *    Arago 57,600 → 0.746 · Adams 62,930 → 0.998（亮弧：Fraternalé/Courageux 等 5 段）
 *  颜色：暗红灰（尘埃反照率 ~0.03——海王星环是太阳系最暗的环之一）。 */
export function makeNeptuneRingTexture() {
  return cached('rnep', () => {
    const W = 1024, H = 8;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    const img = g.createImageData(W, H);
    const d = img.data;
    const T = (Mm) => (Mm * 1000 - 41900) / 21030;
    // Adams 环的 5 条亮度弧（1989 旅行者 2 号命名）：方位角只在三维里表达不了，
    // 这里取「弧段比环身亮」的统计形态：沿 t 方向不可表达方位 ⇒ Adams 整圈稍亮 + 不均匀纹理。
    for (let x = 0; x < W; x++) {
      const t = x / (W - 1);
      const galle = 0.16 * Math.exp(-Math.pow((t - T(41.9)) / 0.048, 2));
      const leverrier = 0.30 * Math.exp(-Math.pow((t - T(53.2)) / 0.0016, 2));
      const lassell = 0.10 * Math.exp(-Math.pow((t - T(56.2)) / 0.048, 2));
      const arago = 0.18 * Math.exp(-Math.pow((t - T(57.6)) / 0.0016, 2));
      const adams = 0.42 * Math.exp(-Math.pow((t - T(62.93)) / 0.0016, 2));
      const a = Math.min(1, galle + leverrier + lassell + arago + adams);
      for (let y = 0; y < H; y++) {
        const i = (y * W + x) * 4;
        d[i] = clamp255(148 + a * 60); d[i + 1] = clamp255(138 + a * 56); d[i + 2] = clamp255(132 + a * 52);
        d[i + 3] = clamp255(a * 255);
      }
    }
    g.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  });
}

/** 木星环：Halo（92–122.5 Mm，极暗云状）+ Main（122.5–129 Mm，稍亮）。
 *  数据表 outerKm=129,000 正好是 Main 环外缘。亮度：满月下都看不见的尘埃环，
 *  texture 里给足结构、透明度交给调用方压到极低。 */
export function makeJupiterRingTexture() {
  return cached('rjup', () => {
    const W = 1024, H = 8;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    const img = g.createImageData(W, H);
    const d = img.data;
    const T = (Mm) => (Mm * 1000 - 122000) / 7000;
    for (let x = 0; x < W; x++) {
      const t = x / (W - 1);
      // Main 环：内缘渐入、外缘在 129 Mm 处骤降（真实形态）
      const main = 0.5 * Math.min(1, t / 0.12) * Math.exp(-Math.pow((t - 0.99) / 0.06, 2)) + 0.18 * Math.min(1, t / 0.12);
      const a = Math.min(1, main);
      for (let y = 0; y < H; y++) {
        const i = (y * W + x) * 4;
        d[i] = clamp255(172 + a * 40); d[i + 1] = clamp255(158 + a * 36); d[i + 2] = clamp255(138 + a * 30);
        d[i + 3] = clamp255(a * 255);
      }
    }
    g.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  });
}

/* ---------------- 光晕 / 星点 ---------------- */
export function makeGlowTexture(color = '#ffcf5c', softness = 0.28, size = 256) {
  return cached(`g|${color}|${softness}|${size}`, () => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const g = cv.getContext('2d');
    const c = hexToRgb(color);
    const img = g.createImageData(size, size);
    const d = img.data;
    const half = size / 2;
    const exp = Math.max(1.5, 3.8 - softness * 3.0);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (x - half) / half, dy = (y - half) / half;
        const r = Math.sqrt(dx * dx + dy * dy);
        const a = r >= 1 ? 0 : Math.pow(1 - r, exp);
        const core = Math.max(0.1, 1 - softness * 1.5);
        const white = Math.min(1, Math.max(0, (1 - r / core) * 1.25));
        const i = (y * size + x) * 4;
        d[i] = clamp255(c[0] + (255 - c[0]) * white);
        d[i + 1] = clamp255(c[1] + (255 - c[1]) * white);
        d[i + 2] = clamp255(c[2] + (255 - c[2]) * white);
        d[i + 3] = clamp255(a * 255);
      }
    }
    g.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    /* ⚠️⚠️ **必须关掉 mipmap**（并显式给 `minFilter`），否则**圆盘缩小后会退化成方块**。
     *
     * ── 这条规则**已经被 A/B 直接测到**（2026-09-11 第 24 轮，`tools/probe-bloom-sweep.py`）──
     * 用**一个** Sprite（单实例、不累积）缩到盘面点云那个尺寸档（~3 px），只切 mipmap：
     *
     *     mipmap **开**   scale 0.5  外接框 64×64  对角比 **1.423**  ⇒ **方**
     *     mipmap **关**   scale 0.5  外接框 48×32  对角比 **0.958**  ⇒ **圆**
     *     mipmap **开**   scale 0.25 外接框 32×32  对角比 **1.438**  ⇒ **方**
     *     mipmap **关**   scale 0.25 外接框 32×16  对角比 **0.521**  ⇒ **圆**
     *
     * 机制：圆盘在**很粗的 mip 层**上，平均 alpha 已经铺满整个方形 texel
     * （最粗的 1×1 mip 就是整张图的平均值，**永远非零** —— 这一层不可能保住圆形），
     * 材质的 `alphaTest: 0.01` 再一放行 ⇒ 每个点渲染成一块小方片。
     * 这一条对**所有**用 `makeGlowTexture` 的层都成立（盘面点云、棒、太阳标记、核球…）。
     *
     * ⚠️⚠️ **但它不是「中央那块几百像素大方斑」的原因 —— 别再把它当那个用**。
     *   第 23 轮我把它当成了方斑的真身，**错了**。第 24 轮做消融定位（`probe-square-origin.py`）：
     *     · 泛光**关**：核球 100×66 对角比 0.917 **圆**；10 万颗星 48×47 对角比 0.808 **圆**
     *     · 泛光**开**：核球 317×316 对角比 1.140 **方**；10 万颗星 643×650 对角比 1.146 **方**
     *     · 核球**摘掉贴图**（`map = null`，泛光关）102×67 对角比 0.916 ⇒ **仍是圆**
     *   ⇒ 大方斑是 **`UnrealBloomPass` 画的**（`mw-bulge` 与 `mw-hyg-stars` 两个毫不相干的层
     *     都在泛光开时冒出同一个方框，泛光一关就都没了）。**贴图改了也动不了它。**
     *
     * ⚠️ 这条改动的**代价要写清**（也是量出来的，别当没有）：
     *   · 单点亮度 **+56%**（同一个精灵峰值 106.1 → 165.4）。原因是关掉 mipmap 后，
     *     采样落在圆盘**中心**（alpha≈1）而不是粗 mip 的平均值（≈0.14）。
     *   · 汇总后果：全局核区线性值由 **7.5 抬到 10.1（+34%）**
     *     ⇒ **凡是在这之前校准过的「该降多少倍」全部作废，必须重标**。
     *   · 远小于贴图的点（本层正是这种）在相机移动时可能**轻微闪烁**（基础层点采样）。
     *     两害相权：方块是**结构性错误**，闪烁是**运动中的噪声** —— 取前者。
     */
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    return tex;
  });
}

/** 着陆点 / 坠落点标记：圆形准星 */
export function makePinTexture(color = '#ff9a5c', size = 128) {
  return cached(`pin|${color}|${size}`, () => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const g = cv.getContext('2d');
    const c = hexToRgb(color);
    const rgb = `${c[0]},${c[1]},${c[2]}`;
    const r = size / 2;
    // 外圈
    g.strokeStyle = `rgba(${rgb},0.95)`;
    g.lineWidth = size * 0.055;
    g.beginPath();
    g.arc(r, r, r * 0.74, 0, Math.PI * 2);
    g.stroke();
    // 内圈
    g.strokeStyle = 'rgba(255,255,255,0.85)';
    g.lineWidth = size * 0.022;
    g.beginPath();
    g.arc(r, r, r * 0.50, 0, Math.PI * 2);
    g.stroke();
    // 十字准星
    g.strokeStyle = `rgba(${rgb},0.95)`;
    g.lineWidth = size * 0.045;
    g.beginPath();
    g.moveTo(r, r * 0.02); g.lineTo(r, r * 0.30);
    g.moveTo(r, r * 0.70); g.lineTo(r, r * 0.98);
    g.moveTo(r * 0.02, r); g.lineTo(r * 0.30, r);
    g.moveTo(r * 0.70, r); g.lineTo(r * 0.98, r);
    g.stroke();
    // 中心点
    g.fillStyle = 'rgba(255,255,255,0.95)';
    g.beginPath();
    g.arc(r, r, r * 0.09, 0, Math.PI * 2);
    g.fill();
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  });
}

export function makeStarTexture(color = '#ffffff') {
  return cached(`s|${color}`, () => {
    const size = 128;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const g = cv.getContext('2d');
    const c = hexToRgb(color);
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.16, `rgba(${c[0]},${c[1]},${c[2]},0.92)`);
    grad.addColorStop(0.36, `rgba(${c[0]},${c[1]},${c[2]},0.22)`);
    grad.addColorStop(1, `rgba(${c[0]},${c[1]},${c[2]},0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    // 十字衍射星芒
    g.globalCompositeOperation = 'lighter';
    const spike = g.createLinearGradient(0, size / 2, size, size / 2);
    spike.addColorStop(0, 'rgba(255,255,255,0)');
    spike.addColorStop(0.5, 'rgba(255,255,255,0.5)');
    spike.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = spike;
    g.fillRect(0, size / 2 - 1, size, 2);
    const spike2 = g.createLinearGradient(size / 2, 0, size / 2, size);
    spike2.addColorStop(0, 'rgba(255,255,255,0)');
    spike2.addColorStop(0.5, 'rgba(255,255,255,0.4)');
    spike2.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = spike2;
    g.fillRect(size / 2 - 1, 0, 2, size);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  });
}

/* ---------------- 星系贴图（用于本星系群尺度） ---------------- */
/* =========================================================================
 * 银河系结构常数与螺旋公式 —— **全项目唯一权威**（改这里就改全局）
 * =========================================================================
 * 为什么放这里：`levels/galaxy.js`（点云旋臂 + 导引线）和本文件的
 *   `makeMilkyWayDiskTexture`（盘面贴图）画的是**同一条旋臂**。
 *   两边各写一套公式时，贴图画的臂和粒子撒的臂根本对不上 —— 画面就是「四不像」。
 *   `objects/builders.js` 本来就 import 本文件，放这里不产生循环依赖。
 *
 * 口径（2026-09-11 用三个独立来源核对，结果一致）：
 *     对数螺旋   r = a · e^(b·θ)  ≡  r = r₀ · e^((θ−θ₀)·tan i)
 *   ⇒ **b = tan(i)**，i 是**倾角**：臂的切线与「同半径的圆」的夹角
 *   ⇒ i → 0 退化成**圆**（绕得紧）；i → π/2 退化成**径向射线**（绕得松）
 * 来源：Binney & Tremaine 式 (6-2) `cot i = r·dθ/dr`（arXiv:1707.04001 复述）；
 *       Bajkova & Bobylev 2014 式 (1)(4) `R = a₀·e^((θ−θ₀)·tan i)`（arXiv:1310.3974）；
 *       NGC 1097 论文 `cot ζ = dφ/dln R` 且 `ζ = tan⁻¹b₀`。
 * 银河系实测 i ≈ 12°（四个主旋臂）。
 *
 * ⚠️⚠️ 2026-09-11 的教训（**坑 97**）：这里一度写成 `b = 1/tan(12°) = 4.704` ——
 *   **把 cot 当成了 tan**。4.704 反解倾角 = 78°，正好是「接近径向射线」那一档，
 *   画出来是**四根笔直的辐条**（`shots/probe-galaxy-*.png` 上明晃晃的 X 形）。
 *   更糟的是这个错被同时抄进了 `levels/galaxy.js` —— 两处一起错，谁也纠正不了谁。
 *   **记法：i = 0 是圆 ⇒ 倾角小 = 绕得紧。**
 *
 * 一个自带的自查（用它替代「凭眼睛调参数」）：
 *   臂间径向间距 λ = 2π·R₀·tan i / m。代入 R₀ = 8.3 kpc、i = 12°、m = 4 ⇒ λ ≈ 2.8 kpc ≈ 9 kly。
 *   太阳附近「人马臂 ↔ 英仙臂」实测间距正是 2~3 kpc ⇒ 自洽。
 *   若把 b 写成 cot(12°)，λ 会大 22 倍 —— 一眼假。
 * ========================================================================= */
export const MW_R = 52.8;                      // 银盘（星盘）半径 kly
export const MW_SUN_R = 26.7;                  // 太阳距银心 kly（26.8 ± 0.5）
export const MW_BAR_HALF = 10;                 // 棒的半长 kly（ESA: peanut-shaped bar, ~10,000 ly）
export const MW_BAR_ANG = 44 * Math.PI / 180;  // 棒长轴相对「太阳–银心连线」的方位角 44° ± 10°
/** 对数螺旋的 b = tan(倾角)。**不要写成 cot。** */
export const MW_B = Math.tan(12 * Math.PI / 180);   // ≈ 0.21266
/** 旋臂锚定半径 kly（仅作 `spiralTheta` 的默认值与兜底；真实值见 `MW_ARMS`）。 */
export const MW_ARM_R0 = 9;
/* ⚠️ 口径转换，踩过一次：粒子棒写成 `bx = u·sin(BAR_ANG), bz = u·cos(BAR_ANG)`，
 *   它在 (x,z) 极坐标里的方位角是 `atan2(bz, bx) = 90° − BAR_ANG = 46°`。
 *   所以 MW_BAR_AZ = 46°，**不是 44°** —— 直接把 44° 当方位角用会和棒错开 88°。 */
export const MW_BAR_AZ = Math.PI / 2 - MW_BAR_ANG;   // = 46°

/* =========================================================================
 * ★★ 银河系旋臂 —— 倾角/臂宽取实测，半径跨度与相位是**构造值**
 * -------------------------------------------------------------------------
 * ⚠️⚠️ 坑 98（2026-09-11，同一件事踩了两次，值得完整写下来）
 *
 * 第一版：严格按 Reid et al. 2019 (ApJ 885,131) 的**逐臂实测参数**实现 ——
 *   模型 `ln R = ln Rk − (β−βk)·tan ψ`，逐臂不同的 (Rk, βk, ψ)，并且严格限定在
 *   实测覆盖的 β 区间内。**公式一个字都没错**，画出来却是一圈一圈的**同心涟漪**，
 *   用户直接评「你这银河系真是假爆了」。原因不在公式，在**弧的半径跨度**：
 *
 *       一条臂每转一圈，半径涨多少倍？        ρ = e^(2π·tan ψ)
 *           ψ = 12°  ⇒  ρ ≈ 3.8     ← 转两圈就跨完整个银盘 ⇒ 看起来像**螺旋**
 *           ψ = 20°  ⇒  ρ ≈ 9.8
 *
 *   而「实测弧」只覆盖 50°~140° 方位角，等效 ρ 只有 **1.2~2 倍** ——
 *   **一条半径几乎不变的弧，画出来就是一圈环。跟倾角准不准没有关系。**
 *
 * ⇒ **判据留下来：臂必须跨足「倍数半径」（这里 10 → 48 kly ≈ 4.8 倍），
 *   否则无论倾角多准，得到的都只是靶子。**
 *
 * 现在的分工：
 *   · **实测值**：倾角 ψ、臂宽 width（都是 Reid 2019 的表）。
 *   · **构造值**：相位（artist's map 的对称四臂）与半径跨度。理由 ——
 *     实测的 β 区间本身是**巡天覆盖范围**的产物，不是星系的物理性质
 *     （远侧没有 maser 视差数据，于是没有弧）。把它当图形边界，
 *     等于把「我们没观测到」画成「这里没有臂」。
 * ========================================================================= */
export const KPC2KLY = 3.2616;              // 1 kpc = 3.2616 kly
/** 臂的起点半径（kly）—— 臂从**棒的两端**甩出，所以起点就是棒的半长。 */
export const MW_ARM_R_START = 10;
/** 4 条主臂。`psi` / `wArm` = Reid 2019 实测；`phase` = 构造值。 */
export const MW_ARMS = [
  { name: 'Scutum-Centaurus',   psi: 12.1, wArm: 0.50, phase: MW_BAR_AZ,                    w: 1.00 },
  { name: 'Sagittarius-Carina', psi: 17.1, wArm: 0.42, phase: MW_BAR_AZ + Math.PI * 0.5,    w: 1.00 },
  { name: 'Perseus',            psi:  8.7, wArm: 0.35, phase: MW_BAR_AZ + Math.PI,          w: 1.00 },
  { name: 'Outer',              psi:  9.4, wArm: 0.45, phase: MW_BAR_AZ + Math.PI * 1.5,    w: 0.80 },
];

/**
 * 某条臂的**实际**扫角（rad）—— 即「从棒端恰好走到盘边」所需的方位角，**不设上限**。
 *
 * ⚠️⚠️ 2026-09-11 第 21 轮：这里原来有一句 `Math.min(400°, need)`，**它是错的，要删**。
 *
 * 那个上限当初是为「拦住 ψ 大的臂甩到 85 kly 飞出银盘」加的 ——
 * 但那次飞出去的真因是 `need` 的公式当时写反了（cot/tan，见坑 97）。
 * 公式修正之后，`need` 本身**恒等于**「走到盘边」：
 *      `r(t=1) = R0 · e^(φ·tan ψ)`，代入 `φ = ln(MW_R/R0)/tan ψ` ⇒ **恰好 = MW_R**。
 * 所以它**不可能**再飞出银盘，上限只剩副作用：
 *
 *     实测每条臂走到哪（`node -e` 导出 armPoint 的真实值）：
 *       Scutum-Centaurus  12.1°  400° 封顶 → 只到 44.7 kly
 *       Sagittarius-Carina 17.1°  310°    → 52.8 kly ✓
 *       Perseus            8.7°  400° 封顶 → 只到 **29.1 kly**
 *       Outer              9.4°  400° 封顶 → 只到 **31.8 kly**
 *     而盘半径是 52.8 kly。
 *
 * ⇒ **盘的外半圈几乎一条臂都没有，四条臂全挤在内半盘。**
 *    画面上就是「核外面套几圈同心环」—— 这正是用户说的「你这银河系真是假爆了」。
 *    ⚠️ 注意这**不是**坑 98 的另一面，是**另一个**独立缺陷：坑 98 是弧的半径跨度不够，
 *    这里是半径跨度够、但**被一个上限腰斩**。两次都栽在「跨度」，两次的原因不同。
 *
 * 去掉上限后每条臂都走到盘边。ψ 小的臂要盘很多圈 —— Perseus(8.7°) 需要 623° = 1.73 圈，
 * 那是 8.7° 这个倾角的**几何后果**，不是 bug。对数螺旋不会自交：
 * 它绕回同一方位角时半径已经不同了。
 */
export function armSweep(arm) {
  return Math.log(MW_R / MW_ARM_R_START) / Math.tan(arm.psi * Math.PI / 180);
}

/**
 * 在臂上按**面积权重**取一个半径，返回对应的参数 `t`。
 *
 * ⚠️ 为什么不能直接 `armPoint(arm, rnd())`（2026-09-11 第 21 轮，坑 100）：
 * 对数螺旋的 `r(t) = R0 · e^(t·φ·tan ψ)` 是**指数**的 ⇒ **t 均匀 = r 对数均匀**
 * ⇒ **绝大多数点挤在棒端附近**。实测（`node -e` 直接导出）：
 *      Perseus(8.7°)   89% 的臂点落在**半个盘半径以内**
 *      Scutum(12.1°)   57%
 * 而面积均匀时的期望比例是 `(26²−10²)/(52.8²−10²) = 21%`。
 * 后果：四条臂全堆在内半盘、外半盘一条臂也没有 ⇒ 画面上就是
 * 「核外面套几圈同心环」—— 用户说的「你这银河系真是假爆了」。
 *
 * ⚠️ 这跟坑 98、以及「400° 上限」**都不是同一件事**：
 *    坑 98 是弧的跨度不够；400° 上限是跨度够了但被腰斩；这里是**跨度够了但点全挤在一头**。
 *    同一个「跨度」上栽了三次，前两次都没找到全部原因 —— 所以三次都要留下判据。
 *
 * @param {object} arm `MW_ARMS` 里的一条
 * @param {number} u   [0,1) 均匀随机数
 * @returns {number}   t ∈ [0,1]
 */
export function armTForArea(arm, u) {
  const R0 = MW_ARM_R_START, R1 = MW_R;
  // 面积均匀 ⇒ dN/dr ∝ r ⇒ r = √(R0² + u·(R1²−R0²))
  const r = Math.sqrt(R0 * R0 + u * (R1 * R1 - R0 * R0));
  const denom = armSweep(arm) * Math.tan(arm.psi * Math.PI / 180);
  return Math.min(1, Math.max(0, Math.log(r / R0) / denom));
}

/**
 * 某条臂在参数 t∈[0,1] 上的位置。**撒点 / 画盘面贴图 / 画导引线都用这一个。**
 *
 * 螺旋：`r(t) = R_start · e^(t·φ·tan ψ)`，`a(t) = phase + t·φ`（φ = 该臂的实际扫角）。
 * ⚠️ `a` 随 t 增大（还是减小）决定**旋向** —— trailing / leading 互为镜像。
 *    真实银河系的旋臂是**后随臂 trailing**，这里取「r 增大时 a 也增大」这一支。
 *
 * ⚠️ **撒点时 t 不要直接用 `rnd()`** —— 见 `armTForArea()`，那会把点全堆到棒端。
 *
 * @returns {{r:number, a:number, w:number, clump:number}}
 *          `r` 单位 kly；`a` 是场景方位角（位点 `x=cos a·r, z=sin a·r`）；
 *          `w` 是亮度权重 = 臂权重 × 两端渐隐 × 外缘渐暗 × 团块因子。
 *          ⚠️ **两端渐隐不是美化，是必需**：末端不渐隐的臂会直接封口成环。
 */
export function armPoint(arm, t) {
  const phi = armSweep(arm);
  const r = MW_ARM_R_START * Math.exp(t * phi * Math.tan(arm.psi * Math.PI / 180));
  const fade = Math.min(1, t / 0.08) * Math.min(1, (1 - t) / 0.25);   // 起端接棒、末端渐隐
  const outer = 1 - 0.55 * Math.max(0, (r - 24) / (MW_R - 24));      // 外缘渐暗
  // 团块因子：真实旋臂是「一串结 + 空隙」交替，不是一条均匀亮线。
  // 两个互质周期叠加，避免出现肉眼能看出的规则条纹。
  const lump = 0.5 + 0.5 * Math.sin(t * 47 + arm.phase * 5);
  const clump = 0.35 + 0.65 * lump * lump * (0.6 + 0.4 * Math.sin(t * 13.7 + 1.3));
  return { r, a: arm.phase + t * phi, w: arm.w * fade * outer * clump, clump };
}

/**
 * 对数螺旋：银心距 → 方位角。**全项目只此一份**。
 * @param {number} r 银心距（与 r0 同单位）
 * @param {{phase?:number, r0?:number, b?:number}} [o]
 *        phase 该臂在 r = r0 处的方位角；r0 锚定半径；b 紧密度（默认 = tan 倾角）
 */
export function spiralTheta(r, { phase = 0, r0 = MW_ARM_R0, b = MW_B } = {}) {
  // r < r0 时夹住、不让它继续往银心卷：内区由**棒 + 核球**负责。
  // 放开 ln(r/r0) → −∞ 会把臂在银心卷成一团（真实旋臂本来也不伸进棒里）。
  return phase + Math.log(Math.max(r, r0) / r0) / b;
}

/** 盘面贴图的**外缘渐隐** —— 两张盘面贴图共用这一步（**单一来源，别各写一份**）。
 *
 * 为什么必须有：不做这一步，盘面的点云/几何会在盘边形成**一圈一刀切的硬边**
 * （用户原话：「边缘没有淡出效果」）。`makeMilkyWayDiskTexture` 一直有，
 * `makeGalaxyTexture` 一直没有 —— 同一件事两处各写一套，**这次就是它漂开了**。
 *
 * ⚠️ 判据只看「这一步在不在」（自检项 `textures.disc-edge-fade`，源码级）：
 *    读像素那条路**分不清**它与旋臂自己的末端渐隐（后者是必需的，坑 98），
 *    把 `destination-in` 删掉读像素照样绿 —— 试过，是假绿。
 *
 * @param {CanvasRenderingContext2D} g
 * @param {number} inner 开始渐隐的半径（px）
 * @param {number} outer 渐隐到 0 的半径（px）
 * @param {number} size 画布边长（px）
 */
function fadeDiscEdge(g, cx, cy, inner, outer, size) {
  g.globalCompositeOperation = 'destination-in';
  const grad = g.createRadialGradient(cx, cy, inner, cx, cy, outer);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.92)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
}

/** 通用星系盘贴图（旋涡 / 椭圆 / 不规则矮星系）。**给远景精灵和有朝向的盘面共用。**
 *
 * ⚠️ 2026-09-12 改过算法，两处都是**把已经写下来的教训搬过来**，不是重新调参：
 *
 *  ① **旋臂必须「沿臂多重描边」，不能撒点。** `makeMilkyWayDiskTexture` 的注释
 *     早就写过：「撒点画出来的臂要么太细（像画上去的线），要么为了加宽而堆到过曝发白
 *     —— 都试过，都不像星系」。本函数原来正是那套被否掉的撒点法（9000 个 `arc`），
 *     所以远景星系的臂「差点意思」。
 *  ② **末尾必须做外缘渐隐。** 这一步原来**只有银河系那张贴图有**，
 *     这里没有 ⇒ 盘边是一刀切的硬边，也就是「边缘没有淡出效果」。
 *
 * 取点口径同 `armTForArea` 那条教训（坑 101）：对数螺旋按参数 `t` 均匀取点
 * 会把点全堆到内侧，所以这里**按面积均匀**抽半径（r² 线性）再反解方位角。
 *
 * @param {object} [o]
 * @param {'spiral'|'elliptical'|'dwarf'|'irregular'} [o.type]
 * @param {number|null} [o.squash] 盘面在贴图里的纵向压缩（视觉上的「略微倾斜」）。
 *        ⚠️ **默认按类型给一个值；有真实倾角的星系必须传 `1`** ——
 *        那些盘面由 `builders.js::makeGalaxyDisc` 在三维里用真实倾角摆，
 *        贴图里再压扁一次就等于**把倾角算了两遍**。
 */
export function makeGalaxyTexture({ type = 'spiral', color = '#cfe0ff', seed = 3, size = 512, squash = null } = {}) {
  const sq = squash ?? (type === 'elliptical' || type === 'dwarf' ? 0.78 : type === 'irregular' ? 0.72 : 0.94);
  /* ⚠️ 缓存键前缀 `gal2`：算法换过一次，换前缀保证同一次页面加载里
   *    不会拿到按旧算法生成的那张。`squash` 也进键 —— 它改变输出像素。 */
  return cached(`gal2|${type}|${color}|${seed}|${size}|${sq}`, () => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const g = cv.getContext('2d');
    const cx = size / 2, cy = size / 2;
    const c = hexToRgb(color);
    const rnd = mulberry(seed * 7919 + 3);
    g.globalCompositeOperation = 'lighter';
    /** 外缘渐隐的外半径：按分支给（见函数末尾那一步）。 */
    let fadeOuter = size * 0.46;

    if (type === 'elliptical' || type === 'dwarf') {
      fadeOuter = size * 0.44;
      for (let k = 0; k < 900; k++) {
        const a = rnd() * Math.PI * 2;
        const rr = Math.pow(rnd(), type === 'elliptical' ? 0.55 : 1.7) * size * 0.42;
        const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr * sq;
        const s = (1 - rr / (size * 0.45)) * 1.9 + 0.4;
        g.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${0.05 + rnd() * 0.16})`;
        g.beginPath(); g.arc(x, y, s, 0, Math.PI * 2); g.fill();
      }
      g.save();
      g.translate(cx, cy); g.scale(1, sq); g.translate(-cx, -cy);
      const core = g.createRadialGradient(cx, cy, 0, cx, cy, size * 0.3);
      core.addColorStop(0, 'rgba(255,250,235,0.95)');
      core.addColorStop(0.35, `rgba(${c[0]},${c[1]},${c[2]},0.5)`);
      core.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = core; g.fillRect(0, 0, size, size);
      g.restore();
    } else if (type === 'irregular') {
      fadeOuter = size * 0.50;
      for (let k = 0; k < 1400; k++) {
        const a = rnd() * Math.PI * 2;
        const rr = Math.pow(rnd(), 0.75) * size * 0.4;
        const jitter = 1 + (fbm3(Math.cos(a) * 2, Math.sin(a) * 2, 0.5, 3, seed) - 0.5) * 1.1;
        const x = cx + Math.cos(a) * rr * jitter, y = cy + Math.sin(a) * rr * jitter * sq;
        g.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${0.05 + rnd() * 0.2})`;
        g.beginPath(); g.arc(x, y, 0.6 + rnd() * 2.1, 0, Math.PI * 2); g.fill();
      }
    } else {
      /* ---------------- 旋涡星系：对数螺旋臂（沿臂多重描边）+ 亮结 + 核球 ---------------- */
      const arms = 2 + Math.floor(rnd() * 2);
      const maxR = size * 0.46;
      fadeOuter = maxR;
      // 倾角按哈勃型抽：Sa ≈ 6~12°、Sb ≈ 12~18°、Sc ≈ 18~28° ——
      // 旋臂倾角是唯一定量描述「臂展得开不开」的形态学参数，别的星系也该用它。
      // ⚠️ 原来这里是 `Math.log(1 + r*0.055) * 2.6`：既不是对数螺旋，
      //    0.055 / 2.6 两个数也没有物理含义，纯粹是看着顺眼调出来的。已收回统一公式。
      const pitchDeg = 6 + rnd() * 22;
      const r0 = maxR * 0.07;                 // 锚定半径：核球外缘
      const wArm = maxR * 0.05;               // 臂宽（像素口径，与银河系那张同法）
      const b = Math.tan(pitchDeg * Math.PI / 180);
      /** 按**面积**均匀取半径 —— 不要按参数 t 均匀（坑 101：那样点全堆在内侧）。 */
      const rForArea = () => Math.sqrt(r0 * r0 + rnd() * (maxR * maxR - r0 * r0));

      // ① 弥散盘底（指数盘）。盘要有底，否则「臂浮在黑底上」像画上去的线。
      //    亮度刻意压在旋臂之下（约 1:3.5），色相偏暖旧 —— 对比靠色相差，不靠亮度。
      for (let k = 0; k < 2600; k++) {
        const t = Math.pow(rnd(), 2.2);
        const r = r0 + t * (maxR - r0);
        const a = rnd() * Math.PI * 2;
        g.fillStyle = `rgba(240,228,204,${(0.012 + rnd() * 0.026).toFixed(3)})`;
        g.beginPath();
        g.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r * sq, 0.5 + rnd() * 1.2, 0, Math.PI * 2);
        g.fill();
      }

      // ② 旋臂 —— 四道宽窄叠加的描边（宽而暗 → 窄而亮）= 廉价但有效的辉光。
      g.lineCap = 'round';
      g.lineJoin = 'round';
      const PASSES = [
        { k: 2.6, a: 0.050, col: '150,186,255' },
        { k: 1.5, a: 0.090, col: '176,204,255' },
        { k: 0.85, a: 0.150, col: '208,226,255' },
        { k: 0.40, a: 0.210, col: '238,244,255' },
      ];
      const NSEG = 180;
      for (let arm = 0; arm < arms; arm++) {
        const phase = (arm / arms) * Math.PI * 2;
        const pts = [];
        for (let i = 0; i <= NSEG; i++) {
          const u = i / NSEG;
          const r = Math.sqrt(r0 * r0 + u * (maxR * maxR - r0 * r0));   // 面积均匀
          const a = spiralTheta(r, { phase, r0, b });
          const tp = (r - r0) / (maxR - r0);
          // 两端渐隐 × 外缘渐暗 × 团块。
          // ⚠️ **末端渐隐不是美化，是必需**：不渐隐的臂会直接封口成环（坑 98）。
          const fade = Math.min(1, tp / 0.10) * Math.min(1, (1 - tp) / 0.28);
          const outer = 1 - 0.5 * Math.max(0, (r - maxR * 0.55) / (maxR * 0.45));
          const lump = 0.5 + 0.5 * Math.sin(tp * 41 + arm * 2.1 + seed);
          const clump = 0.35 + 0.65 * lump * lump * (0.6 + 0.4 * Math.sin(tp * 12.3 + 1.3));
          pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r * sq, w: fade * outer * clump });
        }
        for (const pass of PASSES) {
          g.lineWidth = wArm * pass.k;
          for (let i = 1; i <= NSEG; i++) {
            const A = pts[i - 1], B = pts[i];
            const al = pass.a * A.w;
            if (al < 0.004) continue;
            g.strokeStyle = `rgba(${pass.col},${al.toFixed(3)})`;
            g.beginPath(); g.moveTo(A.x, A.y); g.lineTo(B.x, B.y); g.stroke();
          }
        }
      }

      // ③ 亮结 —— HII 区（粉）与年轻星团（暖白）。星系照片里最先抓住眼睛的就是这些点；
      //    只有连续的臂、没有结，看着就是一条画上去的曲线。
      for (let arm = 0; arm < arms; arm++) {
        const phase = (arm / arms) * Math.PI * 2;
        for (let k = 0; k < 46; k++) {
          const r = rForArea();
          const a = spiralTheta(r, { phase, r0, b }) + (rnd() - 0.5) * 1.6 * wArm / Math.max(r, wArm);
          const rr = r + (rnd() - 0.5) * 2 * wArm * 0.8;
          g.fillStyle = rnd() < 0.42
            ? `rgba(255,138,188,${(0.26 + rnd() * 0.38).toFixed(3)})`
            : `rgba(255,238,206,${(0.20 + rnd() * 0.34).toFixed(3)})`;
          g.beginPath();
          g.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * sq, 0.9 + rnd() * 1.9, 0, Math.PI * 2);
          g.fill();
        }
      }

      // ④ 核球 —— 中心暖黄，沿 sq 压一下（多数旋涡的核球有轴比，正圆是少数）。
      const core = g.createRadialGradient(cx, cy, 0, cx, cy, size * 0.20);
      core.addColorStop(0, 'rgba(255,248,225,0.95)');
      core.addColorStop(0.30, `rgba(${c[0]},${c[1]},${c[2]},0.66)`);
      core.addColorStop(1, 'rgba(0,0,0,0)');
      g.save();
      g.translate(cx, cy); g.scale(1, sq); g.translate(-cx, -cy);
      g.fillStyle = core;
      g.beginPath(); g.arc(cx, cy, size * 0.20, 0, Math.PI * 2); g.fill();
      g.restore();
    }

    /* 最外缘渐隐 —— 走**共用的那一份**（`fadeDiscEdge`），不要在这里再写一遍：
     * 这两处各写过一份，而其中一份就漏了（正是「边缘没有淡出效果」）。 */
    fadeDiscEdge(g, cx, cy, fadeOuter * 0.68, fadeOuter, size);

    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  });
}

/** 银河系**俯视**盘面纹理（专用于 galaxy 层那块平躺的盘，本星系群里的银河系也用这一张）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ★★ 2026-09-12 第 33 轮：**整张重画**。用户原话：「你这个银河系的样子实在难看，
 *    参照真实样子做」。重画的口径来自**真实参照图**（ESO 1131a = NGC 6744，
 *    公认的「银河系孪生」SB(rs)bc，公开可用的最接近的真实影像），而不是调参试出来的。
 *
 * **参照图教了四件事，旧画法四件全错：**
 *   ① **尘埃带是画面里最抢眼的东西**，不是点缀。NGC 6744 上暗褐色尘埃纤维横贯盘面、
 *      把旋臂切成一节一节。旧画法把尘埃画成**一串硬边黑圆点**（`arc` + 纯黑填充），
 *      在 additive 口径下那些点就是一个个破洞 —— 放大看是「黑波点」。
 *      ⇒ 现在改成 `destination-out` + **柔和的径向渐变斑**，顺着臂的切向拉长成**细带**。
 *   ② **盘是连续的一层雾**，不是一碗沙。旧画法的底盘是 9 万个点，远看就是均匀颗粒
 *      （这正是「难看」的主因之一：**结构被颗粒淹了**）。
 *      ⇒ 现在底盘是**指数盘的平滑径向渐变**（h = 2.6 kpc），颗粒只留一点点做质感。
 *   ③ **旋臂是宽而软的带**，不是画上去的细线。旧画法 4 道描边、总 α≈0.5 全压在中心线附近，
 *      远看就是「几条曲线」。⇒ 现在 7 道描边、宽度按几何级数铺开（4.2× → 0.4×），
 *      横截面近似高斯 ⇒ 臂有**宽度和软边**。
 *   ④ **核球/棒是一团柔和的暖黄光**，不是一颗白球。旧画法核区三层叠加（点云 + 精灵 +
 *      贴图里 α=0.78 的暖核）⇒ 过曝成一个大白斑（用户上一轮的「中心的球太大了吧」）。
 *      ⇒ 现在贴图里的核只留**小而暗**的一层，峰值 α 从 0.78 降到 0.30。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ★★ 同一天的第二遍（`after1` 目检之后）：**上面四条对了，但臂宽算错了。**
 *    探针导出贴图一看就现形：旋臂成了**约 100 px 宽的白板**，四条臂在盘内糊成
 *    一圈圈**同心环**，而不是螺旋。原因是这一行：
 *        `wPx = P(arm.wArm · KPC2KLY · 1.6)`  →  24 px（Scutum，ψ=12.1° 是最宽的一条）
 *        `lineWidth = wPx · pass.k`            →  k 最大 4.2  ⇒  **102 px**
 *    而**相邻两圈之间的径向间距**是 `2π·r·tanψ`（对数螺旋的几何，不是审美）：
 *        Perseus(ψ=8.7°) 在 r=12 kly 处只有 115 px、Scutum(ψ=12.1°) 在 r=12 kly 处 160 px。
 *    ⇒ **臂的包络一旦接近圈间距，相邻圈就贴到一起，「螺旋」必然读成「同心环」。**
 *    这是本层第三次栽在「跨度/宽度」上（前两次见坑 98 与「400° 上限」），
 *    但**病因是新的**：前两次是弧的半径跨度，这次是**横截面宽度**。
 *
 *    **定下的判据（可算，不靠眼睛）**：臂的**最大包络半径**必须 ≤
 *    `0.25 × 2π·r·tanψ`，在 `r = MW_ARM_R_START`（臂的起端，最挤的地方）处检验。
 *    算出来 Perseus 在 r=10 kly 处 1/4 间距 = 24 px ⇒ 最宽的一道描边取 **24 px**，
 *    即 `pass.k` 的上限是 **1.0**（而不是 4.2）。
 *
 *    另外两处一起压：**总 α 从 0.367 降到约 0.20**、HII 亮结的数量与亮度各减三成。
 *    旧的盘心 α=0.34 叠上这一大堆之后，在 additive 口径下整幅推到过曝
 *    （探针读数：亮像素占比 18.8% → 30.1%）—— 真实星系照片里**盘面是暗的，
 *    只有核和尘埃带反差大**，参照图 NGC 6744 上一眼看得到的是**暗褐色的尘埃纤维**，
 *    而不是一片白光。
 *
 * ⚠️ 坐标系（推算过一次，别再猜）：这块贴图贴在 CircleGeometry 上再 `rotation.x = -π/2`，
 *   换算下来 **canvas 的 +x → 世界 +x，canvas 的 +y（向下）→ 世界 +z**，
 *   与 `levels/galaxy.js` 撒点用的 `x = cos(a)·r, z = sin(a)·r` **同一口径、且不镜像**。
 *   所以只要两边都调 `armPoint()`，画出来的臂就能**严丝合缝压在粒子臂上**。
 *
 * 绘制顺序（不能换）：① 平滑指数盘 → ② 旋臂 → ③ 棒 → ④ 尘埃（挖） → ⑤ HII 区 → ⑥ 核球/核
 *   —— 尘埃放在 HII 之前，是因为真实盘面上 HII 区就长在尘埃带的**前缘**，
 *      先挖后点，结才不会一起被挖掉。
 */
export function makeMilkyWayDiskTexture({ size = 1024, seed = 20260911, rMax = MW_R, armBoost = 1, coreDamp = 1 } = {}) {
  /* ⚠️ 缓存键前缀 `mwd4`：画法换过两次（第 37 轮 `STOPS` 14 → 256；2026-10-11
   *    外缘渐隐 0.66R → 0.80R + 新增 armBoost/coreDamp），换前缀保证同一次页面
   *    加载里不会拿到按旧画法生成的那张。
   *    **键里必须逐个列出所有会改变输出的参数**（坑 134）：armBoost / coreDamp
   *    都改变输出像素，所以都在键里。
   *    ⚠️ 注意 `STOPS` **不在**键里 —— 它是**画法的一部分**不是参数，所以画法一改
   *       必须换前缀；只改 STOPS 不换前缀的话，同一次加载里会静默复用旧贴图。 */
  return cached(`mwd4|${size}|${seed}|${rMax}|${armBoost}|${coreDamp}`, () => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const g = cv.getContext('2d');
    const cx = size / 2, cy = size / 2, R = size * 0.48;
    const rnd = mulberry(seed);
    const px = R / rMax;                       // 贴图像素 ÷ 千光年 —— 所有半径走这一个换算
    const P = (kly) => kly * px;               // kly → 像素
    const S = (size / 1024) ** 2;              // 采样数按**面积**缩放（小尺寸别再撒同样的点数）
    /** 银盘指数标长 kly。**实测口径**：Bland-Hawthorn & Gerhard 2016 汇总给 2.5~2.6 kpc
     *  （1 kpc = 3.2616 kly ⇒ 8.2~8.5 kly）。取 8.5。 */
    const H_KLY = 8.5;
    /** 旋臂贴图亮度自己的标长 kly（> `H_KLY`，理由见下面「臂的亮度必须跟着盘面衰减」那段）。 */
    const ARM_H_KLY = 13;

    /* ① 平滑指数盘底 —— I(r) ∝ exp(−r/h)。
     *    ⚠️ 这一层是**渐变**不是撒点：真实星系照片里盘是一层连续薄雾，
     *       颗粒只在放大时才出现；撒点做底盘（旧画法）远看就是一碗沙，
     *       **结构会被颗粒淹掉** —— 那是「难看」的头号来源。
     *    颜色内暖外冷（老星在内、金属丰度梯度在外），对比靠色相差。 */
    g.globalCompositeOperation = 'lighter';
    const discGrad = g.createRadialGradient(cx, cy, 0, cx, cy, R);
    /* ⚠️★ `STOPS` **必须够密**（2026-09-12 第 37 轮：14 → **256**）。
     *
     * `createRadialGradient` 的相邻 stop 之间是**线性插值**，而这里要逼近的是
     * `exp(−6.2u)`（指数盘，`rMax/H_KLY = 52.8/8.5 = 6.2`）—— 一条在 u→0
     * 处曲率最大的凸曲线。分段线性插值的误差 ≈ `f″·h²/8`：
     *   u=0 处 `f″ = 6.2² = 38.4`、`h = 1/14` ⇒ 误差 ≈ **0.0245**，
     *   而该处的 α 只有 **0.20** ⇒ **相对误差 12%**。
     * 后果不是「差一点」，是**一圈一圈的水波纹**：
     *   实测（`tools/analyze-mw-texture.py` 量导出的贴图原图）——
     *   径向剖面的波纹 `relRms = 29.8%`、符号翻转 **23 次**（正好是分段的折角），
     *   而盘内平均 α 只有 0.0154 ⇒ **波纹峰值 0.127 是平均亮度的 8 倍**。
     *   在 additive + 泛光口径下，这十几条同心亮环就是画面里最显眼的「廉价感」。
     *
     * 256 段：误差 ∝ h² ⇒ 降到 `0.0245 × (14/256)² = 7.3e-5`（相对 0.04%），
     * 肉眼不可见。生成成本**一次性**（`cached()` 只跑一次），可以忽略。
     *
     * ⚠️ 顺带把 α 的 `toFixed(4)` 改成 `toFixed(6)`：`toFixed(4)` 把 α 量化到
     *    1e-4（= 0.0255/255）。外盘本来就低到 1–2/255，再被十进制量化一次
     *    等于**又削掉一层结构**。 */
    const STOPS = 256;
    for (let i = 0; i <= STOPS; i++) {
      const u = i / STOPS;                              // u = r / rMax
      const I = Math.exp(-u * rMax / H_KLY);            // r=rMax 时 ≈ e^-6.2 = 0.002
      const warm = Math.max(0, 1 - u / 0.55);           // 内侧偏暖
      const r = Math.round(178 + 66 * warm + 44 * (1 - warm));
      const gg = Math.round(184 + 44 * warm + 30 * (1 - warm));
      const b = Math.round(190 + 16 * warm + 36 * (1 - warm));
      // ⚠️ 峰值 α 0.34 → **0.20**：这张贴图在盘面网格上以 `AdditiveBlending` + opacity 0.9
      //    使用 ⇒ **α 就是亮度**，0.34 叠上旋臂与亮结直接把整幅推过曝（第二遍的教训）。
      // ⚠️★ 0.20 → **0.204**（2026-09-12 第 37 轮，与 `STOPS` 14→256 **必须同时改**）：
      //    分段线性插值逼近凸曲线时是**在曲线上方**的 ⇒ 旧的 14 段版本整体**虚高**。
      //    把它修平滑之后盘面会变淡，所以要把峰值补回去 —— **补多少以总能量为准**：
      //      实测 `Σα`：14 段 11653 → 256 段(α 0.20) 11430 ⇒ 只差 **1.9%**（不是 12%，
      //      因为插值高估集中在外盘，那里对总能量的贡献本来就小）。
      //      ⇒ 0.20 × (11653/11430) = **0.204**，实测 Σα 回到 11650 ✓
      //    ⚠️ 我第一次按「曲线上方 12%」补到 0.225，实测 Σα 12398（**+6.4%，越了 ±5% 线**）。
      //       教训：补亮度要**读测量值**，不要从解析误差公式外推 —— 公式给的是
      //       **逐点**的相对误差，而预算管的是**积分**，两者不是一回事。
      discGrad.addColorStop(u, `rgba(${r},${gg},${b},${(0.204 * I).toFixed(6)})`);
    }
    g.fillStyle = discGrad;
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();

    /* ①b 颗粒：只为「放大时不是塑料片」，量刻意压到看不见结构。
     * ⚠️ 颗粒必须**跟着盘面强度一起衰减**（乘 `I`）。第一遍没乘，结果盘面渐变已经在
     *    0.66R 之外淡到几乎没有，颗粒却还保持恒定 α ⇒ 盘外缘浮出**一圈点状亮环**
     *    （导出贴图上是一条清清楚楚的「虚线圆」）。这是「两层各自衰减」的典型漏。
     * ⚠️ 半径也不许撒到盘边：颗粒属于盘，不属于天空。 */
    for (let k = 0; k < Math.round(4200 * S); k++) {
      const u = Math.pow(rnd(), 2.3);                   // 指数盘：越往外越稀
      const r = 0.04 * R + u * R * 0.92;
      const a = rnd() * Math.PI * 2;
      const I = Math.exp(-(r / R) * rMax / H_KLY);
      g.fillStyle = `rgba(236,224,200,${(0.014 * I).toFixed(4)})`;
      g.beginPath();
      g.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, P(0.10 + rnd() * 0.30), 0, Math.PI * 2);
      g.fill();
    }

    /* ② 旋臂 —— 7 道描边，宽度按几何级数铺开（宽而暗 → 窄而亮）。
     *    横截面近似高斯 ⇒ 臂**有宽度、有软边**。臂宽取物理宽度再换算成像素
     *    （`wArm` 是 Reid 2019 的 maser 臂宽，0.30~0.50 kpc —— 那是**脉泽**测的，
     *     恒星/发射线看到的臂更宽，所以这里 ×1.6 再当发光带宽度用）。
     *    ⚠️ 团块因子（`armPoint().w`）直接当 α 用 ⇒ 臂自然断成「一串结 + 空隙」，
     *       两端也自然渐隐（不渐隐的臂会封口成环，坑 98）。 */
    g.lineCap = 'round';
    g.lineJoin = 'round';
    /* ⚠️ `k` 的上限是 **1.0**，不是 4.2 —— 理由见文件头「同一天的第二遍」那段：
     *    最宽的一道描边 = `wPx` 本身，才不会让相邻圈贴成同心环。
     *    总 α 约 **0.124**（第二遍是 0.21、第一遍是 0.367）。
     *    ⚠️ 为什么再降：`after2` 的俯视图上，臂读成了**发光的霓虹管** —— 一根白芯 + 一圈
     *    青边。病灶是**叠加口径**：盘面贴图是 additive 的，臂的 α 是**加在盘面之上的增量**，
     *    而真实盘面的**臂/臂间对比只有约 2 倍**（参照图 NGC 6744 上臂是「比盘稍亮 + 内侧
     *    压着一条暗带」，不是一条发光的线）。外推：在 r≈15 kly 处盘面 α≈0.034，
     *    臂再加 0.147 ⇒ 对比 4.3 倍，明显过冲。
     *    ⚠️ 颜色跨度也收窄了（旧值 132,170,240 → 250,244,230 跨了 118 个码值，
     *    这就是那圈「青边」的来源）。现在整族都落在蓝白到暖白之间。 */
    const PASSES = [
      { k: 1.00, a: 0.010, col: '150,178,232' },
      { k: 0.78, a: 0.013, col: '172,196,240' },
      { k: 0.60, a: 0.017, col: '194,212,244' },
      { k: 0.45, a: 0.021, col: '212,224,246' },
      { k: 0.33, a: 0.024, col: '228,234,248' },
      { k: 0.24, a: 0.022, col: '238,240,248' },
      { k: 0.16, a: 0.017, col: '244,242,238' },
    ];
    const NSEG = 420;
    /* ⚠️★ 臂的亮度必须**跟着盘面一起指数衰减**（`ARM_H_KLY`）。这条是 after3 目检
     *    逼出来的，也是这一轮最本质的一处修正：
     *      盘面的平滑分量到 r = 0.5R 已经降到 5%（e^(−26/8.5) ≈ 0.047），而臂的 α
     *      还是满值 —— 于是**盘已经没了，臂还亮着**。两个可见的后果：
     *        ① 盘外留下几段「**悬空的白色短杠**」（盘边那道亮弧的真正来源）；
     *        ② 盘面中段被四条臂的宽描边糊成一片**均匀的灰**，指数剖面完全读不出来。
     *    物理上臂是盘上的**密度波**，振幅本来就正比于它所在处的盘面亮度，所以按指数收。
     *    `ARM_H_KLY = 13`（> 盘的 h = 8.5）是**构造值**，落在「外盘光学标长大于内盘」
     *    这个已实测现象的浅盘一侧 —— 取 8.5 会把外半盘整个抹掉（实测：外盘光学标长
     *    在 2.5 个标长处有明显折，折后更浅）。
     *    ⚠️ 这一条**取代**了上一版那条线性 taper：两个机制叠在一起会互相掩蔽，
     *       以后谁改了其中一个，另一个的表现就变得不可解释。 */
    for (const arm of MW_ARMS) {
      const pts = [];
      for (let i = 0; i <= NSEG; i++) {
        const p = armPoint(arm, i / NSEG);
        const taper = Math.exp(-Math.max(0, p.r - MW_ARM_R_START) / ARM_H_KLY);
        pts.push({
          x: cx + Math.cos(p.a) * P(p.r), y: cy + Math.sin(p.a) * P(p.r),
          w: p.w * taper,
        });
      }
      const wPx = P(arm.wArm * KPC2KLY * 1.6);
      for (const pass of PASSES) {
        g.lineWidth = Math.max(0.8, wPx * pass.k);
        for (let i = 1; i <= NSEG; i++) {
          const A = pts[i - 1], B = pts[i];
          const al = pass.a * armBoost * A.w;
          if (al < 0.003) continue;
          g.strokeStyle = `rgba(${pass.col},${al.toFixed(3)})`;
          g.beginPath(); g.moveTo(A.x, A.y); g.lineTo(B.x, B.y); g.stroke();
        }
      }
    }

    /* ③ 棒 —— 中心拉长的柔和暖光。半长取 `MW_BAR_HALF`（实测口径，见常量处注释），
     *    轴比 0.36（花生状）。**用渐变不用描边**：棒是弥散结构，硬边会读成"贴了根棍子"。 */
    g.save();
    g.translate(cx, cy);
    g.rotate(MW_BAR_AZ);                                 // canvas 角度 ≡ 世界方位角
    g.scale(1, 0.36);
    const barR = P(MW_BAR_HALF * 0.92);
    const barGrad = g.createRadialGradient(0, 0, 0, 0, 0, barR);
    barGrad.addColorStop(0, 'rgba(255,238,198,0.32)');
    barGrad.addColorStop(0.35, 'rgba(255,222,170,0.16)');
    barGrad.addColorStop(0.72, 'rgba(255,206,152,0.06)');
    barGrad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = barGrad;
    g.beginPath(); g.arc(0, 0, barR, 0, Math.PI * 2); g.fill();
    g.restore();

    /* ④ 尘埃带 —— `destination-out` **挖**出暗带。这是整张图里最像真实星系的一步。
     *    ⚠️ 旧画法（纯黑 `arc` + `source-over`）在 additive 口径下就是一串**硬边黑洞**，
     *       放大能看见「黑波点」。改成「柔和的径向渐变 + 沿臂切向压扁」之后，
     *       出来的才是**纤维状的暗带**（参照图 NGC 6744 里最抢眼的就是它们）。
     *    位置：沿臂**往银心方向**挪一点（t 减小那侧）—— 真实盘里尘埃正好聚在臂的内侧前缘。 */
    g.globalCompositeOperation = 'destination-out';
    for (const arm of MW_ARMS) {
      const wKly = arm.wArm * KPC2KLY;
      const N = Math.round(1700 * S * arm.w);
      for (let k = 0; k < N; k++) {
        const t = armTForArea(arm, rnd());
        const p0 = armPoint(arm, t);
        if (p0.w < 0.30) continue;                        // 渐隐段不长尘埃
        const tIn = Math.max(0, t - 0.022);
        const p1 = armPoint(arm, tIn);
        const p2 = armPoint(arm, Math.max(0, tIn + 0.012));   // 用来求切向
        const a = p1.a + (rnd() - 0.5) * 0.85 * wKly / p1.r;
        const rr = p1.r + (rnd() - 0.5) * 1.1 * wKly;
        const rad = P(0.30 + rnd() * 0.85);
        const al = 0.09 + rnd() * 0.22;
        const dx = Math.cos(p2.a) * p2.r - Math.cos(p1.a) * p1.r;
        const dz = Math.sin(p2.a) * p2.r - Math.sin(p1.a) * p1.r;
        const ang = Math.atan2(dz, dx);
        g.save();
        g.translate(cx + Math.cos(a) * P(rr), cy + Math.sin(a) * P(rr));
        g.rotate(ang);
        g.scale(1, 0.40);                                 // 顺着臂拉成细带，不是圆点
        const grd = g.createRadialGradient(0, 0, 0, 0, 0, rad);
        grd.addColorStop(0, `rgba(0,0,0,${al.toFixed(3)})`);
        grd.addColorStop(0.55, `rgba(0,0,0,${(al * 0.45).toFixed(3)})`);
        grd.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grd;
        g.beginPath(); g.arc(0, 0, rad, 0, Math.PI * 2); g.fill();
        g.restore();
      }
    }
    /* ④b 棒上的尘埃带 —— 棒旋星系最标志性的一条：尘埃沿棒的**前缘**贯穿。
     *    参照图（NGC 6744）上那条横穿棒的暗带就是它。少了这条，棒会读成"一根亮棍子"。 */
    g.save();
    g.translate(cx, cy);
    g.rotate(MW_BAR_AZ);
    for (const side of [-1, 1]) {
      g.save();
      g.translate(0, side * P(MW_BAR_HALF * 0.30));
      g.scale(1, 0.16);
      const bg = g.createRadialGradient(0, 0, 0, 0, 0, P(MW_BAR_HALF * 0.86));
      bg.addColorStop(0, 'rgba(0,0,0,0.22)');
      bg.addColorStop(0.6, 'rgba(0,0,0,0.12)');
      bg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = bg;
      g.beginPath(); g.arc(0, 0, P(MW_BAR_HALF * 0.86), 0, Math.PI * 2); g.fill();
      g.restore();
    }
    g.restore();

    /* ⑤ 亮结 —— HII 区（Hα 粉）与年轻星团（蓝白）。**照片里最先抓住眼睛的就是这些点**；
     *    只有连续的臂、没有结，看起来就是一条画上去的曲线。
     *    ⚠️ 用 `armTForArea` 而不是 `rnd()`：亮结也必须**铺满整条臂**（坑 100）。 */
    g.globalCompositeOperation = 'lighter';
    for (const arm of MW_ARMS) {
      const wKly = arm.wArm * KPC2KLY;
      const N = Math.round(300 * S);
      for (let k = 0; k < N; k++) {
        const t = armTForArea(arm, rnd());
        const p0 = armPoint(arm, t);
        if (p0.w < 0.35) continue;
        const a = p0.a + (rnd() - 0.5) * 1.4 * wKly / p0.r;
        const rr = p0.r + (rnd() - 0.5) * 1.8 * wKly;
        const rad = P(0.16 + rnd() * 0.34);
        const pink = rnd() < 0.45;
        // 数量与亮度都减三成（第一遍 420 个 / α 上限 0.46 把盘面推成了白雾）
        // ⚠️ 再乘同一根臂的指数收口：亮结长在臂上，臂暗到哪里，结就暗到哪里。
        //    不乘的话外半盘会浮出一片**孤立的粉点**（周围盘面已经黑了，点还亮着）。
        const al = ((pink ? 0.14 : 0.10) + rnd() * 0.18)
          * Math.exp(-Math.max(0, p0.r - MW_ARM_R_START) / ARM_H_KLY) * armBoost;
        const col = pink ? '255,132,186' : '226,238,255';
        const grd = g.createRadialGradient(0, 0, 0, 0, 0, rad);
        const X = cx + Math.cos(a) * P(rr), Y = cy + Math.sin(a) * P(rr);
        g.save();
        g.translate(X, Y);
        grd.addColorStop(0, `rgba(${col},${al.toFixed(3)})`);
        grd.addColorStop(0.5, `rgba(${col},${(al * 0.35).toFixed(3)})`);
        grd.addColorStop(1, `rgba(${col},0)`);
        g.fillStyle = grd;
        g.beginPath(); g.arc(0, 0, rad, 0, Math.PI * 2); g.fill();
        g.restore();
      }
    }

    /* ⑥ 核球 + 核 —— 小而暗。**峰值 α 从 0.78 降到 0.30**：旧的暖核叠上核球点云与
     *    中心精灵之后过曝成一个大白斑（用户原话「中心的球太大了吧」）。
     *    核球半径仍按物理量给（长半轴 = 棒半长），只是不再那么亮。
     *    ⚠️ `coreDamp`（默认 1）：本星系群那张「同一个银河系」的变体用它把核再压一档
     *    —— 贴远看时核相对邻居（M31 的通用星系贴图）过早饱和，见 cosmos.js。 */
    const dA = (v) => Math.min(1, v * coreDamp);
    g.save();
    g.translate(cx, cy);
    g.rotate(MW_BAR_AZ);
    g.scale(1, 0.62);                                    // 核球是扁的，不是正圆
    const core = g.createRadialGradient(0, 0, 0, 0, 0, P(MW_BAR_HALF * 0.62));
    core.addColorStop(0, `rgba(255,242,208,${dA(0.17).toFixed(3)})`);
    core.addColorStop(0.32, `rgba(255,226,178,${dA(0.09).toFixed(3)})`);
    core.addColorStop(0.70, `rgba(255,208,150,${dA(0.03).toFixed(3)})`);
    core.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = core;
    g.beginPath(); g.arc(0, 0, P(MW_BAR_HALF * 0.62), 0, Math.PI * 2); g.fill();
    g.restore();
    const nuc = g.createRadialGradient(cx, cy, 0, cx, cy, P(1.6));
    nuc.addColorStop(0, `rgba(255,250,232,${dA(0.24).toFixed(3)})`);
    nuc.addColorStop(0.45, `rgba(255,240,205,${dA(0.10).toFixed(3)})`);
    nuc.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = nuc;
    g.beginPath(); g.arc(cx, cy, P(1.6), 0, Math.PI * 2); g.fill();

    /* 最外缘渐隐：否则圆盘几何会露出一圈硬边。走**共用的那一份**（`fadeDiscEdge`）。
     * ⚠️ 2026-10-11：起点 0.66R → **0.80R**。旧值下盘面辉光在 2/3 半径处就开始撤，
     *    而点云臂一直铺到 52.8 kly —— 默认视角下盘的外圈只剩一环稀点悬在黑底上，
     *    读成「盘到 2/3 处断了」。渐隐只动几何边缘，不动亮度标定（核心区没变）。 */
    fadeDiscEdge(g, cx, cy, R * 0.80, R, size);

    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  });
}


/* ---------------- 随机数 ---------------- */
export function mulberry(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 由色温或 B−V 色指数估算恒星颜色。
 *
 * ⚠️ **返回 `#rrggbb` 字符串**（历史上返回的是 `rgb(r,g,b)`）。
 *   改成 hex 的原因是消费方不统一，而其中一个只能吃 hex：
 *     · `THREE.Color.set()`            —— 两种都吃，没问题
 *     · `hexToRgb()`（本文件的贴图生成）—— **只吃 `#rrggbb`**，
 *       喂 `rgb(...)` 进去会被 `parseInt('rg', 16)` 静默解析成 NaN，
 *       最后画出 `rgb(NaN,NaN,NaN)` 的贴图（不报错，只是变成一团黑）。
 *   把「一种格式出口」定在这里，比在每个消费点各写一遍兼容代码更不容易腐烂。
 */
export function starColorFromBV(ci) {
  const bv = ci == null || !Number.isFinite(ci) ? 0.6 : Math.max(-0.4, Math.min(2.2, ci));
  const stops = [
    [-0.4, [155, 176, 255]], [0.0, [170, 191, 255]], [0.3, [202, 215, 255]],
    [0.58, [248, 247, 255]], [0.81, [255, 244, 234]], [1.4, [255, 210, 161]],
    [2.0, [255, 180, 130]], [2.4, [255, 150, 110]],
  ];
  const c = ramp(stops, bv).map(clamp255);
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}

export function clearTextureCache() { cache.clear(); }
export { rgbCss, hexToRgb, mix };
