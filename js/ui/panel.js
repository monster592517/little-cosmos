/** 侧栏面板：天体详细属性 / 天体目录 / 设置 / 帮助 */
import { num, distance, period, temp, esc, angle } from '../util/fmt.js';
import { AU_KM } from '../data/solar-system.js';
import { Dataset } from '../data/dataset.js';
import {
  TIER_ATTR, tierOf, showsSunDistance, showsEcliptic, showsGalacticRadius,
  distLyOf, massOf, galacticRadiusKly, EARTH_MASS_KG,
} from '../data/attrs.js';
import { SCALE_CHAIN } from '../core/scales.js';

const MODE_LABEL = {
  orbit: '环绕轨道', landed: '已着陆', heliocentric: '日心飞行', ended: '任务结束',
};

/** 影像类型：原始 / 后处理 / 科学重建 */
const KIND_LABEL = {
  photo: '原始影像', processed: '后处理增强', concept: '科学模拟/艺术家重建',
};

const sci = (v, digits = 3) => {
  if (v == null || !Number.isFinite(v)) return '—';
  const exp = Math.floor(Math.log10(Math.abs(v)));
  const mant = v / Math.pow(10, exp);
  return `${mant.toFixed(digits)} × 10<sup>${exp}</sup>`;
};

export class Panel {
  constructor(app) {
    this.app = app;
    this.el = document.getElementById('panel');
    this.titleEl = document.getElementById('panel-title');
    this.bodyEl = document.getElementById('panel-body');
    document.getElementById('panel-close').addEventListener('click', () => this.close());
  }
  open(title, html) {
    this.titleEl.textContent = title;
    this.bodyEl.innerHTML = html;
    this.bodyEl.scrollTop = 0;
    this.el.hidden = false;
  }
  close() { this.el.hidden = true; this.app.ui.info.current = null; }
  get isOpen() { return !this.el.hidden; }
}

export class InfoPanel {
  constructor(app) { this.app = app; this.current = null; }

  show(id) {
    const b = this.app.dataset.get(id);
    if (!b) return;
    this.current = id;
    this.app.ui.panel.open('天体属性', this.#render(b));
    this.#bind(b);
    this.tick();
  }

  /** 刷新「实时状态」区块（由 HUD 定时器驱动） */
  tick() {
    if (!this.current || !this.app.ui.panel.isOpen) return;
    const el = this.app.ui.panel.bodyEl.querySelector('#live-block');
    if (!el) return;
    const b = this.app.dataset.get(this.current);
    if (b) el.innerHTML = this.#liveHtml(b);
  }

  #liveHtml(b) {
    const eph = this.app.dataset.ephemeris;
    if (!eph || !['star', 'planet', 'dwarf', 'moon', 'asteroid', 'comet', 'tno', 'probe'].includes(b.type)) return '';
    const date = this.app.clock?.date || new Date();
    const L = eph.live(b.id, date);
    if (!L) return '';
    const rows = [];
    const row = (k, v) => { if (v != null && v !== '—') rows.push(`<dt>${k}</dt><dd>${v}</dd>`); };

    if (b.type === 'probe') {
      row('距太阳', `${num(L.rHelioAu, 3)} AU`);
      row('距地球', `${num(L.rGeoAu, 3)} AU<span class="u">· 光行 ${num(L.lightTimeSec / 60, 2)} 分钟</span>`);
      if (L.rHostAu != null) {
        const host = this.app.dataset.get(b.host);
        row(`距${host?.name || '目标'}`, `${distance(L.rHostAu * AU_KM)}<span class="u">（${num(L.rHostAu, 5)} AU）</span>`);
      }
      row('日心黄经', `${num(L.lonDeg, 2)}°`);
      row('日心黄纬', `${num(L.latDeg, 2)}°`);
      if (b.mode === 'heliocentric' && b.helio) row('径向速度', `${num(b.helio.speedAuPerYear * 4.7405, 2)} km/s`);
      return rows.length ? `<dl class="kv">${rows.join('')}</dl>` : '';
    }

    if (b.type === 'moon') {
      const off = eph.satelliteOffset(b, date);
      const dParent = Math.hypot(off.x, off.y, off.z);
      row('距母星', `${distance(dParent * AU_KM)}<span class="u">（${num(dParent, 6)} AU）</span>`);
      row('距太阳', `${num(L.rHelioAu, 4)} AU`);
      row('距地球', `${num(L.rGeoAu, 4)} AU<span class="u">· 光行 ${num(L.lightTimeSec / 60, 2)} 分钟</span>`);
      row('轨道速度', `${num(L.speedKms, 3)} km/s`);
      if (L.angularDiameterArcsec) row('视直径', angle(L.angularDiameterArcsec));
    } else if (b.id === 'sun') {
      row('距地球', `${num(L.rGeoAu, 6)} AU<span class="u">· 光行 ${num(L.lightTimeSec / 60, 2)} 分钟</span>`);
      row('视直径', angle(L.angularDiameterArcsec));
      row('黄经', `${num(L.lonDeg, 4)}°`);
    } else if (b.id === 'earth') {
      row('日心黄经', `${num(L.lonDeg, 4)}°`);
      row('日心黄纬', `${num(L.latDeg, 4)}°`);
      row('距太阳', `${num(L.rHelioAu, 6)} AU<span class="u">（${distance(L.rHelioAu * AU_KM)}）</span>`);
      row('公转速度', `${num(L.speedKms, 3)} km/s`);
    } else {
      row('日心黄经', `${num(L.lonDeg, 4)}°`);
      row('日心黄纬', `${num(L.latDeg, 4)}°`);
      row('距太阳', `${num(L.rHelioAu, 6)} AU<span class="u">（${distance(L.rHelioAu * AU_KM)}）</span>`);
      row('距地球', `${num(L.rGeoAu, 6)} AU<span class="u">· 光行 ${num(L.lightTimeSec / 60, 2)} 分钟</span>`);
      row('轨道速度', `${num(L.speedKms, 3)} km/s`);
      if (L.mag != null) row('视星等', num(L.mag, 2));
      if (L.phaseFraction != null) row('相位', `${num(L.phaseFraction * 100, 1)}%`);
      if (L.angularDiameterArcsec) row('视直径', angle(L.angularDiameterArcsec));
      if (L.ringTilt != null && b.ring) row('环面倾角', `${num(L.ringTilt, 2)}°`);
    }
    return rows.length ? `<dl class="kv">${rows.join('')}</dl>` : '';
  }

