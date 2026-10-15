/**
 * 探测器三维构型建模器（2026-10-11 新增）
 *
 *  ⚠️ 这是**参数化构型建模**，不是逐探测器 CAD：探测器之间的差别落在
 *  「构型骨架」这一层——碟形天线 / 太阳翼 / RTG 核电源 / 遮热罩 /
 *  磁强计杆 / 采样机构 / 大气探针 / 轮式底盘 / 着陆支腿——
 *  每台探测器按真实构型选一个预设（`PRESETS`），几何在预设参数下拼装。
 *  数据侧只写 `model: '<preset>'`，几何参数全部收在本文件（唯一真源）。
 *
 *  尺寸口径：所有部件在**单位坐标系**里搭（整机最大展幅 ≈ 3 单位），
 *  调用方给 `size`（世界单位，≈ 翼展）一次性缩放。
 *  太阳系层的取景距离（`#frameDistance` / viewFor）都按这个约定取景。
 *
 *  ⚠️ 全部顶层对象都有名字（本项目纪律：没名字的对象在探针清单里就是幽灵）。
 *  材质每次建模新建（`disposeObject` 会 dispose 材质，跨模型共享会串）。
 */
import * as THREE from 'three';

/* ---------------- 材质（每次建模新建实例） ---------------- */
function mats() {
  return {
    /** 金箔热控层（绝大多数深空探测器本体的包覆） */
    gold: new THREE.MeshStandardMaterial({ color: 0xc9a227, metalness: 0.8, roughness: 0.42 }),
    /** 铝银结构 */
    silver: new THREE.MeshStandardMaterial({ color: 0xc8ced6, metalness: 0.72, roughness: 0.45 }),
    /** 太阳翼电池片（深蓝近黑） */
    panel: new THREE.MeshStandardMaterial({ color: 0x17255c, metalness: 0.3, roughness: 0.55 }),
    /** 碟形天线反射面（白，双面） */
    dish: new THREE.MeshStandardMaterial({ color: 0xe6ebee, metalness: 0.1, roughness: 0.6, side: THREE.DoubleSide }),
    /** 碳黑（遮热罩 / 推进器） */
    carbon: new THREE.MeshStandardMaterial({ color: 0x2a2622, metalness: 0.25, roughness: 0.8 }),
    /** 深色设备盒（仪器） */
    dark: new THREE.MeshStandardMaterial({ color: 0x3a3f46, metalness: 0.35, roughness: 0.6 }),
    /** 轮子（火星车） */
    wheel: new THREE.MeshStandardMaterial({ color: 0x6a6f76, metalness: 0.4, roughness: 0.7 }),
  };
}

/* ---------------- 基础件 ---------------- */
const box = (m, w, h, d, mat) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat || m.silver);
const cyl = (m, rt, rb, h, mat, seg = 20) => new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat || m.silver);
/** 浅碟天线：开口圆锥 + 中心馈源杆 */
function dishMesh(m, r) {
  const g = new THREE.Group();
  const cone = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.1, r * 0.3, 24, 1, true), m.dish);
  cone.name = 'dish-reflector';
  const feed = cyl(m, 0.015, 0.015, r * 0.42, m.silver, 8);
  feed.position.y = r * 0.12;
  feed.name = 'dish-feed';
  g.add(cone, feed);
  return g;
}
/** 细长杆（磁强计臂 / 桁架） */
function boomMesh(m, len, r = 0.012) {
  const b = cyl(m, r, r, len, m.silver, 8);
  return b;
}

/* ---------------- 基型 1：bus —— 干线构型（绝大多数轨道器/巡天器） ----------------
 *  参数：dish: 'big'|'small'|null · wings: 0|2|4|'round' · span 翼展系数 ·
 *        shield 遮热罩 · boom 磁强计杆 · rtg 核电源 · horn 采样机构 ·
 *        probe 大气探针 · thruster 离子/主发动机 · busShape 'box'|'decagon'
 */
