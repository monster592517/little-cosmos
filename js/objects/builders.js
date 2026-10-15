/**
 * 三维物体构建器：把数据变成可渲染对象
 */
import * as THREE from 'three';
import { makeGlowTexture, makeStarTexture, makeRingTexture, makePlanetTexture, makeGalaxyTexture, mulberry, fbm3,
  MW_ARMS, armPoint } from '../proc/textures.js';

const DEG = Math.PI / 180;

/* ---------------- 地球：昼夜交界 + 城市灯光 + 海洋高光 ---------------- */
export function makeEarthMaterial({ day, night, specular, normal = null, sunPos = new THREE.Vector3(0, 0, 0) }) {
  return new THREE.ShaderMaterial({
    uniforms: {
      dayMap: { value: day },
      nightMap: { value: night },
      specMap: { value: specular },
      normalMap: { value: normal },
      sunPos: { value: sunPos.clone() },
      uNightGain: { value: 1.6 },
    },
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vNormalW;
      varying vec3 vPosW;
      void main() {
        vUv = uv;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vPosW = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform sampler2D dayMap;
      uniform sampler2D nightMap;
      uniform sampler2D specMap;
      uniform vec3 sunPos;
      uniform float uNightGain;
      varying vec2 vUv;
      varying vec3 vNormalW;
      varying vec3 vPosW;
      void main() {
        vec3 N = normalize(vNormalW);
        vec3 L = normalize(sunPos - vPosW);
        vec3 V = normalize(cameraPosition - vPosW);
        float ndl = dot(N, L);
        float dayF = smoothstep(-0.10, 0.16, ndl);

        vec3 dayCol = texture2D(dayMap, vUv).rgb;
        vec3 nightCol = texture2D(nightMap, vUv).rgb;
        float ocean = texture2D(specMap, vUv).r;

        vec3 H = normalize(L + V);
        float spec = pow(max(0.0, dot(N, H)), 68.0) * ocean * dayF;

        vec3 col = dayCol * (0.05 + 1.06 * max(0.0, ndl)) * dayF;
        col += nightCol * uNightGain * (1.0 - dayF);
        col += vec3(0.82, 0.90, 1.0) * spec * 2.2;

        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    toneMapped: true,
  });
}

/* ---------------- 太阳：自发光光球 + 临边昏暗 + 色球红边 ----------------
 *
 * ⚠️ 这里的目标色是**物理算出来的**，不是调出来的。
 *
 * 太阳光球有效温度 5772 K。把它当黑体，经 CIE 1931 积分 + Bradford 色适应到
 * D65，得到的是 **#fff1ea**（255,241,234）—— 极亮的白，只带一丝暖。
 * 用 `cie.blackbodyToHex(5772)` 可复现。
 *
 * 为什么太阳看着偏黄？那是**地球大气 Rayleigh 散射**造成的，
 * 不是太阳本身的颜色。天顶看仍是近白，日落时才因光程变长而橙红。
 * 所以空间视角的太阳**必须**是近白 —— 用户抱怨的「太阳发白」，
 * 其实物理上是对的；**错的不是"白"，而是原来的实现白得不对**：
 *
 *   原实现：c = pow(c, 0.82) * 1.85
 *     sun.jpg 平均 #f18727 → 线性 (0.880, 0.242, 0.020)
 *     → pow(...,0.82)*1.85 = (1.665, 0.579, 0.076)
 *     → R 超界被裁成 1.0，G 留在 0.579
 *     → 输出 **#ffc84e**，过饱和的橙黄，且丢掉一半动态范围
 *   （实测复现，不是估算。）
 *
 * ── 关键概念：太阳是**自发光体**，不是反射体 ──
 * 反射体的颜色 = 反照率 × 光源；自发光体的颜色 = 它自己的黑体辐射谱。
 * 所以太阳贴图**不能**当作基色去乘 —— 它的暗部（黑子、米粒间隙）
 * 是"比别处暗一点"，不是"反射率低"。
 *
 * 正确处理分两层：
 *   1. **基色层**：由色温决定的黑体色 `uTint`，亮度由 `uEmission` 给。
 *      这一层保证整体色相与亮度正确。
 *   2. **结构层**：贴图只提供**相对变化量**（以 1.0 为中心 ±幅度），
 *      乘在基色上。这样贴图再暗也不会把太阳整体拖黑。
 *
 * 第一次改这个 shader 时我漏了第 1 层，直接把贴图当基色 → 中心算出
 * #d29271（暗橙），并且边缘比中心亮。**这是把自发光体当反射体处理的典型错误。**
 */
export const SUN_TARGET_HEX = '#fff1ea';   // 5772 K 黑体，见 cie.blackbodyToHex(5772)
export const SUN_TINT = [1.0, 0.975, 0.955]; // 相对白的轻微暖偏移（线性空间）
export const SUN_EMISSION = 0.94;            // 基色亮度：留一点余量给色球/耀斑叠加

export function makeSunMaterial({ texture }) {
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: texture },
      time: { value: 0 },
      uEmission: { value: SUN_EMISSION },
      uTint: { value: new THREE.Vector3(...SUN_TINT) },
      uStructure: { value: 0.22 },  // 贴图结构相对基色的幅度上限
    },
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vNormalW;
      varying vec3 vPosW;
      void main() {
        vUv = uv;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vPosW = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform sampler2D map;
      uniform float time;
      uniform float uEmission;
      uniform float uStructure;
      uniform vec3 uTint;
      varying vec2 vUv;
      varying vec3 vNormalW;
      varying vec3 vPosW;
      void main() {
        vec3 N = normalize(vNormalW);
        vec3 V = normalize(cameraPosition - vPosW);
        float limb = 1.0 - abs(dot(N, V));

        // ── 第 2 层：贴图只给「相对变化量」──
        // 先把贴图转成围绕 0 的偏差，再映射到 ±uStructure。
        // 这样无论贴图本身多亮多暗，太阳整体亮度都锚在 uEmission 上。
        vec3 s = texture2D(map, vUv + vec2(time * 0.0022, time * 0.0006)).rgb;
        float mean = dot(s, vec3(0.2126, 0.7152, 0.0722));
        float dev = mean > 1e-4 ? (mean - 0.5) : 0.0;       // 以中灰为基准的偏差
        float structure = 1.0 + clamp(dev * 2.0, -1.0, 1.0) * uStructure;

        // ── 第 1 层：黑体基色 × 发射强度 × 结构 ──
        vec3 c = uTint * uEmission * structure;

        // 临边昏暗（limb darkening）：真实太阳边缘比中心暗约 25-35%。
        // 这是**太阳自身的**物理效应，与大气无关。
        c *= 1.0 - 0.32 * pow(limb, 1.8);

        // 色球红边：只在最外缘极窄一圈。注意它是**加法**，
        // 所以必须比临边昏暗弱，否则边缘会反而比中心亮（踩过一次）。
        c += vec3(1.0, 0.42, 0.12) * pow(limb, 6.0) * 0.14;

        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    toneMapped: true,
  });
}