  /* ============================================================
   *  尺度语义：属性的选区
   *
   *  面板原来对**所有**天体都渲染同一套区块：轨道六根数 + 太阳系式物理参数。
   *  于是出了太阳系就成了怪话 —— 一个 2.7 万光年外的星系被问「升交点黄经」、
   *  一个系外行星被问「与太阳的距离」。用户的原话：
   *    「大部分的天体属性都还默认走的太阳系内部的那一套，这不合理的」
   *    「你都出了太阳系了还走黄道面夹角之类的」
   *
   *  口径集中在 `data/attrs.js`，这里只负责**按口径取数**。
   *  改属性显示条件时改那边，不要在这里再写一套判断。
   * ============================================================ */

  /** 距离口径的**人话解释**。用户看到「120 万光年」时必须知道这个数是怎么来的。 */
  static #DIST_SOURCE = {
    redshift: '由红移推算（哈勃定律 H₀=70 km/s/Mpc）',
    parallax: '三角视差实测',
    parallax_gaia: 'Gaia 三角视差',
    class: '按天体类型给的典型距离 —— **不是实测值**',
    cluster: '所属星团的平均距离',
    unknown: '尚未测定',
  };

  #distSourceText(o) {
    if (!o) return null;
    const key = o.distSource;
    if (key && InfoPanel.#DIST_SOURCE[key]) return InfoPanel.#DIST_SOURCE[key];
    if (o.distIsParallax === true) return InfoPanel.#DIST_SOURCE.parallax;
    if (o.noDistance) return InfoPanel.#DIST_SOURCE.unknown;
    return key ? String(key) : null;
  }

  /** 把光年按数量级写成好读的形式 */
  #lyText(ly) {
    if (!Number.isFinite(ly)) return null;
    if (ly < 1000) return `${num(ly, ly < 10 ? 2 : 1)} 光年`;
    if (ly < 1e6) return `${num(ly / 1000, 2)} 千光年`;
    if (ly < 1e9) return `${num(ly / 1e6, 2)} 百万光年`;
    return `${num(ly / 1e9, 3)} 十亿光年`;
  }

  /**
   * **位置与距离** —— 唯一随尺度变化的定位区块。
   *
   * 口径（见 `attrs.js:TIER_ATTR`）：
   *   · 「与太阳的距离」只在 **solar + neighborhood** 出现。出了太阳系，
   *     这个量对**别人**没有意义（对太阳系自己才有意义）。
   *   · 银河系层改用**银心距** —— 那才是描述一个银河系内天体位置的量。
   *   · 更高层用**共动距离**（Mly / Gly）。
   */
  #positionRows(b, tier) {
    const rows = [];
    const T = TIER_ATTR[tier] || TIER_ATTR.solar;

    if (showsSunDistance(tier)) {
      const ly = distLyOf(b);
      if (Number.isFinite(ly)) rows.push(['与太阳的距离', this.#lyText(ly)]);
    }
    if (showsGalacticRadius(tier)) {
      const R = galacticRadiusKly(b, { allowOrigin: b.id === 'sun' || b.id === 'star-sun' });
      if (Number.isFinite(R)) rows.push(['距银心', `${num(R, 2)} 千光年`]);
    }
    if (tier === 'localgroup' || tier === 'supercluster' || tier === 'universe') {
      const mly = Number.isFinite(b.distMly) ? b.distMly : (Number.isFinite(b.distLy) ? b.distLy / 1e6 : null);
      if (Number.isFinite(mly)) {
        rows.push(['距离', mly >= 1000 ? `${num(mly / 1000, 2)} 十亿光年` : `${num(mly, mly < 10 ? 2 : 1)} 百万光年`]);
      }
    }
    if (Number.isFinite(b.redshift) && b.redshift !== 0) rows.push(['红移 z', num(b.redshift, 5)]);
    const ds = this.#distSourceText(b);
    if (ds) rows.push(['距离口径', ds]);
    if (Number.isFinite(b.ra) && Number.isFinite(b.dec)) {
      rows.push(['赤经赤纬', `${num(b.ra, 4)}° , ${num(b.dec, 4)}°`]);
    }
    if (T.coordName && tier !== 'solar') rows.push(['坐标系', T.coordName]);
    return rows;
  }

  /** 恒星物理 —— 出了太阳系，「这颗星是什么」该用光谱与光度讲，不是用轨道讲 */
  #starRows(b) {
    const m = massOf(b);
    return [
      ['光谱型', b.spect || b.spectralType || null],
      ['有效温度', Number.isFinite(b.teff) ? `${num(b.teff, 0)} K` : (b.tempK ? temp(b.tempK) : null)],
      ['色指数 B−V', Number.isFinite(b.ci) ? num(b.ci, 3) : null],
      ['视星等', Number.isFinite(b.mag) ? num(b.mag, 2) : (b.magV != null ? num(b.magV, 2) : null)],
      ['绝对星等', Number.isFinite(b.absmag) ? num(b.absmag, 2) : (b.absoluteMag != null ? num(b.absoluteMag, 2) : null)],
      /* 光度：HYG 的 `lum` 列是**可见光波段**的太阳相对光度。
       * 不写「光度（太阳=1）」而写清波段 —— 否则会被当成热光度用，差一个量级。 */
      ['光度（可见光）', Number.isFinite(b.lum) ? `${sci(b.lum)} × 太阳` : (b.luminosity ? `${sci(b.luminosity)} W` : null)],
      ['质量', m ? `${sci(m.solar)} 太阳质量` : null],
      ['半径', Number.isFinite(b.radiusSolar) ? `${sci(b.radiusSolar)} 太阳半径` : null],
      ['质量出处', m ? m.source : null],
    ];
  }

  /** 系外行星 —— 只讲「行星参数 + 它绕谁」，不讲黄道面 */
  #exoPlanetRows(b) {
    const host = b.hostId ? this.app.dataset.get(b.hostId) : null;
    const m = massOf(b);
    return [
      ['宿主恒星', b.hostStar || host?.name || null],
      ['半长轴', Number.isFinite(b.semiMajorAu) ? `${num(b.semiMajorAu, 5)} AU` : null],
      ['公转周期', Number.isFinite(b.periodDays) ? period(Math.abs(b.periodDays)) : null],
      ['质量', m ? `${num(m.earth, m.earth < 0.1 ? 3 : 2)} 地球质量` : null],
      ['半径', Number.isFinite(b.radiusEarth) ? `${num(b.radiusEarth, 3)} 地球半径` : null],
      ['平衡温度', Number.isFinite(b.eqTempK) ? `${num(b.eqTempK, 0)} K` : null],
      ['轨道离心率', Number.isFinite(b.ecc) ? num(b.ecc, 4) : null],
      ['发现方法', b.method || null],
      ['发现年份', Number.isFinite(b.year) ? String(b.year) : null],
    ];
  }

  /** 星系 / 星云 / 星团 / 超新星遗迹 —— 讲类型学，不讲轨道 */
  #deepSkyRows(b) {
    const arcmin = (v) => (Number.isFinite(v) ? `${num(v, 2)}′` : null);
    const size = Number.isFinite(b.majorArcmin) && Number.isFinite(b.minorArcmin)
      ? `${num(b.majorArcmin, 2)}′ × ${num(b.minorArcmin, 2)}′`
      : (arcmin(b.majorArcmin) || null);
    return [
      ['形态分类', b.hubble || b.typeRaw || null],
      ['视星等', Number.isFinite(b.mag) ? num(b.mag, 2) : (b.magV != null ? num(b.magV, 2) : null)],
      ['视角尺寸', size],
      ['所在星座', b.constellation || null],
      ['梅西耶编号', b.messier != null ? `M${b.messier}` : null],
      ['光谱型', b.spType || b.spect || null],
      ['视差', Number.isFinite(b.plxMas) ? `${num(b.plxMas, 3)} mas` : null],
      ['质量', (() => { const m = massOf(b); return m ? `${sci(m.solar)} 太阳质量` : null; })()],
    ];
  }

  /** 太阳系天体的**轨道要素** —— 只在 solar 层显示 */
  #orbitRows(b) {
    const o = b.orbit;
    if (b.type === 'probe') return [];
    return [
      ['半长轴', o?.a != null ? `${num(o.a, 5)} AU` : (b.aKm ? `${num(b.aKm, 0)} km` : null)],
      ['偏心率', o?.e != null ? num(o.e, 5) : b.e != null ? num(b.e, 5) : null],
      ['轨道倾角', o?.i != null ? `${num(o.i, 4)}°` : b.incline != null ? `${num(b.incline, 3)}°` : null],
      ['升交点黄经', o?.longNode != null ? `${num(o.longNode, 4)}°` : b.node != null ? `${num(b.node, 3)}°` : null],
      ['近日点黄经', o?.longPeri != null ? `${num(o.longPeri, 4)}°` : null],
      ['近日点距离', o?.a != null && o?.e != null ? `${num(o.a * (1 - o.e), 4)} AU` : null],
      ['远日点距离', o?.a != null && o?.e != null ? `${num(o.a * (1 + o.e), 4)} AU` : null],
      ['公转周期', b.periodDays ? `${period(Math.abs(b.periodDays))}${b.periodDays < 0 ? '（逆行）' : ''}` : null],
      ['平均轨道速度', b.id === 'sun' ? null : this.#meanSpeed(b)],
    ];
  }

  /** 太阳系天体的**物理参数** */
  #solarPhysRows(b) {
    const m = massOf(b);
    const earths = m ? m.kg / EARTH_MASS_KG : null;
    return [
      ['赤道半径', b.radiusKm ? `${num(b.radiusKm, b.radiusKm < 10 ? 3 : 1)} km` : null],
      ['直径', b.radiusKm ? `${num(b.radiusKm * 2, b.radiusKm < 10 ? 3 : 0)} km` : null],
      ['质量', m ? `${sci(m.kg)} kg` : null],
      ['地球质量比', Number.isFinite(earths) ? `${num(earths, earths < 1 ? 4 : 2)} M⊕` : null],
      ['太阳质量比', m ? `${sci(m.solar)} M☉` : null],
      ['平均密度', b.densityGcm3 ? `${num(b.densityGcm3, 3)} g/cm³` : null],
      ['表面重力', b.gravity != null ? `${num(b.gravity, 3)} m/s²` : null],
      ['逃逸速度', b.escapeKms != null ? `${num(b.escapeKms, 3)} km/s` : null],
      ['自转周期', b.rotationHours != null ? `${Math.abs(b.rotationHours) > 48 ? num(b.rotationHours / 24, 2) + ' 天' : num(b.rotationHours, 3) + ' 小时'}${b.rotationHours < 0 ? '（逆行）' : ''}` : null],
      ['轴倾角', b.axialTilt != null ? `${num(b.axialTilt, 2)}°` : null],
      ['几何反照率', b.albedo != null ? num(b.albedo, 3) : null],
      ['视星等', b.magV != null ? num(b.magV, 2) : null],
      ['绝对星等', b.absoluteMag != null ? num(b.absoluteMag, 2) : null],
      ['光谱型', b.spectralType || null],
      ['光度', b.luminosity ? `${sci(b.luminosity)} W` : null],
    ];
  }

  #render(b) {
    const color = b.color || Dataset.typeColor(b.type);
    const tier = tierOf(b);
    const T = TIER_ATTR[tier] || TIER_ATTR.solar;
    const isSolar = tier === 'solar';
    const isStar = b.type === 'star';
    const isExo = b.type === 'exoplanet';
    const isDeep = ['galaxy', 'globular', 'opencluster', 'planetarynebula', 'nebula', 'snr', 'unclassified', 'nova'].includes(b.type);
    const isCompact = ['bh', 'blackhole', 'psr', 'wd', 'whitedwarf'].includes(b.type);

    const title = `<div class="obj-title">
      <span style="width:12px;height:12px;border-radius:50%;margin-top:7px;flex:none;background:${esc(color)};box-shadow:0 0 12px ${esc(color)}"></span>
      <div><h2>${esc(b.name)}</h2>${b.en ? `<span class="en">${esc(b.en)}</span>` : ''}</div>
    </div>`;

    const badges = [`<span class="badge">${esc(b.typeLabel || b.type)}</span>`];
    /* 尺度徽标：属性是**按尺度换套**的，界面上就要说清现在用的是哪一套 ——
     * 否则用户只会觉得「这个天体的属性怎么怪怪的」。 */
    if (T.label) badges.push(`<span class="badge dim">${esc(T.label)}尺度</span>`);
    if (b.parent) {
      const p = this.app.dataset.get(b.parent);
      badges.push(`<span class="badge dim">环绕：${esc(p ? p.name : b.parent)}</span>`);
    }
    if (b.hidden) badges.push(`<span class="badge warm">体积过小 · 放大后可见</span>`);
    if (b.departed) badges.push(`<span class="badge warm">已离开太阳系</span>`);
    if (b.type === 'probe' && b.status) badges.push(`<span class="badge violet">${esc(b.status)}</span>`);
    if (b.moons) badges.push(`<span class="badge violet">${b.moons} 颗卫星</span>`);
    if (b.ring) badges.push(`<span class="badge dim">有环系</span>`);
    if (b.noDistance) badges.push(`<span class="badge dim">距离未测定</span>`);

    const section = (t, body) => (body ? `<div class="section"><h3>${t}</h3>${body}</div>` : '');
    const kv = (pairs) => {
      const rows = (pairs || []).filter(([, v]) => v != null && v !== '—' && v !== '');
      if (!rows.length) return '';
      return `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
    };

    /* ---- 区块选区：**按尺度换一套** ----
     * 「有没有轨道要素」这件事的问法不是「它是不是太阳系天体」，
     * 而是「这一层里黄道面相关的量有没有意义」—— 那个口径在 attrs.js 里，
     * 这里**问它**，不自己判。 */
    let orbitRows = '';
    let attrTitle = '物理参数';
    let attrBody = '';
    if (showsEcliptic(tier)) {
      orbitRows = this.#orbitRows(b);
      attrBody = this.#solarPhysRows(b);
    } else {
      // 出了太阳系：不讲轨道，按**天体类别**讲属性
      attrTitle = isStar ? '恒星物理' : isExo ? '行星参数' : isDeep ? '天体属性' : isCompact ? '致密天体' : '物理参数';
      attrBody = isStar ? this.#starRows(b)
        : isExo ? this.#exoPlanetRows(b)
          : isDeep ? this.#deepSkyRows(b)
            : isCompact ? this.#deepSkyRows(b)
              : this.#solarPhysRows(b);
    }
    const posRows = isSolar ? '' : this.#positionRows(b, tier);

    const envRows = kv([
      ['平均温度', b.tempK ? temp(b.tempK) : null],
      ['温度范围', b.tempMinK != null && b.tempMaxK != null ? `${num(b.tempMinK, 0)} – ${num(b.tempMaxK, 0)} K` : null],
      ['核心温度', b.coreTempK ? `${sci(b.coreTempK)} K` : null],
      ['日冕温度', b.coronaTempK ? `${sci(b.coronaTempK)} K` : null],
      ['大气', b.atmosphere || null],
      ['年龄', b.age || null],
      ['金属丰度', b.metallicity || null],
    ]);

    /* ---- 太阳专属：活动 / 演化 ---- */
    const sunRows = b.id === 'sun' ? kv([
      ['质量占比', b.massFraction || null],
      ['体积', b.volumeEarths || null],
      ['表面积', b.surfaceAreaKm2 ? `${sci(b.surfaceAreaKm2)} km²` : null],
      ['自转周期（赤道）', b.rotationEquatorDays ? `${num(b.rotationEquatorDays, 2)} 天` : null],
      ['自转周期（极区）', b.rotationPoleDays ? `${num(b.rotationPoleDays, 1)} 天` : null],
      ['磁场', b.magneticField || null],
      ['太阳风速度', b.solarWindSpeed || null],
      ['活动周期', b.solarCycle || null],
      ['聚变速率', b.fusionRate || null],
      ['质量损失', b.massLossRate || null],
      ['光子旅程', b.photonTravelTime || null],
      ['能量密度', b.energyDensity || null],
      ['距银心', b.galacticDistanceLy ? `${num(b.galacticDistanceLy, 0)} 光年` : null],
      ['绕银心周期', b.galacticOrbitYears || null],
      ['绕银心速度', b.galacticSpeedKms ? `${num(b.galacticSpeedKms, 0)} km/s` : null],
      ['演化归宿', b.future || null],
    ]) : '';

    const structure = b.structure?.length
      ? `<ul class="facts">${b.structure.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : '';

    const comp = b.composition?.length
      ? `<ul class="facts">${b.composition.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : '';

    const ringInfo = b.ring
      ? `<p class="obj-desc" style="font-size:12.5px">环系：${num(b.ring.innerKm, 0)} – ${num(b.ring.outerKm, 0)} km。<br>${esc(b.ring.note || '')}</p>` : '';

    const regionInfo = b.type === 'region'
      ? kv([['范围', b.innerAu != null ? `${num(b.innerAu, 0)} – ${num(b.outerAu, 0)} AU` : null],
        ['已知成员', b.memberCount || null], ['总质量', b.totalMass || null]]) : '';

    const probeInfo = b.type === 'probe'
      ? kv([
        ['任务状态', b.status || null],
        ['运行机构', b.agency || null],
        ['发射日期', b.launch || null],
        ['位置类型', MODE_LABEL[b.mode] || null],
        ['目标天体', b.host ? (this.app.dataset.get(b.host)?.name || b.host) : '（日心轨道）'],
        ['着陆点', b.landing ? `${num(b.landing.lat, 2)}°, ${num(b.landing.lon, 2)}° · ${b.landing.date}` : null],
        ['环绕轨道半长轴', b.orbitKm?.aKm ? `${num(b.orbitKm.aKm, 0)} km` : null],
        ['环绕周期', b.orbitKm?.periodDays ? `${num(b.orbitKm.periodDays, 2)} 天` : null],
        ['日心距离', b.helio ? `${num(b.helio.au, 1)} AU` : null],
      ]) : '';

    const disc = b.discovery
      ? kv([['发现', b.discovery.year ? `${b.discovery.year}${b.discovery.by && b.discovery.by !== '—' ? ' · ' + b.discovery.by : ''}` : null],
        ['发现方式', b.discovery.method || null]]) : '';

    const missions = b.exploration?.length
      ? `<ul class="facts">${b.exploration.map((m) => `<li><b>${esc(m.name)}</b>（${esc(m.agency)}，${esc(String(m.year))}）— ${esc(m.note || '')}</li>`).join('')}</ul>`
      : '';

    const facts = b.facts?.length
      ? `<ul class="facts">${b.facts.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : '';

    /* 科学载荷（2026-10-11）：探测器携带的真实仪器清单（数据在 data/probes.js）。
     * 构型中文名来自 spacecraft.js 的 PRESET_LABEL——那边的面板不 import 渲染模块，
     * 这里按预设键回显同一份口径的中文标签。 */
    const MODEL_LABEL = {
      voyager: '桁架 + 大碟 + RTG（星际巡行）', newhorizons: '大碟 + RTG（冥王星级）',
      magellan: '大碟雷达测绘', boomed: '悬杆 + 大碟 + 侧挂探针', parker: '碳遮热罩（触摸太阳）',
      shieldwing: '遮热罩 + 太阳翼', observatory: '观测平台 + 双翼', orbiter: '经典轨道器（双翼 + 碟）',
      bigwings: '巨型太阳翼（外太阳系）', fans: '圆形翼扇（特洛伊巡行）', crosswings: '十字四翼',
      ion: '离子推进（电推深空）', sampler: '采样返回（喇叭机构）', impactor: '撞击器（行星防御）',
      juno: '六棱柱 + 三巨翼（木星极轨）', rover: '六轮巡视器', rover8: '八轮月面巡视车',
      lander: '四腿着陆平台', lander3: '三腿小型着陆器', sphere: '球形弹道舱', apollo: '阿波罗登月舱',
    };
    const instruments = b.instruments?.length
      ? `<ul class="facts">${b.instruments.map((i) =>
        `<li><b>${esc(i.zh)}</b>${i.en ? `（${esc(i.en)}）` : ''}${i.note ? ` — ${esc(i.note)}` : ''}</li>`).join('')}</ul>`
      : '';
    const modelRow = b.type === 'probe'
      ? kv([['本体构型（3D 建模口径）', MODEL_LABEL[b.model] || b.model || null]]) : '';

    const gallery = b.gallery?.length
      ? `<div class="gallery">${b.gallery.map((g) => {
        const k = g.kind || 'photo';
        return `<a href="./images/${esc(g.file)}" target="_blank" rel="noopener" title="${esc(g.title)}${g.date ? ' · ' + esc(g.date) : ''}${g.credit ? ' · ' + esc(g.credit) : ''}">
          <img src="./images/${esc(g.file)}" alt="${esc(g.title)}" loading="lazy">
          <span><i class="k ${k}">${KIND_LABEL[k] || '原始影像'}</i>${esc(g.title)}</span></a>`;
      }).join('')}</div>
      <div class="note" style="margin-top:7px;font-size:11px;line-height:1.5">
        <b>原始影像</b>＝探测器或望远镜直接拍摄；
        <b>后处理增强</b>＝多帧叠加、轨道跟踪或去噪后得到的更清晰版本；
        <b>科学模拟/艺术家重建</b>＝没有直接影像时，科学家根据掩星、光谱与组成元素推测的表面样貌。
      </div>`
      : '';

    /* ---- 3D 建模与影像来源 ---- */
    const tm = b.textureMeta;
    const texFile = b.texture || null;
    const modelRows = kv([
      ['建模贴图来源', texFile ? (tm?.source || '本地贴图')
        : (b.gallery?.length ? '程序化生成（无全球表面图，参考下方影像）' : '程序化生成（暂无真实影像）')],
      ['贴图分辨率', tm ? `${tm.width} × ${tm.height}` : null],
      ['原始影像', tm?.imaging || null],
      ['授权', tm?.license || null],
      ['法线贴图', tm?.normal ? '已生成（真实光照起伏）' : null],
    ]);
    const texThumb = texFile
      ? `<div class="gallery" style="grid-template-columns:1fr">
          <a href="./textures/${esc(texFile)}" target="_blank" rel="noopener" title="点击查看完整贴图">
            <img src="./textures/${esc(texFile)}" alt="${esc(b.name)} 建模贴图" loading="lazy">
            <span>3D 建模所用贴图：${esc(texFile)}</span>
          </a></div>`
      : '';
    const noImage = (!texFile && !b.gallery?.length)
      ? '<p class="obj-desc" style="opacity:.75">暂无图片：该天体尚无公开的真实影像，三维模型由程序化贴图生成。</p>'
      : '';
    const modelBlock = modelRows + texThumb + noImage + gallery;

    /* 底部说明**必须随尺度换**：在银河系层说「位置由 VSOP87 实时计算」是错的，
     * 那条链只管太阳系里的天体。 */
    const footNote = isSolar
      ? '位置由 astronomy-engine（VSOP87 行星理论 / ELP2000 月球理论 / 木卫专用模型）实时计算，与 JPL 星历偏差约 1 角分。'
      : `位置属${esc(T.label)}尺度，坐标系为${esc(T.coordName)}；轨道六根数只在太阳系层有意义，因此这里不显示。`;

    return `${title}
      <div style="margin:6px 0 10px;display:flex;flex-wrap:wrap;gap:6px">${badges.join('')}</div>
      ${b.desc ? `<p class="obj-desc">${esc(b.desc)}</p>` : ''}

      ${isSolar ? '<div class="section"><h3>实时状态</h3><div id="live-block"></div></div>' : ''}

      ${section('位置与距离', kv(posRows))}
      ${section('轨道要素', orbitRows)}
      ${section(attrTitle, attrBody)}
      ${section('太阳活动与演化', sunRows)}
      ${section('内部结构', structure)}
      ${section('环境与组成', envRows + comp + ringInfo + regionInfo + probeInfo)}
      ${section('本体构型', modelRow)}
      ${section('科学载荷', instruments)}
      ${section('发现与探测', disc + missions)}
      ${section('3D 建模与影像来源', modelBlock)}
      ${section('要点', facts)}

      <div class="btn-row">
        <button class="primary" data-act="research">查看最新研究进展</button>
        <button class="ghost" data-act="focus">聚焦并跟随</button>
        ${b.parent ? '<button class="ghost" data-act="parent">回到母天体</button>' : ''}
      </div>
      <div class="note">${footNote}</div>`;
  }

  #meanSpeed(b) {
    const a = b.orbit?.a;
    if (!a) return null;
    const T = b.periodDays ? Math.abs(b.periodDays) * 86400 : 0;
    if (!T) return null;
    return `${num((2 * Math.PI * a * AU_KM) / T, 2)} km/s`;
  }

  #bind(b) {
    const body = this.app.ui.panel.bodyEl;
    body.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        if (act === 'research') {
          this.app.ui.research.open(b.researchQuery || `${b.en || b.name} astronomy`, b.name);
        } else if (act === 'focus') {
          this.app.engine.current?.focusById?.(b.id);
        } else if (act === 'parent') {
          const p = this.app.dataset.get(b.parent);
          if (p) this.app.gotoDestination(p.id);
        }
      });
    });
  }
}