function buildBus(m, o = {}) {
  const g = new THREE.Group();
  // 本体：金箔包裹
  let bus;
  if (o.busShape === 'decagon') {
    bus = cyl(m, 0.34, 0.34, 0.5, m.gold, 10);
  } else {
    bus = box(m, 0.85, 0.55, 0.6, m.gold);
  }
  bus.name = 'bus-body';
  g.add(bus);

  // 高增益碟：+Z 为「前方」（通信方向）
  if (o.dish) {
    const d = dishMesh(m, o.dish === 'big' ? 0.55 : 0.3);
    d.rotation.x = -Math.PI / 2;                 // 碟口朝 +Z
    d.position.z = o.dish === 'big' ? 0.55 : 0.45;
    d.name = 'dish-assembly';
    g.add(d);
  }
  // 太阳翼
  const span = (o.span ?? 1.2);
  if (o.wings === 2) {
    for (const sx of [-1, 1]) {
      const w = box(m, span, 0.42, 0.035, m.panel);
      w.position.x = sx * (0.55 + span / 2);
      w.name = `solar-wing-${sx > 0 ? 'p' : 'n'}`;
      g.add(w);
    }
  } else if (o.wings === 4) {
    for (const [sx, sz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const w = box(m, sx ? span * 0.62 : 0.6, 0.4, sx ? 0.035 : 0.035, m.panel);
      w.position.set(sx * (0.55 + span * 0.31), 0, sz * 0.75);
      if (sz) w.rotation.y = Math.PI / 2;
      w.name = `solar-wing-${sx ? (sx > 0 ? 'p' : 'n') : (sz > 0 ? 'p' : 'n')}`;
      g.add(w);
    }
  } else if (o.wings === 'round') {
    // 露西：两片巨型圆形「扇」
    for (const sx of [-1, 1]) {
      const w = new THREE.Mesh(new THREE.CircleGeometry(0.8, 28), m.panel);
      w.position.x = sx * (0.55 + 0.8);
      w.rotation.y = sx * Math.PI / 2;
      w.name = `solar-fan-${sx > 0 ? 'p' : 'n'}`;
      g.add(w);
    }
  }
  // 遮热罩（帕克 / 太阳轨道器 / 贝皮）：+Z 朝阳面
  if (o.shield) {
    const s = cyl(m, 0.72, 0.92, 0.16, m.carbon, 24);
    s.rotation.x = Math.PI / 2;
    s.position.z = 0.85;
    s.name = 'heat-shield';
    g.add(s);
  }
  // 磁强计杆：-Z 桁架 + 末端传感器盒
  if (o.boom) {
    const b = boomMesh(m, 1.3);
    b.rotation.x = Math.PI / 2;
    b.position.z = -0.95;
    b.name = 'mag-boom';
    const sen = box(m, 0.09, 0.09, 0.09, m.dark);
    sen.position.z = -1.6;
    sen.name = 'mag-sensor';
    g.add(b, sen);
  }
  // RTG 核电源：-Z 后方两枚（旅行者/先驱者/新视野）
  if (o.rtg) {
    for (const sx of [-1, 1]) {
      const r = cyl(m, 0.07, 0.07, 0.5, m.carbon, 10);
      r.rotation.x = Math.PI / 2;
      r.position.set(sx * 0.3, 0, -0.75);
      r.name = `rtg-${sx > 0 ? 'p' : 'n'}`;
      g.add(r);
    }
  }
  // 采样机构：+Z 前下的喇叭口（隼鸟系 / OSIRIS-REx）
  if (o.horn) {
    const h = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.1, 0.35, 16, 1, true), m.silver);
    h.rotation.x = Math.PI / 2;
    h.position.set(0, -0.25, 0.75);
    h.name = 'sampler-horn';
    g.add(h);
  }
  // 大气探针（卡西尼-惠更斯 / 伽利略）：侧挂圆柱
  if (o.probe) {
    const p = cyl(m, 0.17, 0.13, 0.34, m.silver, 16);
    p.rotation.z = Math.PI / 2;
    p.position.set(0.55, -0.1, 0);
    p.name = 'attached-probe';
    g.add(p);
  }
  // 离子/主发动机：-Z 尾部碳锥
  if (o.thruster) {
    const t = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.16, 0.22, 16, 1, true), m.carbon);
    t.rotation.x = -Math.PI / 2;
    t.position.z = -0.42;
    t.name = 'engine';
    g.add(t);
  }
  return g;
}

