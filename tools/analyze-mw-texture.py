#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
量具（只读）· 把「银河系盘面贴图好不好看」拆成三个**可算的量**。

用法：
  py -3.13 -X utf8 tools/analyze-mw-texture.py shots/mw-texture-galaxy-mw-disk-glow.png
  py -3.13 -X utf8 tools/analyze-mw-texture.py --compare A.png B.png

为什么要有它
------------------------------------------------------------------
用户说「银河系这样子还是太差了」。这句话对应的是**目检**，而目检不能当判据
（也不能当验收）。这张贴图是 `AdditiveBlending` 下的**亮度贴图** ⇒
**α 通道就是亮度**，于是「好不好看」可以拆成三个能算的东西：

  ① `energy` —— 整幅 α 之和。**这是亮度预算**，任何重画都不许把它推高
     （第 33 轮那套亮度判据就挂在这条线上：整幅 RGB 均值不许越 ±5%）。
  ② `armMod` —— 各半径环带上 α 的**角向调制**：`p90/p50` 与 `p99/p50`。
     旋臂是「同一半径上有的方向亮、有的方向暗」⇒ 这个比值**就是臂的对比度**。
     比值 ≈ 1 ⇒ 那是**一圈均匀的雾**，没有臂（用户看到的就是这个）。
     真实盘面的臂/臂间光度比约 **2 倍**（NGC 6744）。
  ③ `ripple` —— 径向剖面的**波纹**：把平滑后的径向曲线上叠的振荡量出来。
     `createRadialGradient` 用 **14 个 stop** 去逼近 `exp(−6.2u)` 时，
     分段线性插值的误差在 u≈0 处高达 **12%** ⇒ 肉眼就是**一圈一圈的水波纹**。
     这个数直接量它。