/**
 * 「显示全部」每次补多少行。
 *
 * 这个数字是**给弱机留的余量**，不是审美：编目星系一组 9,800 条，
 * 一次铺完 = 十几万个 DOM 节点，这台机器（13.7 GB 内存、常态只剩 1~2 GB）会卡死标签页。
 * 800 行约 1 万个节点，点一次能明显前进、又不会让主线程卡顿。
 */
const CAT_MORE_CHUNK = 800;

/**
 * 「显示全部」在**节点式分组**（子节点本身是分组，例如「系外行星系统」按宿主分组）
 * 上一次补多少个**子分组**。
 *
 * 比 800 小得多：一个系外行星系统展开后是一个标题 + 1~3 颗行星，
 * 一次补 260 个系统 ≈ 300~400 个节点，点一次能明显前进，又不会卡。
 */
const CAT_MORE_SYS = 260;

export class Catalog {
  constructor(app) {
    this.app = app;
    /* 默认展开的分组。`nearby-stars` 是「恒星」这一支 ——
     * 不默认展开它，「有行星的恒星」就藏在两层折叠后面，
     * 而怪怪的反馈正是「展开恒星看不到行星」。 */
    this.openGroups = new Set(['grp-planets', 'grp-dwarfs', 'grp-belt', 'nearby-stars']);
    this.scrollTop = 0;
    this.pane = document.getElementById('catalog-pane');
    this.bodyEl = document.getElementById('catalog-body');
    document.getElementById('catalog-close').addEventListener('click', () => this.hide());
  }