/* ---------------- 基型 2：juno —— 六棱柱本体 + 三片巨型太阳翼 ---------------- */
function buildJuno(m) {
  const g = new THREE.Group();
  const body = cyl(m, 0.36, 0.36, 0.5, m.silver, 6);   // 六棱柱
  body.name = 'juno-body';
  g.add(body);
  // 三片太阳翼，互成 120°；朱诺的翼特别大（展开 20 m，本机最大太阳翼之一）
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const w = new THREE.Group();
    const seg1 = box(m, 0.9, 0.42, 0.03, m.panel);
    seg1.position.x = 0.75;
    const seg2 = box(m, 0.7, 0.42, 0.03, m.panel);
    seg2.position.x = 1.55;
    w.add(seg1, seg2);
    w.rotation.y = a;
    w.name = `juno-wing-${i}`;
    g.add(w);
  }
  // 微波辐射计天线组 + 高增益碟
  const d = dishMesh(m, 0.34);
  d.rotation.x = -Math.PI / 2;
  d.position.z = 0.42;
  d.name = 'dish-assembly';
  g.add(d);
  return g;
}

/* ---------------- 基型 3：rover —— 轮式巡视器（火星车 / 月球车） ----------------
 *  六轮摇臂转向架的通用形态：本体盒 + 6 轮 + 桅杆相机头 + 尾部 RTG/电池舱 + 机械臂。
 */
function buildRover(m, o = {}) {
  const g = new THREE.Group();
  const body = box(m, 0.7, 0.3, 0.5, m.gold);
  body.position.y = 0.42;
  body.name = 'rover-body';
  g.add(body);
  const wheels = o.wheels ?? 6;
  const rows = wheels === 8 ? [-0.62, -0.21, 0.21, 0.62] : [-0.44, 0, 0.44];
  const perRow = wheels === 8 ? 2 : 2;
  for (const rx of rows) {
    for (const sz of [-1, 1]) {
      const w = cyl(m, 0.16, 0.16, 0.1, m.wheel, 16);
      w.rotation.x = Math.PI / 2;
      w.position.set(rx, 0.16, sz * 0.32);
      w.name = 'rover-wheel';
      g.add(w);
    }
  }
  // 悬架
  for (const rx of rows) {
    const a = box(m, 0.05, 0.1, 0.6, m.dark);
    a.position.set(rx, 0.34, 0);
    a.name = 'rover-suspension';
    g.add(a);
  }
  // 桅杆 + 相机头（导航/全景相机）
  const mast = cyl(m, 0.02, 0.02, 0.42, m.silver, 8);
  mast.position.set(0.22, 0.78, 0);
  mast.name = 'rover-mast';
  const head = box(m, 0.16, 0.1, 0.08, m.dark);
  head.position.set(0.22, 1.0, 0);
  head.name = 'rover-camhead';
  g.add(mast, head);
  // 机械臂（前）
  const arm = box(m, 0.05, 0.05, 0.3, m.silver);
  arm.position.set(0.5, 0.38, 0);
  arm.rotation.y = -0.5;
  arm.name = 'rover-arm';
  g.add(arm);
  // 尾部动力舱（MMRTG 散热鳍）
  const rtg = cyl(m, 0.09, 0.09, 0.26, m.carbon, 10);
  rtg.rotation.z = Math.PI / 2;
  rtg.position.set(-0.48, 0.44, 0);
  rtg.name = 'rover-rtg';
  g.add(rtg);
  return g;
}

/* ---------------- 基型 4：lander —— 着陆器（腿座 / 球形弹道舱） ----------------
 *  legs: 3|4 · sphere: true 时退化为 Venera/Luna 9/Huygens 式弹道舱。
 *  面板上的仪器（地震仪 / 热流探针 / 采样臂）以「甲板小件」呈现——
 *  逐台仪器的名字与说明在数据 `instruments` 与详情面板里，几何不冒充仪器清单。
 */