/* ---------------- 云层 ---------------- */
export function makeCloudMaterial({ texture, opacity = 0.62 }) {
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: texture },
      opacity: { value: opacity },
      sunPos: { value: new THREE.Vector3(0, 0, 0) },
    },
    vertexShader: `
      varying vec2 vUv; varying vec3 vNormalW; varying vec3 vPosW;
      void main() {
        vUv = uv;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vPosW = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform sampler2D map; uniform float opacity; uniform vec3 sunPos;
      varying vec2 vUv; varying vec3 vNormalW; varying vec3 vPosW;
      void main() {
        vec4 t = texture2D(map, vUv);
        float a = t.r * opacity;
        vec3 N = normalize(vNormalW);
        vec3 L = normalize(sunPos - vPosW);
        float lit = smoothstep(-0.15, 0.25, dot(N, L));
        vec3 col = vec3(1.0) * (0.10 + 0.95 * lit);
        gl_FragColor = vec4(col, a * (0.25 + 0.75 * lit));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, toneMapped: true,
  });
}

/* ---------------- 小行星 / 彗核：按真实形状特征建模 ---------------- */

/** 把非索引几何**焊接成索引几何**（同位置顶点合并）。
 *
 *  ⚠️ 2026-10-11 视觉修复的关键一步：`IcosahedronGeometry`（PolyhedronGeometry 系）
 *  产出**非索引**几何 —— 每个面自带三个独立顶点，`computeVertexNormals()`
 *  算出来的是**逐面法线** = 纯平着色，位移再多细节也是一脸三角棱面
 *  （哈雷彗星特写实拍 `shots/opt-before/B-halley.png`：一颗 d20 骰子）。
 *  焊接之后顶点共享，法线平滑，fbm 位移才读得成「岩石起伏」。
 */
function weldGeometry(geo) {
  const pos = geo.attributes.position;
  const map = new Map();
  const verts = [];
  const idx = new Uint32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    // 顶点数值来自同一条细分路径，共享边的两次计算给出**逐位相同**的浮点；
    // toFixed(5) 的桶只是防浮点噪声的保险，正常情况下不会发生重键不同值。
    const key = `${x.toFixed(5)}|${y.toFixed(5)}|${z.toFixed(5)}`;
    let vi = map.get(key);
    if (vi === undefined) { vi = verts.length / 3; verts.push(x, y, z); map.set(key, vi); }
    idx[i] = vi;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

export function makeAsteroidGeometry({ radius = 1, shape = 'irregular', seed = 1, detail = 2 }) {
  const geo = weldGeometry(new THREE.IcosahedronGeometry(1, detail));
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  const s = (seed % 97) * 0.137;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    const rough = 1 + (fbm3(v.x * 2.4 + s, v.y * 2.4, v.z * 2.4, 4, seed) - 0.5) * 0.55
      + (fbm3(v.x * 6.5, v.y * 6.5, v.z * 6.5, 3, seed + 11) - 0.5) * 0.18;
    let x = v.x * rough, y = v.y * rough, z = v.z * rough;
    switch (shape) {
      case 'elongated': x *= 1.85; y *= 0.78; z *= 0.78; break;
      case 'peanut': {
        x *= 1.6;
        const pinch = 1 - 0.42 * Math.exp(-Math.pow(x / 0.30, 2));
        y *= pinch; z *= pinch; break;
      }
      case 'bone': {
        x *= 1.75;
        const pinch = 1 - 0.62 * Math.exp(-Math.pow(x / 0.26, 2));
        y *= pinch; z *= pinch; break;
      }
      case 'top': {
        y *= 0.76;
        const eq = 1 + 0.32 * Math.exp(-Math.pow(y / 0.32, 2));
        x *= eq; z *= eq; break;
      }
      case 'snowman':
      case 'duck': {
        x *= 1.5;
        const pinch = 1 - 0.5 * Math.exp(-Math.pow(x / 0.22, 2));
        y *= pinch; z *= pinch; break;
      }
      default: break;
    }
    pos.setXYZ(i, x * radius, y * radius, z * radius);
  }
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/* ---------------- 恒星 ---------------- */
export function makeStarBody({ radius, texture = null, color = '#ffcf5c', glowScale = 7, glowOpacity = 0.85 }) {
  const group = new THREE.Group();
  const geo = new THREE.SphereGeometry(radius, 64, 32);
  const mat = texture
    ? new THREE.MeshBasicMaterial({ map: texture, toneMapped: true })
    : new THREE.MeshBasicMaterial({ color });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'body';
  group.add(mesh);

  const glowTex = makeGlowTexture(color, 0.3, 256);
  const mk = (scale, opacity) => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color, transparent: true, opacity,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
    }));
    s.scale.setScalar(radius * scale);
    return s;
  };
  const halo = mk(glowScale, glowOpacity);
  const outer = mk(glowScale * 2.8, glowOpacity * 0.3);
  halo.name = 'glow'; outer.name = 'glow-outer';
  group.add(halo, outer);
  group.userData.isStar = true;
  return group;
}

/* ---------------- 行星 / 卫星 ---------------- */
export function makePlanetBody({ radius, texture = null, color = '#9a9a9a', bump = null, normal = null, roughness = 0.85, emissive = 0, segments = 48, atmosphere = null, atmosphereIntensity = 0.85, atmospherePower = 2.6, tint = null }) {
  const group = new THREE.Group();
  const geo = new THREE.SphereGeometry(radius, segments, segments / 2);
  const params = {
    map: texture || null,
    /* ⚠️ `tint`：贴图存在时的**乘色**（2026-10-11 加）。唯一现役用户 = 海王星：
     *    Solar System Scope 那张 neptune.jpg 偏灰白，贴出来整颗星读不出「海王星蓝」。
     *    取色落在两界之间：大众认知的增强深蓝（≈#2b55b4）太艳，Irwin+2024 的
     *    真彩测定（与天王星相近的浅蓝绿）又太平 —— 取中段的 azure 乘上去。
     *    其它行星一律 null（= 0xffffff，不改变任何现有像素）。 */
    color: texture ? (tint ? new THREE.Color(tint) : 0xffffff) : new THREE.Color(color),
    roughness, metalness: 0.02,
    emissive: new THREE.Color(emissive > 0 ? color : 0x000000),
    emissiveIntensity: emissive,
    bumpMap: bump || null,
    bumpScale: bump ? 0.35 : 0,
  };
  if (normal) { params.normalMap = normal; params.normalScale = new THREE.Vector2(0.9, 0.9); }
  const mat = new THREE.MeshStandardMaterial(params);
  if (!texture) {
    mat.map = makePlanetTexture({ base: color, seed: Math.round(radius * 977) % 9999, mode: 'rocky' });
  }
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'body';
  group.add(mesh);

  if (atmosphere) {
    const shell = new THREE.Mesh(
      new THREE.SphereGeometry(radius * 1.045, 40, 20),
      new THREE.ShaderMaterial({
        uniforms: {
          glowColor: { value: new THREE.Color(atmosphere) },
          intensity: { value: atmosphereIntensity },
          rimPower: { value: atmospherePower },
        },
        vertexShader: `varying vec3 vNormal; varying vec3 vPos;
          void main(){ vNormal = normalize(normalMatrix * normal); vPos = (modelViewMatrix * vec4(position,1.0)).xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `uniform vec3 glowColor; uniform float intensity; uniform float rimPower; varying vec3 vNormal; varying vec3 vPos;
          void main(){
            vec3 viewDir = normalize(-vPos);
            float rim = 1.0 - max(dot(viewDir, vNormal), 0.0);
            float a = pow(rim, rimPower) * intensity;
            gl_FragColor = vec4(glowColor, a);
          }`,
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.FrontSide,
      }),
    );
    shell.name = 'atmosphere';
    group.add(shell);
  }
  return group;
}