  get isOpen() { return !this.pane.hidden; }

  toggle() { if (this.isOpen) this.hide(); else this.show(); }

  hide() {
    this.scrollTop = this.bodyEl.scrollTop;
    this.pane.hidden = true;
    document.body.classList.remove('catalog-open');
  }

  /** 打开左侧常驻目录：内容只渲染一次，之后只更新高亮，不随导航消失 */
  show() {
    if (!this.bodyEl.childElementCount) this.#render();
    this.syncScale(this.app.engine?.current?.id);
    this.pane.hidden = false;
    document.body.classList.add('catalog-open');
    this.bodyEl.scrollTop = this.scrollTop;
  }

  /** 高亮当前选中的天体（并把它的父级分组自动展开） */
  setActive(id) {
    if (!this.bodyEl) return;
    this.bodyEl.querySelectorAll('.cat-row.active').forEach((el) => el.classList.remove('active'));
    // 先按 DOM 找；找不到说明它还在某个分组「显示全部」的后面 —— 按需把它拉出来
    const row = this.bodyEl.querySelector(`.cat-row[data-id="${id}"]`) || this.#revealRow(id);
    if (!row) return;
    row.classList.add('active');
    let p = row.parentElement;
    while (p && p !== this.bodyEl) {
      if (p.classList.contains('cat-group')) {
        p.classList.add('open');
        this.openGroups.add(p.dataset.gid);
      }
      p = p.parentElement;
    }
    if (this.isOpen) {
      const r = row.getBoundingClientRect();
      const b = this.bodyEl.getBoundingClientRect();
      if (r.top < b.top + 8 || r.bottom > b.bottom - 8) row.scrollIntoView({ block: 'center' });
    }
  }