function buildLander(m, o = {}) {
  const g = new THREE.Group();
  if (o.sphere) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.42, 24, 16), m.silver);
    s.name = 'lander-capsule';
    g.add(s);
    const ant = boomMesh(m, 0.3, 0.02);
    ant.position.y = 0.42;
    ant.name = 'lander-antenna';
    g.add(ant);
    return g;
  }
  const legs = o.legs ?? 4;
  const deck = cyl(m, 0.42, 0.42, 0.1, m.gold, 24);
  deck.position.y = 0.34;
  deck.name = 'lander-deck';
  g.add(deck);
  const body = box(m, 0.4, 0.3, 0.34, m.silver);
  body.position.y = 0.54;
  body.name = 'lander-body';
  g.add(body);
  for (let i = 0; i < legs; i++) {
    const a = (i / legs) * Math.PI * 2 + Math.PI / 4;
    const leg = cyl(m, 0.015, 0.015, 0.62, m.silver, 8);
    leg.position.set(Math.cos(a) * 0.42, 0.17, Math.sin(a) * 0.42);
    leg.rotation.z = -Math.cos(a) * 0.55;
    leg.rotation.x = Math.sin(a) * 0.55;
    leg.name = 'lander-leg';
    const pad = cyl(m, 0.09, 0.09, 0.03, m.dark, 12);
    pad.position.set(Math.cos(a) * 0.58, 0.02, Math.sin(a) * 0.58);
    pad.name = 'lander-footpad';
    g.add(leg, pad);
  }
  // 甲板仪器件：一台圆顶（地震仪形）+ 一个小盒（采样/气象）
  const seismo = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2), m.dark);
  seismo.position.set(0.2, 0.39, 0.1);
  seismo.name = 'instrument-dome';
  const inst = box(m, 0.16, 0.1, 0.14, m.dark);
  inst.position.set(-0.18, 0.44, -0.05);
  inst.name = 'instrument-box';
  g.add(seismo, inst);
  // 两侧折叠太阳翼
  for (const sx of [-1, 1]) {
    const w = box(m, 0.55, 0.02, 0.4, m.panel);
    w.position.set(sx * 0.48, 0.36, 0);
    w.rotation.z = sx * 0.15;
    w.name = `lander-wing-${sx > 0 ? 'p' : 'n'}`;
    g.add(w);
  }
  return g;
}

/* ---------------- 基型 5：apollo —— 阿波罗登月舱（下降级+上升级） ---------------- */
function buildApollo(m) {
  const g = new THREE.Group();
  // 下降级：八角平台 + 金箔包覆 + 着陆腿×4
  const descent = cyl(m, 0.42, 0.42, 0.26, m.gold, 8);
  descent.position.y = 0.5;
  descent.name = 'lm-descent';
  g.add(descent);
  // 上升级：多面体座舱（近似球）+ 对接口
  const ascent = new THREE.Mesh(new THREE.SphereGeometry(0.26, 20, 14), m.silver);
  ascent.position.y = 0.86;
  ascent.name = 'lm-ascent';
  g.add(ascent);
  const hatch = cyl(m, 0.06, 0.06, 0.12, m.dark, 12);
  hatch.rotation.x = Math.PI / 2;
  hatch.position.set(0, 0.82, 0.3);
  hatch.name = 'lm-hatch';
  g.add(hatch);
  // 4 条着陆腿 + 足垫
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const leg = cyl(m, 0.018, 0.018, 0.72, m.silver, 8);
    leg.position.set(Math.cos(a) * 0.44, 0.28, Math.sin(a) * 0.44);
    leg.rotation.z = -Math.cos(a) * 0.62;
    leg.rotation.x = Math.sin(a) * 0.62;
    leg.name = 'lm-leg';
    const pad = cyl(m, 0.1, 0.1, 0.03, m.dark, 12);
    pad.position.set(Math.cos(a) * 0.62, 0.03, Math.sin(a) * 0.62);
    pad.name = 'lm-footpad';
    g.add(leg, pad);
  }
  // 碟天线 + 桅杆
  const d = dishMesh(m, 0.16);
  d.rotation.x = -Math.PI / 4;
  d.position.set(0.3, 1.05, 0);
  d.name = 'lm-dish';
  g.add(d);
  return g;
}

/* ---------------- 预设表（数据侧 `model` 字段的唯一字典） ----------------
 *  ⚠️ 改这里的参数 = 改对应探测器的画面。新探测器先在这里挑/加预设。 */