/* ---------------- 星环 ---------------- */
export function makeRingMesh({ innerR, outerR, texture = null, color = '#e8dcc0', opacity = 0.92, segments = 220 }) {
  const geo = new THREE.RingGeometry(innerR, outerR, segments, 6);
  // 让 UV 沿半径方向分布，贴图取横向渐变
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const r = v.length();
    uv.setXY(i, (r - innerR) / (outerR - innerR), 0.5);
  }
  uv.needsUpdate = true;
  const tex = texture || makeRingTexture({ color });
  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, opacity, side: THREE.DoubleSide,
    depthWrite: false, alphaTest: 0.02,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = Math.PI / 2;
  mesh.name = 'ring';
  return mesh;
}

/* ---------------- 轨道线 ---------------- */
export function makeOrbitLine(positions, { color = '#67e8f9', opacity = 0.32, closed = true } = {}) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
  const line = new THREE.Line(geo, mat);
  line.frustumCulled = false;
  return line;
}

/* ---------------- 背景星空 ---------------- */
export function makeStarfield({ count = 4000, radius = 1, size = 1.6, seed = 11, innerRadius = 0.75 } = {}) {
  const rnd = mulberry(seed);
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    // 均匀球面分布
    const u = rnd() * 2 - 1;
    const th = rnd() * Math.PI * 2;
    const r = innerRadius + rnd() * (1 - innerRadius);
    const s = Math.sqrt(1 - u * u);
    pos[i * 3] = Math.cos(th) * s * r * radius;
    pos[i * 3 + 1] = u * r * radius;
    pos[i * 3 + 2] = Math.sin(th) * s * r * radius;
    const t = rnd();
    c.setHSL(t < 0.15 ? 0.08 : t < 0.5 ? 0.58 : 0.11, t < 0.5 ? 0.35 : 0.5, 0.62 + rnd() * 0.3);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({
    size, sizeAttenuation: true, vertexColors: true, transparent: true, opacity: 0.9,
    map: makeStarTexture('#ffffff'), alphaTest: 0.02, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.name = 'starfield';
  return pts;
}

/* ---------------- 粒子带（小行星带 / 柯伊伯带） ---------------- */
export function makeParticleBelt({ count = 3000, inner = 2.1, outer = 3.3, thickness = 0.16, color = '#b9a68c', size = 0.012, seed = 3, eccentricity = 0.08, tiltJitter = 0.1 }) {
  const rnd = mulberry(seed * 131 + 5);
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const a = rnd() * Math.PI * 2;
    const r = inner + Math.pow(rnd(), 0.7) * (outer - inner);
    const e = 1 + (rnd() - 0.5) * eccentricity;
    const y = (rnd() - 0.5) * thickness * r + (rnd() - 0.5) * tiltJitter;
    pos[i * 3] = Math.cos(a) * r * e;
    pos[i * 3 + 1] = y;
    pos[i * 3 + 2] = Math.sin(a) * r * e;
    const g = 0.55 + rnd() * 0.45;
    c.set(color).multiplyScalar(g);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({
    size, sizeAttenuation: true, vertexColors: true, transparent: true, opacity: 0.55,
    depthWrite: false, alphaTest: 0.02,
    map: makeStarTexture('#ffffff'),          // 圆点贴图：否则近距离会渲染成实心方块
    blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(geo, mat);
  pts.name = 'belt';
  return pts;
}

/* ---------------- 精灵 / 星系 ---------------- */
export function makeSprite({
  texture, size = 1, color = '#ffffff', opacity = 1, additive = true,
  sizeAttenuation = true, depthTest = true, renderOrder = 0,
}) {
  const mat = new THREE.SpriteMaterial({
    map: texture, color, transparent: true, opacity,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    depthWrite: false,
    /* ⚠️ `sizeAttenuation` 决定 `size` 的**量纲**，改它之前先想清楚你想要哪种：
     *   · `true`（默认，绝大多数字体用它）—— `size` 是**世界单位**。
     *     语义 = 「这个天体本身有多大」，随距离近大远小。远处的星系盘、恒星、
     *     光晕都该用它。
     *   · `false` —— `size` 是**视口高度的比例**（不是像素、更不是世界单位）。
     *     语义 = 「这是一块 UI 标记，不是天体」，屏幕上**恒定大小**。
     *     要在屏幕上得到 `px` 总宽，`size ≈ px · 2·tan(fov/2) / 视口高度`
     *     （本工程相机 fov=52° ⇒ `size ≈ px / (1.025 · H)`）。
     *     用它把「标记点」和「天体」在语义上彻底分开 —— 混用会让某个标记
     *     在某个视距下长成一颗天体（第 33 轮「银河系第二个核」就是这么来的）。
     * 详见 `web/js/levels/galaxy.js` 太阳系标记那段。 */
    sizeAttenuation,
    /* ⚠️ 默认 `depthTest: true`。只有「我们在这里」这类**方位标记**才该关掉它 ——
     *    标记被自己家的盘挡住就失去意义了。关掉时请顺带给一个高 `renderOrder`，
     *    否则它会被同深度的 additive 光晕按绘制顺序盖回去。 */
    depthTest,
  });
  const s = new THREE.Sprite(mat);
  s.scale.setScalar(size);
  s.renderOrder = renderOrder;
  return s;
}

export function makeGalaxySprite({ type = 'spiral', color = '#cfe0ff', size = 1, seed = 1, opacity = 1 }) {
  const tex = makeGalaxyTexture({ type, color, seed });
  const s = makeSprite({ texture: tex, size, color: '#ffffff', opacity, additive: true });
  s.material.rotation = seed * 0.7;
  return s;
}

/* ---------------- 星系盘（有固定朝向） ---------------- */

/** 天极（赤道坐标的 +Z）。世界坐标 = 赤道直角坐标，所以天极就是 +Z。 */
const CELESTIAL_POLE = new THREE.Vector3(0, 0, 1);

/** 没有实测倾角的星系用这个。**确定性**（同一个 seed 每次都一样），不是随机。
 *  ⚠️ 这是**示意，不是实测**：不规则矮星系的「盘」是不是存在本身就有争议，
 *     文献里给不出倾角。取 12°~74° 是为了避开正对（0°）与完全侧对（90°）两个端点
 *     —— 那两个端点上的投影形状最没有信息量。 */
function fallbackGalaxyAngles(seed) {
  const r = mulberry(seed * 7919 + 11);
  return { incl: 12 + r() * 62, pa: r() * 360 };
}

/** 星系盘的朝向四元数。**独立导出是为了能被探针单独量**（判据要好打）。
 *
 * ## 为什么必须换掉 `THREE.Sprite`
 * `Sprite` **天生是 billboard**：朝向完全由相机决定，`lookAt()` 挂在 Sprite 上
 * **没有任何效果**。本星系群原来就是 `makeGalaxySprite` + `spr.lookAt(0,0,0)`，
 * 所以那句 `lookAt` 是**死代码**，画面上表现为「转动的时候他始终面向屏幕」
 * —— 永远看不到侧视，星系像贴在屏幕上的贴纸。
 *
 * ## 朝向口径（由参考推参数，不是调出来的）
 *  · `inclDeg` 盘面倾角：0° = 正对我们（face-on），90° = 侧对我们（edge-on）
 *  · `paDeg`   位置角：长轴在天空上的方向，**从北向东量**（East of North）
 *              —— 这是天文文献里 PA 的标准口径，**不是**屏幕角度
 *  · `pole`    直接给盘面法线的赤经/赤纬 —— 银河系用这项：我们在它**里面**，
 *              「它对我们多少度」没有定义，但**银道面**的方向是精确已知的常数
 *
 * ## 数学（推过一次，别再猜）
 *  视向        ŝ = 归一化(原点 − 位置)        （星系 → 观察者）
 *  天空基      north = 天极在 ⊥ŝ 平面上的投影；east = north × ŝ
 *  长轴方向    m = cos(PA)·north + sin(PA)·east
 *  盘面法线    n = cos(i)·ŝ + sin(i)·(ŝ × m)
 *  ⇒ 于是「观察到的椭圆长轴 = PA、短长比 = cos i」，与文献给的那两个量一一对应。
 *  ⇒ **从这个组合算出来的视形状，就是从银河系看过去真实看到的那一个。**
 *
 * @returns {THREE.Quaternion} 让 `PlaneGeometry` 的 **+Z（法线）→ n、+X（长轴）→ m**
 */
export function galaxyDiscQuaternion({ position = [0, 0, 0], inclDeg = null, paDeg = null, pole = null, seed = 1 } = {}) {
  const p = new THREE.Vector3(position[0], position[1], position[2]);
  let n, x;
  if (pole) {
    // 直接给法线（赤经/赤纬 → 赤道直角坐标，与世界坐标同口径）
    const ra = pole[0] * DEG, dec = pole[1] * DEG;
    n = new THREE.Vector3(
      Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec),
    ).normalize();
    // 面内长轴：取「最接近天极」的那个面内方向（银河系的面内滚转角本来就观测不到）
    const nn = CELESTIAL_POLE.clone().sub(n.clone().multiplyScalar(CELESTIAL_POLE.dot(n)));
    x = nn.lengthSq() > 1e-12 ? nn.normalize() : new THREE.Vector3(1, 0, 0);
  } else {
    // ⚠️ 位置在原点（= 银河系）时视向退化，此时必须走 `pole` 分支
    const phat = p.lengthSq() > 1e-12 ? p.clone().normalize() : CELESTIAL_POLE.clone();
    const s = phat.clone().negate();
    const north = CELESTIAL_POLE.clone().sub(phat.clone().multiplyScalar(CELESTIAL_POLE.dot(phat)));
    if (north.lengthSq() < 1e-12) north.set(1, 0, 0);     // 星系正对天极时 north 退化
    north.normalize();
    const east = new THREE.Vector3().crossVectors(north, phat).normalize();
    const fb = (inclDeg == null || paDeg == null) ? fallbackGalaxyAngles(seed) : null;
    const incl = inclDeg != null ? inclDeg : fb.incl;
    const pa = paDeg != null ? paDeg : fb.pa;
    x = north.clone().multiplyScalar(Math.cos(pa * DEG))
      .add(east.clone().multiplyScalar(Math.sin(pa * DEG))).normalize();       // 长轴 m（⊥ ŝ）
    const t = new THREE.Vector3().crossVectors(phat, x).normalize();           // ⊥ ŝ 且 ⊥ m
    n = s.clone().multiplyScalar(Math.cos(incl * DEG))
      .add(t.multiplyScalar(Math.sin(incl * DEG))).normalize();
  }
  // 右手基：X = 长轴，Z = 法线 ⇒ Y = Z × X；PlaneGeometry 的本地 +Z 就是法线
  const y = new THREE.Vector3().crossVectors(n, x).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, n));
}

/** 星系盘 —— **有固定朝向的平面**，不是 billboard。
 *
 * ⚠️ 贴图必须传 `squash: 1`（正圆）：倾斜由这里的真实倾角在三维里摆，
 *    贴图里再压扁一次等于**把倾角算了两遍**。
 * @param {object} o 见 `galaxyDiscQuaternion`；另加 `type/color/size/seed/opacity`
 */
export function makeGalaxyDisc({
  type = 'spiral', color = '#cfe0ff', size = 1, seed = 1, opacity = 1,
  position = [0, 0, 0], inclDeg = null, paDeg = null, pole = null,
  texture = null,
}) {
  /* ⚠️ `texture` 是**贴图覆盖**入口（2026-09-12 第 33 轮加的），给银河系用。
   *    为什么必须有这个口子：银河系在本产品里出现了**两次** —— galaxy 层的俯视银盘
   *    和本星系群里的那个成员。两处若各用一张贴图（一处 `makeMilkyWayDiskTexture`、
   *    一处通用的 `makeGalaxyTexture`），同一个天体就有两副长相：
   *    俯视是棒旋、本星系群里是两条臂的小风车 —— 用户看到的正是这个「四不像」。
   *    ⇒ 让调用方把**同一张**真银河系贴图递进来，是唯一能保证两处一致的做法。 */
  const tex = texture || makeGalaxyTexture({ type, color, seed, squash: 1 });
  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, opacity,
    blending: THREE.AdditiveBlending, depthWrite: false,
    side: THREE.DoubleSide,
  });
  const disc = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
  disc.position.set(position[0], position[1], position[2]);
  disc.quaternion.copy(galaxyDiscQuaternion({ position, inclDeg, paDeg, pole, seed }));
  disc.name = 'galaxy-disc';
  return disc;
}