  /**
   * 按尺度层级分节渲染。
   *
   * 节序**从大到小**（可观测宇宙 → 太阳系）：包含关系是「外层包住内层」，
   * 把最大的放最上面、逐级往里收，读起来才是嵌套；从小到大排反而是并列感。
   * 顺序直接读 SCALE_CHAIN（唯一定义来源），不在这里另写一套。
   *
   * 分组归属读的是 `n.tier` —— 由 dataset.js 在**建树时**打上（和树同源），
   * 所以这里没有第二张需要手工同步的映射表。
   */
  #renderTiered(tree) {
    const order = [...SCALE_CHAIN].sort((a, b) => b.order - a.order);
    const buckets = new Map(order.map((s) => [s.id, []]));
    const other = [];
    for (const n of tree) {
      if (n.tier && buckets.has(n.tier)) buckets.get(n.tier).push(n);
      else other.push(n);
    }

    let html = '';
    for (const s of order) {
      const list = buckets.get(s.id);
      if (!list.length) continue;
      const leaves = list.reduce((a, n) => a + this.#countLeaves(n), 0);
      html += `<div class="cat-scale" data-scale="${esc(s.id)}">
        <div class="scale-head" data-scale="${esc(s.id)}" title="跳到「${esc(s.name)}」">
          <span class="scale-name">${esc(s.name)}</span>
          <span class="scale-unit">${esc(s.unit)}</span>
          <span class="scale-cnt">${leaves}</span>
        </div>
        <div class="scale-sub">${esc(s.subtitle)}</div>
        <div class="scale-body">${this.#renderNodes(list)}</div>
      </div>`;
    }
    if (other.length) {
      // 理论上不该出现：出现即 dataset.catalogUntiered 非空（TIER_OF 漏了分组）
      html += `<div class="cat-scale" data-scale="">
        <div class="scale-head" title="未归入任何尺度——dataset.js 的 TIER_OF 漏了分组">
          <span class="scale-name">未归入尺度</span>
          <span class="scale-cnt">${other.reduce((a, n) => a + this.#countLeaves(n), 0)}</span>
        </div>
        <div class="scale-body">${this.#renderNodes(other)}</div>
      </div>`;
    }
    return html;
  }

