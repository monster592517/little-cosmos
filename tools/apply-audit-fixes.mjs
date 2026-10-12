#!/usr/bin/env node
/**
 * 把「数据正确性审计」的结论落到数据文件里。
 *
 *  审计报告：`自检维修手册.md（原《审计报告-数据正确性.md》）`
 *  机器可读清单：`data/audit-findings.json`
 *
 *  为什么要写成脚本而不是手动改：
 *    每条修正都有出处（见审计报告），脚本把「改哪一处、从什么改成什么、为什么」
 *    固化成可复核、可重跑的形式。改完会逐条打印实际命中情况；
 *    任何一条没命中（find 文本对不上）都会报错退出，不会静默漏改。
 *    已经改过的条目（find 找不到但 replace 已在文件里）会被识别为「已应用」并跳过，
 *    所以新增修正可以直接追加到 FIXES 末尾，然后整表重跑。
 *
 *  用法：node tools/apply-audit-fixes.mjs [--dry]
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry');

const D = (f) => path.join(ROOT, 'web', 'js', 'data', f);

/**
 * 每条：file / find / replace / why / source
 * `find` 必须唯一命中一次，否则脚本报错——防止改错行。
 */
const FIXES = [
  /* ============ 一、必须修正 ============ */
  {
    file: D('solar-system.js'),
    find: "    moons: 95, texture: 'jupiter.jpg',",
    replace: "    moons: 115, texture: 'jupiter.jpg',   // 卫星数统计日期 2026-08（NASA/MPC 口径）",
    why: '木星卫星数 95 → 115（2026 年 MPC 分两批新增并确认）',
    source: 'NASA Planetary Satellite Discovery Circumstances',
  },
  {
    file: D('solar-system.js'),
    find: "    moons: 274, texture: 'saturn.jpg', ringTexture: 'saturn_ring.png',",
    replace: "    moons: 293, texture: 'saturn.jpg', ringTexture: 'saturn_ring.png',   // 卫星数统计日期 2026-08（NASA/MPC 口径）",
    why: '土星卫星数 274 → 293（2025-03 新增 128 颗后，2026 年又确认 11 颗）',
    source: 'NASA / NAOJ 2026-06 口径，MPEC 2026-F14',
  },
  {
    file: D('solar-system.js'),
    find: "    moons: 28, texture: 'uranus.jpg',",
    replace: "    moons: 29, texture: 'uranus.jpg',   // 含 2025-08 公布的 S/2025 U1",
    why: '天王星卫星数 28 → 29（S/2025 U1）',
    source: 'NASA Planetary Satellite Discovery Circumstances（2026-06）',
  },
  {
    file: D('probes.js'),
    find: `    status: '在轨运行', mode: 'orbit', host: 'venus', color: '#ffcf5c',
    orbitKm: { aKm: 390000, e: 0.85, iDeg: 3.0, periodDays: 10.5, phaseDeg: 40 },
    desc: '日本的金星气候轨道器，长期监测「超级自转」大气环流。',
    facts: ['首次入轨失败后于 2015 年成功。'],`,
    replace: `    status: '任务已结束（2025）', mode: 'ended', host: 'venus', color: '#ffcf5c',
    desc: '日本的金星气候轨道器，长期监测「超级自转」大气环流。2024 年 4 月与地面失联，JAXA 于 2025 年 9 月 18 日正式宣告任务结束。',
    facts: ['首次入轨失败后于 2015 年成功。', '在轨近十年，是研究金星大气环流最持久的观测平台。'],`,
    why: '拂晓号被标为「在轨运行」，实际已于 2025-09-18 被 JAXA 正式终止',
    source: 'JAXA/ISAS 拂晓号任务页终止公告',
  },
  {
    file: D('small-bodies.js'),
    find: "'2135 年有约 1/2700 的概率撞击地球。'",
    replace: "'2182 年 9 月 24 日有约 1/2700 的概率撞击地球（2300 年前累计约 1/1750）。'",
    why: '贝努撞击年份误写为 2135 年，正确为 2182-09-24',
    source: 'NASA JPL CNEOS Sentry；Farnocchia et al., Icarus',
  },
  {
    file: D('small-bodies.js'),
    find: "'将在约 4300 年后回归。'",
    replace: "'下次回归约在公元 4385 年（公转周期约 2400–2530 年，并非 4300 年）。'",
    why: '海尔-波普彗星回归周期被写成 4300 年，实际周期约 2400–2530 年',
    source: 'JPL Small-Body Database',
  },

  /* ============ 二、建议修正 ============ */
  {
    file: D('solar-system.js'),
    find: 'rotationHours: 10.656, axialTilt: 26.73,',
    replace: 'rotationHours: 10.5606, axialTilt: 26.73,',
    why: '土星自转周期用的是 Voyager 旧值 10h39m22s，Cassini 环震学给出 10h33m38s',
    source: 'Mankovich et al. 2019, ApJ 871, 1',
  },
  {
    file: D('solar-system.js'),
    find: "color: '#4a6fd4', radiusKm: 24622,",
    replace: "color: '#7aa5e0', radiusKm: 24622,   // 淡青蓝：Irwin et al. 2024 修正，不再用 Voyager 的深蓝",
    why: '海王星标记色仍是 Voyager 深蓝，与已修正的正文口径冲突，视觉上误导「海王星比天王星蓝得多」',
    source: 'Irwin et al. 2024, MNRAS（arXiv:2401.04667）',
  },
  {
    file: D('solar-system.js'),
    find: "{ name: '拂晓号', agency: 'JAXA', year: '2015–', note: '长期监测大气环流' },",
    replace: "{ name: '拂晓号', agency: 'JAXA', year: '2015–2025', note: '长期监测大气环流；2025 年任务终止' },",
    why: '金星条目里拂晓号的服役年份同样过时',
    source: 'JAXA/ISAS 拂晓号任务页',
  },
  {
    file: D('solar-system.js'),
    find: '厚度平均仅约 10 米，宽度却达 28 万公里。',
    replace: '厚度平均仅约 10 米，径向宽约 6.6 万公里（外径约 28 万公里）。',
    why: '土星环「宽度 28 万公里」是同条目 ring 字段（74,500–140,220 km）的口径冲突，应为外径',
    source: 'NASA Saturn Facts',
  },
  {
    file: D('probes.js'),
    find: "'原定 2021 年结束的任务已延长至 2025 年后。'",
    replace: "'原定 2021 年结束的任务已延长至 2028 年 9 月（坠入木星计划已取消）。'",
    why: '朱诺号任务延期信息过时',
    source: 'NASA Juno 官方任务页',
  },
  {
    file: D('probes.js'),
    find: `    status: '飞行中（2026 年底入轨）', mode: 'heliocentric', color: '#67e8f9',
    helio: { au: 0.46, lonDeg: 210, latDeg: 2.0, speedAuPerYear: -0.3 },
    waypoints: [{ body: 'earth', date: '2018-10-20' }, { body: 'venus', date: '2020-10-15' }, { body: 'mercury', date: '2026-12-05' }],
    desc: 'ESA 与 JAXA 联合的水星探测器，由两台轨道器组成，2026 年底进入水星轨道。',`,
    replace: `    status: '飞行中（2026-11-21 入轨）', mode: 'heliocentric', color: '#67e8f9',
    helio: { au: 0.46, lonDeg: 210, latDeg: 2.0, speedAuPerYear: -0.3 },
    waypoints: [{ body: 'earth', date: '2018-10-20' }, { body: 'venus', date: '2020-10-15' }, { body: 'mercury', date: '2026-11-21' }],
    desc: 'ESA 与 JAXA 联合的水星探测器，由两台轨道器组成，2026 年 11 月 21 日进入水星轨道，2026-09-03 完成探测器舱分离。',`,
    why: '贝皮科伦坡入轨日期由 2026-12-05 更正为 2026-11-21',
    source: 'ESA BepiColombo 官方任务页',
  },
  {
    file: D('probes.js'),
    find: "'携带「机智号」直升机完成了人类首次地外动力飞行。',",
    replace: "'携带「机智号」直升机完成了人类首次地外动力飞行；机智号共飞行 72 次，2024 年 1 月因旋翼受损结束任务。',",
    why: '机智号任务已结束，原文读起来像仍在飞',
    source: 'NASA JPL Ingenuity 任务页',
  },
  {
    file: D('small-bodies.js'),
    find: '已于 2020 年越过海王星轨道，正在离开太阳系。',
    replace: '早已越过海王星轨道，正在离开太阳系。',
    why: '2020 年越过的是天王星轨道距离（CFHT 口径），越过海王星轨道的年份来源口径不一，不宜写死',
    source: 'CFHT / ESA 图注',
  },
  {
    file: D('deep-sky.js'),
    find: "'韦布望远镜已对其行星大气展开系统观测。'",
    replace: "'韦布望远镜已系统观测其行星大气：2025 年 MIRI 数据显示 TRAPPIST-1 b 几乎不存在实质大气，b、c 的厚氢大气已被排除。'",
    why: 'TRAPPIST-1 大气结论需要更新（原先读起来像「很有希望」）',
    source: 'Gillon et al. 2025, Nature Astronomy（arXiv:2509.02128）',
  },

  /* ============ 三、第二期修正（2026-09-11） ============ */
  {
    file: D('probes.js'),
    find: 'const EPOCH = 2461261.5;   // 2026-09-09 的儒略日',
    replace: `export const EPOCH = 2461292.5;   // 2026-09-09 的儒略日
// 原值 2461261.5 换算回来其实是 2026-08-09，比注释声明的日期早整整一个月，
// 于是每个日心探测器都被多推进了约 0.25–0.3 AU。tools/verify-ephemeris.mjs 现在会自检这一条。`,
    why: '日心探测器的参考历元常量与声明日期不符：2461261.5 = 2026-08-09，不是 2026-09-09',
    source: '儒略日换算核对 + NASA 2026-09 实测（旅行者 1 号 171.68 AU、2 号 143.44 AU）',
  },
  {
    file: D('probes.js'),
    find: '目前距太阳约 172 AU，单程无线电信号需要约 24 小时。',
    replace: '距太阳约 172 AU（2026 年 9 月），单程无线电信号需要约 24 小时。',
    why: '把「目前」换成带日期的表述——面板已有实时距离，正文写死的数字不该假装永远成立',
    source: 'NASA 2026-09 实测 171.68 AU',
  },
  {
    file: D('probes.js'),
    find: "'目前距太阳约 144 AU。'",
    replace: "'距太阳约 144 AU（2026 年 9 月），此后逐年增大。'",
    why: '同上：给写死的距离标注参考时间，避免日后变成假话',
    source: 'NASA 2026-09 实测 143.44 AU',
  },
  {
    file: D('probes.js'),
    find: '目前仍在柯伊伯带中飞行，距太阳约 66 AU。',
    replace: '目前仍在柯伊伯带中飞行，距太阳约 66 AU（2026 年 9 月）。',
    why: '同上：给写死的距离标注参考时间',
    source: 'SwRI/NASA New Horizons 2026-06 新闻稿「roughly 66 AU」、任务图注 2026-07-06「65 AU」',
  },
];