/* ---------------- 圆环标记 ---------------- */
export function makeRingMarker({ radius = 1, color = '#67e8f9', opacity = 0.5, segments = 64 }) {
  const pts = new Float32Array((segments + 1) * 3);
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts[i * 3] = Math.cos(a) * radius;
    pts[i * 3 + 1] = 0;
    pts[i * 3 + 2] = Math.sin(a) * radius;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
  return new THREE.Line(geo, mat);
}

/** 螺旋臂曲线点（银河系用）。
 *
 *  ⚠️ 2026-09-11：这里原来是**第三套**螺旋公式 —— `phase + ln(1 + r·twist·9)·turns`。
 *  它**根本不是对数螺旋**（`ln(1+kr)` 不是 `ln r` 的线性函数，曲率随半径一直变），
 *  于是「导引线 / 粒子撒的臂 / 贴图画的臂」三者互不相干，全都在画同一个银河系。
 *  现在直接沿 `MW_ARMS` 主臂取点，与撒点、贴图共用同一个 `armPoint`。
 * @param {{arm?:object, samples?:number}} o
 */
export function spiralArmPoints({ arm = MW_ARMS[0], samples = 220 } = {}) {
  const pts = new Float32Array(samples * 3);
  for (let i = 0; i < samples; i++) {
    const p = armPoint(arm, i / (samples - 1));
    pts[i * 3] = Math.cos(p.a) * p.r;
    pts[i * 3 + 1] = 0;
    pts[i * 3 + 2] = Math.sin(p.a) * p.r;
  }
  return pts;
}

export function disposeObject(root) {
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose?.();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      // 注意：贴图是全局缓存并跨层级共享，这里只释放几何与材质本身
      for (const m of mats) m.dispose?.();
    }
  });
}

export { DEG };