三个量都是**从导出的 PNG 上算**的，不经过渲染、不依赖任何公式副本
（导出见 `tools/dump-mw-texture.py`）。
"""

import sys
import json
import argparse

import numpy as np
from PIL import Image

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# 贴图里盘面的半径 = size × 0.48（`makeMilkyWayDiskTexture` 的 `R = size * 0.48`）
R_FRAC = 0.48
RINGS = (0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75)


def radial_profile(path, stat=25, nbins=100):
    """盘面的**径向剖面**（沿半径把一个环带压成一个数）。返回 (profile, centers)。

    ⚠️ 默认取 **p25** 而不是 `mean`：臂是「同一半径上少数角度很亮」，
    它在均值上制造的起伏是**真结构**（臂的径向调制），不是缺陷。
    同心环的定义特征是**角向均匀** ⇒ 只有 p25 这类「基线统计量」才对它敏感。
    """
    im = Image.open(path).convert("RGBA")
    a = np.asarray(im).astype(np.float32)
    alpha = a[:, :, 3] / 255.0
    h, w = alpha.shape
    cy, cx = (h - 1) / 2.0, (w - 1) / 2.0
    rr = np.sqrt((np.mgrid[0:h, 0:w][0] - cy) ** 2 + (np.mgrid[0:h, 0:w][1] - cx) ** 2) / (h * R_FRAC)
    bins = np.linspace(0.0, 1.0, nbins + 1)
    out = []
    for i in range(nbins):
        m = (rr >= bins[i]) & (rr < bins[i + 1])
        out.append(float(np.percentile(alpha[m], stat)) if m.any() else 0.0)
    return np.array(out), (bins[:-1] + bins[1:]) / 2.0


def shape_diff(pa, pb):
    """两张同源贴图的**归一化径向形状差** —— 这是唯一能量出「同心环」的量。

    为什么它比直接看剖面稳：同一份代码只改 `STOPS` ⇒ 旋臂、颗粒、HII 区、
    随机种子全都没变 ⇒ 两者的差**只剩分段数造成的那部分**。
    ⚠️ 先各自归一化（除以自己的均值）再相减，否则会把「亮度调了多少」混进形状里。
    ⚠️ 判「周期」用 FFT 而不是数符号翻转：14 段折角的周期是 100/14 = **7.1 个 bin**，
    ⇒ 它在 100 点 FFT 上应该落在 **k = 14** 附近。符号翻转次数会被统计噪声污染
    （噪声的翻转比结构还频繁，第一版就栽在这：修完波纹后翻转次数反而从 23 涨到 25）。
    """
    ra = pa / max(1e-9, pa[pa > 0].mean())
    rb = pb / max(1e-9, pb[pb > 0].mean())
    d = rb - ra
    d = d - d.mean()
    power = np.abs(np.fft.rfft(d)) ** 2
    total = float(power[1:].sum())
    band = power[10:19]                     # k = 10..18（周期 5.3~10 个 bin）
    kpk = int(np.argmax(band)) + 10
    return {
        "nBins": len(d),
        "rms": round(float(np.sqrt((d ** 2).mean())), 6),
        "maxAbs": round(float(np.abs(d).max()), 6),
        "fftPeakK": kpk,
        "fftPeakPeriodBins": round(len(d) / kpk, 2),
        "fftBandShare": round(float(band.sum() / max(1e-12, total)), 3),
        "profile": [round(float(v), 5) for v in d],
    }


def analyze(path):
    im = Image.open(path).convert("RGBA")
    a = np.asarray(im).astype(np.float32)
    alpha = a[:, :, 3] / 255.0                      # additive 口径下 α 就是亮度
    h, w = alpha.shape
    cy, cx = (h - 1) / 2.0, (w - 1) / 2.0
    R = h * R_FRAC
    yy, xx = np.mgrid[0:h, 0:w]
    rr = np.sqrt((yy - cy) ** 2 + (xx - cx) ** 2) / R

    out = {
        "file": path,
        "size": [w, h],
        "energy": float(alpha.sum()),
        "meanInDisc": float(alpha[rr < 1].mean()),
        "discFrac": float((alpha[rr < 1] > 0).mean()),
    }

    # ② 臂的角向调制
    arm = {}
    for u in RINGS:
        m = (rr >= u - 0.012) & (rr < u + 0.012)
        v = alpha[m]
        if v.size == 0:
            continue
        p05, p50, p90, p99 = np.percentile(v, [5, 50, 90, 99])
        arm[f"{u:.2f}"] = {
            "p50": round(float(p50), 5),
            "p90_over_p50": round(float(p90 / p50), 3) if p50 > 1e-6 else None,
            "p99_over_p50": round(float(p99 / p50), 3) if p50 > 1e-6 else None,
            "dip": round(float((p50 - p05) / p50), 3) if p50 > 1e-6 else None,   # 尘埃挖出的暗带
        }
    out["armMod"] = arm

    # ③ 径向剖面的波纹：平滑曲线（窗口 9 = 0.09R）与原始曲线的差。
    #
    # ⚠️★ 这一条是**参考**，不是判据 —— 直接用剖面量同心环在本项目里**失败过两次**：
    #   用 `mean` 断面时臂主导（修完波纹 relRms 反而从 29.8% 涨到 30.3%）；
    #   换成 `p25` 断面后仍然只有 38.75% → 36.77%（噪声的翻转比结构还频繁：25 vs 23 次）。
    #   14 段折角的**绝对**幅度只有 ~0.005 α（而盘内平均 α 0.016），
    #   在 100 个 bin 的统计噪声下**量不出来** —— 但人眼看得见，
    #   因为它是一条**跨 360° 连贯**的弧，而噪声不是。
    #   ⇒ 真正能判的是 `--shape-diff`（两张图的归一化形状差 + FFT 周期峰），
    #     以及**目检导出的原图**。剖面数字只留作参考。
    prof, _ = radial_profile(path, stat=25)
    prof_med, _ = radial_profile(path, stat=50)

    def ripple_of(curve):
        win = 9
        pad = win // 2
        sm = np.convolve(np.pad(curve, pad, mode="edge"), np.ones(win) / win, mode="valid")
        r = curve - sm
        sign = np.sign(r)
        sign = sign[sign != 0]
        return {
            "rms": round(float(np.sqrt((r ** 2).mean())), 6),
            "max": round(float(np.abs(r).max()), 6),
            "relRms": round(float(np.sqrt((r ** 2).mean()) / max(1e-9, curve.mean())), 4),
            "signFlips": int(np.sum(np.diff(sign) != 0)),
        }

    out["ripple"] = ripple_of(prof)                    # ← p25 断面（参考）
    out["rippleMedianRef"] = ripple_of(prof_med)        # ← median 断面（参考，同样会被臂主导）
    return out


def show(r):
    print(f"\n=== {r['file']} ===")
    print(f"  贴图 {r['size'][0]}×{r['size'][1]} · 盘内平均 α {r['meanInDisc']:.5f}"
          f" · 整幅能量 Σα {r['energy']:.0f} · 盘内有值的像素占比 {r['discFrac'] * 100:.1f}%")
    print(f"  波纹 ripple（p25 断面）：RMS {r['ripple']['rms']:.6f}"
          f"（相对 {r['ripple']['relRms'] * 100:.2f}%）"
          f" · 峰值 {r['ripple']['max']:.6f} · 符号翻转 {r['ripple']['signFlips']} 次")
    mr = r.get("rippleMedianRef")
    if mr:
        print(f"    （参考·median 断面：相对 {mr['relRms'] * 100:.2f}% · 翻转 {mr['signFlips']} 次"
              f" —— 会被旋臂主导，**不作判据**）")
    print("  臂的角向调制（p90/p50 · p99/p50 · 尘埃暗带 dip）")
    for u, v in r["armMod"].items():
        print(f"    r = {u} R   p50 {v['p50']:.5f} · p90/p50 {v['p90_over_p50']}"
              f" · p99/p50 {v['p99_over_p50']} · dip {v['dip']}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--compare", action="store_true", help="两张图对照（第二张 vs 第一张）")
    ap.add_argument("--shape-diff", action="store_true",
                    help="量两张**同源**贴图的归一化径向形状差（这是唯一能量出同心环的量）")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    rs = [analyze(f) for f in args.files]
    if args.json:
        print(json.dumps(rs, ensure_ascii=False, indent=2))
        return
    for r in rs:
        show(r)

    if args.shape_diff and len(rs) == 2:
        pa, _ = radial_profile(args.files[0], stat=25)
        pb, _ = radial_profile(args.files[1], stat=25)
        sd = shape_diff(pa, pb)
        print("\n=== 归一化径向形状差（B − A，同源同参数分别只改 STOPS）===")
        print(f"  RMS {sd['rms']} · 峰值 {sd['maxAbs']}（都是「除以自身均值」之后的无量纲差）")
        print(f"  FFT 峰值 k={sd['fftPeakK']}（周期 {sd['fftPeakPeriodBins']} 个 bin）"
              f" · 该频带占总功率 {sd['fftBandShare'] * 100:.1f}%")
        print(f"  ⚠️ 判读：14 段折角的周期是 100/14 = **7.1 bin ⇒ k=14**。"
              f"若形状差的能量集中在 k≈14 ⇒ 那正是分段的折角；"
              f"修平滑之后这一项应大幅跌落，而其余频段（臂/颗粒）不受影响。")

    if args.compare and len(rs) == 2:
        a, b = rs
        print("\n=== 对照（B vs A）===")
        print(f"  能量 Σα        {a['energy']:.0f} → {b['energy']:.0f}"
              f"  ({b['energy'] / max(1e-9, a['energy']) * 100 - 100:+.1f}%)"
              f"  ← 亮度预算，重画不许把它推高（±5% 线）")
        print(f"  波纹 relRms    {a['ripple']['relRms'] * 100:.2f}% → {b['ripple']['relRms'] * 100:.2f}%"
              f"  （越小越好；14 个 stop 的折角在 1% 量级，256 个应在 0.1% 以下）")
        for u in RINGS:
            ka = a["armMod"].get(f"{u:.2f}")
            kb = b["armMod"].get(f"{u:.2f}")
            if ka and kb:
                print(f"  r={u} R  臂对比 p90/p50  {ka['p90_over_p50']} → {kb['p90_over_p50']}"
                      f"  · 尘埃 dip {ka['dip']} → {kb['dip']}")


if __name__ == "__main__":
    main()