async function main() {
  const byFile = new Map();
  for (const f of FIXES) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }

  let applied = 0;
  let skipped = 0;
  let failed = 0;

  for (const [file, fixes] of byFile) {
    let text = await readFile(file, 'utf8');
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    console.log(`\n── ${rel}`);
    for (const f of fixes) {
      const hits = text.split(f.find).length - 1;
      // 已经改过的条目：find 找不到、replace 已经在文件里 —— 跳过而不是报错。
      // 这样脚本才是真的「可重跑」：老条目安静通过，新条目照常应用。
      if (hits === 0 && text.includes(f.replace)) {
        skipped++;
        console.log(`  · 已应用，跳过 — ${f.why}`);
        continue;
      }
      if (hits !== 1) {
        console.log(`  ✗ 命中 ${hits} 次（应为 1）— ${f.why}`);
        console.log(`     查找片段：${JSON.stringify(f.find.slice(0, 70))}`);
        failed++;
        continue;
      }
      text = text.replace(f.find, f.replace);
      applied++;
      console.log(`  ✓ ${f.why}`);
      console.log(`     依据：${f.source}`);
    }
    if (!DRY) await writeFile(file, text, 'utf8');
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`${DRY ? '[试运行] ' : ''}本次应用 ${applied} 条 · 此前已应用 ${skipped} 条 · 失败 ${failed} 条`);
  console.log(`${'='.repeat(60)}`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