  /** 高亮「我现在在哪一层」——只改 class，不重建 DOM，避免打断滚动位置 */
  syncScale(levelId) {
    if (!this.bodyEl) return;
    this.bodyEl.querySelectorAll('.cat-scale').forEach((el) => {
      el.classList.toggle('active', el.dataset.scale === levelId);
    });
  }

  #render() {
    const ds = this.app.dataset;
    const tree = ds.catalog || [];
    const all = ds.catalogBodies();
    const uniq = new Set(all.map((b) => b.id));
    const probeCount = all.filter((b) => b.type === 'probe').length;

    this.bodyEl.innerHTML = `<div class="note">按<b>尺度</b>分层：从最大的「可观测宇宙」
      一路收到最小的「太阳系」，外层尺度**包含**内层——下面的六个尺度标题就是它们的嵌套关系。
      每个尺度内再按「行星 → 卫星 · 环系 · 探测器」组织，
      小行星带收录带内天体，彗星与星际天体单独成组。
      共 <b style="color:#67e8f9">${uniq.size}</b> 个天体与结构，
      <b style="color:#ff9a5c">${probeCount}</b> 个探测器按当前位置或着陆天体归位。
      点尺度标题可跳到该尺度，点天体名称进入天体，点三角展开子目录。</div>` + this.#renderTiered(tree);