export const PRESETS = {
  /* —— 深空 / 星际 —— */
  voyager:     { kind: 'bus', busShape: 'decagon', dish: 'big', wings: 0, boom: true, rtg: true },
  newhorizons: { kind: 'bus', dish: 'big', wings: 0, rtg: true },
  magellan:    { kind: 'bus', dish: 'big', wings: 0, boom: true },
  boomed:      { kind: 'bus', dish: 'big', wings: 0, boom: true, probe: true },   // 卡西尼 / 伽利略
  parker:      { kind: 'bus', dish: null, wings: 0, shield: true },
  shieldwing:  { kind: 'bus', dish: null, wings: 2, span: 1.1, shield: true },    // 太阳轨道器 / 贝皮
  observatory: { kind: 'bus', dish: 'small', wings: 2 },                          // SOHO / SDO / Aditya
  orbiter:     { kind: 'bus', dish: 'small', wings: 2 },                          // 通用轨道器
  bigwings:    { kind: 'bus', dish: 'small', wings: 2, span: 2.6 },               // JUICE / Clipper / 罗塞塔
  fans:        { kind: 'bus', dish: 'small', wings: 'round', span: 2.2 },         // 露西
  crosswings:  { kind: 'bus', dish: 'small', wings: 4, span: 1.3 },               // 灵神星
  ion:         { kind: 'bus', dish: 'small', wings: 2, thruster: true },          // 黎明（离子）
  sampler:     { kind: 'bus', dish: 'small', wings: 2, horn: true },              // 隼鸟系 / OSIRIS
  impactor:    { kind: 'bus', dish: null, wings: 2, span: 0.9 },                  // DART / 赫拉 / 深度撞击
  juno:        { kind: 'juno' },
  /* —— 着陆 / 巡视 —— */
  rover:       { kind: 'rover', wheels: 6 },
  rover8:      { kind: 'rover', wheels: 8 },                                      // 月球车 1 号
  lander:      { kind: 'lander', legs: 4 },
  lander3:     { kind: 'lander', legs: 3 },                                       // SLIM / 菲莱
  sphere:      { kind: 'lander', sphere: true },                                  // 金星 7 / 月球 9 / 惠更斯
  apollo:      { kind: 'apollo' },
};

/** 构型中文名（详情面板「本体构型」用） */
export const PRESET_LABEL = {
  voyager: '桁架 + 大碟 + RTG（星际巡行）', newhorizons: '大碟 + RTG（冥王星级）',
  magellan: '大碟雷达测绘', boomed: '悬杆 + 大碟 + 侧挂探针', parker: '碳遮热罩（触摸太阳）',
  shieldwing: '遮热罩 + 太阳翼', observatory: '观测平台 + 双翼', orbiter: '经典轨道器（双翼 + 碟）',
  bigwings: '巨型太阳翼（外太阳系）', fans: '圆形翼扇（特洛伊巡行）', crosswings: '十字四翼',
  ion: '离子推进（电推深空）', sampler: '采样返回（喇叭机构）', impactor: '撞击器（行星防御）',
  juno: '六棱柱 + 三巨翼（木星极轨）', rover: '六轮巡视器', rover8: '八轮月面巡视车',
  lander: '四腿着陆平台', lander3: '三腿小型着陆器', sphere: '球形弹道舱', apollo: '阿波罗登月舱',
};

/**
 * 造一台探测器模型。
 * @param {{preset?: string, color?: string, size?: number}} o
 *   preset  预设键（见 `PRESETS`），未知键回退 `orbiter`（并 console.warn——
 *           不静默：拼错预设名应该被看见）
 *   color   主题色（当前只给未覆盖的兜底材质用，保留参数位）
 *   size    世界单位下的整机最大展幅（太阳系层 ≈ 翼展）
 */
export function makeSpacecraftModel({ preset = 'orbiter', color = '#c8d4e4', size = 0.004 } = {}) {
  const p = PRESETS[preset];
  if (!p) {
    console.warn(`[spacecraft] 未知构型预设 "${preset}"，回退 orbiter。合法键见 objects/spacecraft.js 的 PRESETS。`);
    return makeSpacecraftModel({ preset: 'orbiter', color, size });
  }
  const m = mats();
  let root;
  if (p.kind === 'bus') root = buildBus(m, p);
  else if (p.kind === 'juno') root = buildJuno(m);
  else if (p.kind === 'rover') root = buildRover(m, p);
  else if (p.kind === 'lander') root = buildLander(m, p);
  else if (p.kind === 'apollo') root = buildApollo(m);
  else root = buildBus(m, {});
  // 单位坐标系整机展幅 ≈ 3 单位 ⇒ 缩放到调用方的 size
  root.scale.setScalar(size / 3);
  root.name = `spacecraft-${preset}`;
  const wrap = new THREE.Group();
  wrap.add(root);
  wrap.name = `probe-model-${preset}`;
  return wrap;
}
