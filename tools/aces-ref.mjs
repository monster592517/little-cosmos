// 参考值生成器：**逐字照抄** vendor 里的 ACES 常量与运算顺序，把「线性→码值」打到 JSON。
// 用途：给 `tools/check-aces-reimpl.py` 提供不可辩驳的对照 ——
//       证明 `probe-galaxy-visual.py` 里复刻的曲线没有走样。
//
// ⚠️ 参考值**每次现算**，不落盘复用旧的。跟一个陈旧的基线比 = 自己骗自己；
//    本项目已经栽过「用过期清单当判据」的跟头（坑 26），别再犯。
// 用法：node tools/aces-ref.mjs            → 写 tools/aces-ref.json
import fs from 'node:fs';

// GLSL 里 `mat3(c0, c1, c2)` 是**按列**给的；下面按行写，行和都 = 1（中性保持）。
const ACESInputMat = [
  [0.59719, 0.35458, 0.04823],
  [0.07600, 0.90834, 0.01566],
  [0.02840, 0.13383, 0.83777],
];
const ACESOutputMat = [
  [1.60475, -0.53108, -0.07367],
  [-0.10208, 1.10813, -0.00605],
  [-0.00327, -0.07276, 1.07602],
];
const mul = (M, v) => M.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
const rrt = (v) => {
  const a = v.map((x) => x * (x + 0.0245786) - 0.000090537);
  const b = v.map((x) => x * (0.983729 * x + 0.4329510) + 0.238081);
  return a.map((x, i) => x / b[i]);
};
const sat = (v) => v.map((x) => Math.min(1, Math.max(0, x)));

export function forward(lin, exposure) {
  let c = lin.map((x) => x * (exposure / 0.6));
  c = mul(ACESInputMat, c);
  c = rrt(c);
  c = mul(ACESOutputMat, c);
  c = sat(c);
  return c.map((x) => (x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055));
}

const cases = [];
for (const exposure of [1.05, 0.3675, 0.128625]) {
  for (const v of [0.01, 0.05, 0.18, 0.5, 0.85, 1.0, 1.75, 2.0, 4.0, 12.5]) {
    cases.push({ exposure, lin: [v, v, v], code: forward([v, v, v], exposure).map((x) => x * 255) });
  }
  // 暖色也要验：中性保持只在灰度上成立，而核区是暖的。
  const warm = [1.0, 0.86, 0.70];
  cases.push({ exposure, lin: warm, code: forward(warm, exposure).map((x) => x * 255) });
}
fs.writeFileSync(new URL('./aces-ref.json', import.meta.url), JSON.stringify(cases, null, 1));

console.log(`aces-ref.json 已重算：${cases.length} 个用例`);
for (const v of [1.0, 2.0, 4.0]) {
  console.log(`  线性 ${v} @曝光1.05 → ${forward([v, v, v], 1.05).map((x) => (x * 255).toFixed(2)).join(' / ')}`);
}