    this.bodyEl.addEventListener('scroll', () => { this.scrollTop = this.bodyEl.scrollTop; });

    // 点尺度标题 = 切到该尺度（省去再去顶栏找一遍）
    this.bodyEl.querySelectorAll('.scale-head').forEach((h) => {
      h.addEventListener('click', () => {
        const sid = h.dataset.scale;
        if (sid) this.app.gotoScale?.(sid);
      });
    });
    /* 目录内的点击**一律走委托**，挂在容器上，只绑一次。
     *
     * ⚠️ 原来分组标题和行是逐个 `addEventListener` 绑的，只有「显示全部」是委托。
     *   这个混搭在「显示全部」只能追加**行**时勉强能用（补一个行监听就行），
     *   但一旦按**系统**续加（追加进来的是「分组」而不是行），
     *   新分组的标题就没人生效 —— 表现是**点它展不开**，而且不报任何错。
     *   统一成委托之后，`#showMore` 追加什么节点都自动可用。
     */
    this.bodyEl.addEventListener('click', (ev) => {
      const el = ev.target;
      if (!el || !el.closest) return;
      const more = el.closest('.cat-more');
      if (more) { ev.preventDefault(); ev.stopPropagation(); this.#showMore(more); return; }
      const head = el.closest('.cat-head');
      if (head) {
        // 标题（有对应天体时）→ 直接选中该天体；其余区域 / 三角箭头 → 展开收起
        const ttl = el.closest('.ttl');
        if (ttl?.dataset.goto) { this.app.gotoDestination(ttl.dataset.goto); return; }
        const g = head.closest('.cat-group');
        if (!g) return;
        const gid = g.dataset.gid;
        g.classList.toggle('open');
        if (g.classList.contains('open')) this.openGroups.add(gid);
        else this.openGroups.delete(gid);
        return;
      }
      const row = el.closest('.cat-row');
      if (row?.dataset.id) this.app.gotoDestination(row.dataset.id);
    });
  }

  /** 目录节点索引（按 group id）——「显示全部」要拿到那个分组的全量 id 列表 */
  #ensureIndex() {
    if (!this._nodes) {
      this._nodes = new Map();
      const walk = (ns) => {
        for (const n of ns || []) {
          if (n.kind !== 'group') continue;
          this._nodes.set(n.id, n);
          walk(n.children);
        }
      };
      walk(this.app.dataset?.catalog || []);
    }
    return this._nodes;
  }

  #nodeOf(gid) { return this.#ensureIndex().get(gid); }

  /**
   * 把一个**还没渲染出来**的天体行拉出来（它可能在某个分组「显示全部」的后面）。
   *
   * 场景：搜索或跳转到一个暗弱天体（如 IC 1234），目录里那一组默认只列了 260 条，
   * 它在第 5,000 位 —— 不处理的话 `setActive` 找不到它就**直接返回**，
   * 表现是「搜到了、点进去，左边目录一动不动」，用户以为坏了。
   * 这里按需点击「显示全部」直到那一行出现（有上限，避免死循环）。
   */
  #revealRow(id) {
    for (const [gid, node] of this.#ensureIndex()) {
      if (!node.allIds || node.allIds.indexOf(id) < 0) continue;
      const groupEl = this.bodyEl.querySelector(`.cat-group[data-gid="${gid}"]`);
      if (!groupEl) return null;
      groupEl.classList.add('open');
      this.openGroups.add(gid);
      let guard = 0;
      while (guard++ < 40) {
        const row = this.bodyEl.querySelector(`.cat-row[data-id="${id}"]`);
        if (row) return row;
        const btn = groupEl.querySelector('.cat-more');
        if (!btn) return null;
        this.#showMore(btn);
      }
      return this.bodyEl.querySelector(`.cat-row[data-id="${id}"]`);
    }
    return null;
  }

  /**
   * 往已展开的分组里**续加**一批子节点。
   *
   * 两种模式（见函数内注释）：行式按 CAT_MORE_CHUNK 补行，节点式按 CAT_MORE_SYS 补子分组。
   *
   * ⚠️「已经渲染了多少」是**数 DOM**得到的，不是自己记的账。
   *   记账一旦和 DOM 失同步，表现就是「点了没反应」——最难查的一种静默故障。
   *   数 DOM 永远等于用户实际看到的东西。
   */
  #showMore(btn) {
    const wrap = btn.closest('.cat-more-wrap');
    const groupEl = btn.closest('.cat-group');
    const node = this.#nodeOf(btn.dataset.gid);
    if (!wrap || !groupEl || !node || !node.allIds) return;
    const box = groupEl.querySelector(':scope > .cat-children');
    if (!box) return;

    /* 两种分组，进度按不同的东西数：
     *   · 行式（`capped()` 造的）：子节点全是叶子 ⇒ 进度 = 直属 .cat-row 数。
     *   · 节点式（子节点本身是分组，如系外行星系统）⇒ 进度 = 直属 .cat-group 数。
     * 两种都**从 DOM 数**，不自己记账 —— 账本与 DOM 一旦失同步，
     * 表现就是「点了没反应」，最难查的一类静默故障。 */
    const byNode = Array.isArray(node.allNodes);
    const already = byNode
      ? box.querySelectorAll(':scope > .cat-group').length
      : box.querySelectorAll(':scope > .cat-row').length;
    const src = byNode ? node.allNodes : node.allIds;
    const step = byNode ? CAT_MORE_SYS : CAT_MORE_CHUNK;

    const holder = document.createElement('template');
    if (byNode) {
      // 节点式：直接把节点交给同一套渲染器，标题/说明/徽标一并长出来
      holder.innerHTML = this.#renderNodes(src.slice(already, already + step));
    } else {
      holder.innerHTML = src.slice(already, already + step)
        .map((id) => {
          const b = this.app.dataset?.get(id);
          return b ? this.#row({ kind: 'body', body: b }) : '';
        }).join('');
    }
    box.insertBefore(holder.content, wrap);

    /* 徽标与按钮上的数一律**现场数叶子**（.cat-row）。
     * 节点式分组里每个系统带的行星数不一样，所以「已列」不能按次数累加 ——
     * 累加出来的数字迟早和用户看到的东西对不上。 */
    const leaves = box.querySelectorAll('.cat-row').length;
    const total = node.total ?? leaves;
    const cntEl = groupEl.querySelector(':scope > .cat-head .cnt');
    if (cntEl) cntEl.textContent = `${leaves} / ${total}`;
    const left = Math.max(0, total - leaves);
    if (left > 0) btn.textContent = `继续显示（还有 ${left} 条）`;
    else wrap.remove();
  }

  open_legacy() { this.show(); }

  #countLeaves(n) {
    if (n.kind === 'body' || n.kind === 'ring') return 1;
    return (n.children || []).reduce((s, c) => s + this.#countLeaves(c), 0);
  }

  #renderNodes(nodes) {
    let html = '';
    for (const n of nodes) {
      if (n.kind === 'body' || n.kind === 'ring') { html += this.#row(n); continue; }
      const open = this.openGroups.has(n.id);
      const goto = n.body ? ` data-goto="${esc(n.body.id)}"` : '';
      const shownCount = this.#countLeaves(n);
      /**
       * 截断分组：徽标写「已列 / 全部」，并把它自己的说明贴出来。
       *
       * 只认 dataset 明确给出的 `n.total`，**不从标题字符串里反解数字** ——
       * 那种解析会随着文案一改就悄悄失效（标题从「· 598」变成「（598）」就全错）。
       * 从前这里只渲染「598」的标题 + 「260」的徽标而**不渲染 note**，
       * 看着像坏了，实测就是用户反馈「很多天体没做进去」的一半来源。
       */
      const truncated = n.total != null && n.hidden > 0;
      const cnt = truncated ? `${shownCount} / ${n.total}` : `${shownCount}`;
      const note = n.note ? `<div class="cat-note">${esc(n.note)}</div>` : '';
      /**
       * 「显示全部」按钮：**一次只加 CHUNK 条**。
       *
       * 为什么不一次铺完：编目星系一行 9,800 条，全铺 = 十几万个 DOM 节点，
       * 这台机器（13.7 GB 内存、常态只剩 1~2 GB）会直接卡住甚至崩标签页 ——
       * 而用户只是想翻到某一条，不是想看到 9,800 行同时存在于 DOM 里。
       * 分块 = 每次几百个节点，滚到哪加到哪；剩下的条数写在按钮上，不骗人。
       */
      const more = truncated && n.allIds
        ? `<div class="cat-more-wrap"><button class="cat-more" data-gid="${esc(n.id)}">显示全部（还有 ${n.hidden} 条）</button></div>`
        : '';
      html += `<div class="cat-group${open ? ' open' : ''}" data-gid="${esc(n.id)}">
        <div class="cat-head"><span class="caret">▶</span>
          <span class="ttl${n.body ? ' link' : ''}"${goto}>${esc(n.name)}</span>
          ${n.badge ? `<span class="tag">${esc(n.badge)}</span>` : ''}
          <span class="cnt${truncated ? ' capped' : ''}"${truncated ? ` title="默认只列一部分，点下面的「显示全部」接着翻"` : ''}>${cnt}</span>
        </div>
        ${note}
        <div class="cat-children">${this.#renderNodes(n.children || [])}${more}</div>
      </div>`;
    }
    return html;
  }

  #row(n) {
    const b = n.body;
    if (n.kind === 'ring') {
      return `<div class="cat-row" data-id="${esc(n.parent)}">
        <span class="dot" style="background:#e8dcc0;box-shadow:0 0 8px #e8dcc0"></span>
        <span class="nm">环系<i>Ring System</i></span>
        <span class="meta">${b.ring?.innerKm ? `${num(b.ring.innerKm, 0)}–${num(b.ring.outerKm, 0)} km` : ''}</span>
      </div>`;
    }
    const color = b.color || Dataset.typeColor(b.type);
    let meta = '';
    if (b.type === 'probe') meta = b.status || '';
    else if (b.hidden) meta = '体积过小 · 放大后可见';
    else if (b.radiusKm) meta = `直径 ${num(b.radiusKm * 2, b.radiusKm < 10 ? 2 : 0)} km`;
    else if (b.orbit?.a) meta = `${num(b.orbit.a, 3)} AU`;
    else if (b.distanceAu) meta = `${num(b.distanceAu, 1)} AU`;
    const tag = b.departed ? '<span class="tag">已离开太阳系</span>' : '';
    return `<div class="cat-row${b.hidden ? ' hidden-obj' : ''}" data-id="${esc(b.id)}">
      <span class="dot" style="background:${esc(color)};box-shadow:0 0 8px ${esc(color)}"></span>
      <span class="nm">${esc(b.name)}${b.en && b.en !== b.name ? `<i>${esc(b.en)}</i>` : ''}</span>
      ${tag}
      <span class="meta">${esc(meta)}</span>
    </div>`;
  }
}
