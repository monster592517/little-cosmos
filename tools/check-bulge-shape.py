# -*- coding: utf-8 -*-
"""核球外轮廓判据：**是圆还是方**（不靠眼睛）。

## 为什么要有这个脚本

第 23 轮把「中央过曝」判成了**形状问题**（`makeGlowTexture` 的 mipmap 退化 ⇒
每个 3px 的点渲染成小方片 ⇒ 三万块叠成一个方斑），并在 `textures.js` 里写下判据：

    「`ablate-*-mw-bulge.png` 里核球的外轮廓必须是圆的。」

但「圆」是个形容词，不是判据。**形容词会被自己的期待读出来。**
所以这里把「圆」翻成两个可以算的数：

### 判据 A —— 对角/轴向 比（>0.15 就有方向性）
从**质心**沿各个角度往外走，量「亮度跌到峰值的 e^-1 处的半径」R(θ)。
  · 正圆盘：R(θ) 与 θ 无关 ⇒ `max/min ≈ 1.00`
  · 正方形：对角方向要多走 √2 倍 ⇒ `R(45°)/R(0°) ≈ 1.414`
⇒ 输出 `R(45°)/R(0°)` 与 `R(90°)/R(0°)`，再给出 36 个角度的 R 的变异系数。

### 判据 B —— 等亮度线的「方度」（`squareness`）
对同一张图取一条等亮度闭合轮廓，量它的**面积**与**外接方框面积**之比：
  · 内切于方框的圆：π/4 = **0.7854**
  · 就是那个方框：**1.0000**
⇒ `squareness = 面积 / (w·h)`。圆 → 0.785，方 → 1.0。

两个判据都要看：A 抓「有没有方向性」，B 抓「填满了多少框」。
**只报一个数会被另一种病骗过去**（比如一个四角被磨圆的方斑，B 只有 0.9 但 A 仍是 1.35）。

## 用法

    python -X utf8 tools/check-bulge-shape.py [图片...]
    不给参数就扫 shots/ 下所有 `ablate-*-mw-bulge.png`（按时间排序）。

**量具先自证**：脚本会先生成一张合成圆盘和一张合成方斑（同尺寸、同亮度分布），
跑同一套判据，把两者的读数打出来。**合成圆读不出「圆」、合成方读不出「方」⇒ 判据作废。**
"""
import sys, os, glob, math
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, 'shots')

# 亮度阈值：核球边缘是软的，取「整幅最大亮度的 4%」当归一化阈值，
# 这样换曝光/换增益都还读得出同一条等亮度线。
REL_TH = 0.04


def load_gray(path):
    im = Image.open(path).convert('RGB')
    a = np.asarray(im).astype(np.float64)
    # 亮度用 Rec.709 口径，与探针里的一致，免得两处口径打架
    return 0.2126 * a[:, :, 0] + 0.7152 * a[:, :, 1] + 0.0722 * a[:, :, 2]


def centroid(g, th):
    m = g > th
    n = m.sum()
    if n == 0:
        return None, 0
    ys, xs = np.nonzero(m)
    return (xs.mean(), ys.mean()), n


def contour_metrics(g, th):
    """返回 dict：面积、外接框、squareness、对角比、径向剖面。"""
    m = g > th
    if m.sum() < 50:
        return None
    ys, xs = np.nonzero(m)
    cx, cy = xs.mean(), ys.mean()
    x0, x1 = xs.min(), xs.max()
    y0, y1 = ys.min(), ys.max()
    w = x1 - x0 + 1
    h = y1 - y0 + 1
    area = m.sum()
    squareness = area / float(w * h)

    # --- 判据 A：从质心放射出去，量「跌到 e^-1」的半径 ---
    peak = float(g[int(round(cy)), int(round(cx))])
    # 质心不一定压在最亮像素上（软核），取质心周围 5x5 的均值当峰值
    yy0, yy1 = max(0, int(cy) - 2), min(g.shape[0], int(cy) + 3)
    xx0, xx1 = max(0, int(cx) - 2), min(g.shape[1], int(cx) + 3)
    peak = max(peak, float(g[yy0:yy1, xx0:xx1].mean()))
    target = peak * math.exp(-1.0)

    H, W = g.shape
    rs = {}
    for deg in range(0, 360, 5):
        rad = math.radians(deg)
        c, s = math.cos(rad), math.sin(rad)
        r = 1.0
        last = None
        while True:
            x = int(round(cx + c * r))
            y = int(round(cy + s * r))
            if x < 0 or y < 0 or x >= W or y >= H:
                break
            v = g[y, x]
            if v < target:
                last = r
                break
            r += 0.5
            if r > 4 * max(W, H):
                break
        rs[deg] = last
    ok = {k: v for k, v in rs.items() if v is not None}
    if not ok:
        return None
    r0 = rs.get(0)
    r90 = rs.get(90)
    r45 = rs.get(45)
    r135 = rs.get(135)
    diag_ratio = None
    if r0 and r90 and r45 and r135:
        diag_ratio = ((r45 + r135) / 2.0) / ((r0 + r90) / 2.0)
    vals = np.array(list(ok.values()))
    return dict(
        cx=cx, cy=cy, w=w, h=h, area=area, squareness=squareness,
        r0=r0, r45=r45, r90=r90, r135=r135, diag_ratio=diag_ratio,
        rmin=float(vals.min()), rmax=float(vals.max()),
        cv=float(vals.std() / max(1e-9, vals.mean())),
        peak=peak, target=target, n=len(ok),
    )


def synth(shape, size=241, R=60.0):
    """合成基准：圆盘 / 方斑，都用同一条「到中心的切比雪夫或欧氏距离」亮度律。"""
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float64)
    cx = cy = size / 2.0
    dx = xx - cx + 0.5
    dy = yy - cy + 0.5
    if shape == 'disc':
        r = np.sqrt(dx * dx + dy * dy) / R
    else:
        r = np.maximum(np.abs(dx), np.abs(dy)) / R
    g = np.where(r >= 1, 0.0, np.power(1.0 - np.clip(r, 0, 1), 2.3) * 255.0)
    return g


def report(tag, g):
    th = g.max() * REL_TH
    m = contour_metrics(g, th)
    if m is None:
        print(f'  {tag:<44}  读不出来（图里没有超过阈值的东西）')
        return None
    sq = m['squareness']
    dr = m['diag_ratio']
    verdict = '方' if (dr is not None and dr > 1.15) else ('圆' if (dr is not None and dr < 1.05) else '说不清')
    print(f'  {tag:<44} 框 {m["w"]:>4}×{m["h"]:<4} 面积占比 {sq:.3f}  '
          f'对角比 {("--" if dr is None else f"{dr:.3f}"):>5}  '
          f'R(0/45/90/135)={m["r0"]}/{m["r45"]}/{m["r90"]}/{m["r135"]}  ⇒ **{verdict}**')
    return m


def main():
    args = sys.argv[1:]
    if not args:
        files = sorted(glob.glob(os.path.join(SHOTS, 'ablate-*-mw-bulge.png')),
                       key=lambda p: os.path.getmtime(p))
    else:
        files = [a if os.path.isabs(a) else os.path.join(SHOTS, a) for a in args]
    if not files:
        print('没找到任何 ablate-*-mw-bulge.png')
        return 1

    print('=' * 78)
    print('  量具自证 —— 合成图形能不能被这套判据认出来')
    print('-' * 78)
    print('  期望：合成圆盘 squareness≈0.785、对角比≈1.00；合成方斑 squareness≈1.000、对角比≈1.414')
    report('[自证] 合成圆盘', synth('disc'))
    report('[自证] 合成方斑', synth('square'))

    print('=' * 78)
    print('  被测对象 —— shots/ablate-*-mw-bulge.png（按修改时间，旧的在前）')
    print('-' * 78)
    for p in files:
        g = load_gray(p)
        import datetime
        mt = datetime.datetime.fromtimestamp(os.path.getmtime(p)).strftime('%m-%d %H:%M:%S')
        report(f'{os.path.basename(p)}  ({mt})', g)
    print('=' * 78)
    print('  判据：对角比 ≈1.00 / squareness ≈0.785 ⇒ 圆；对角比 >1.15 / squareness >0.9 ⇒ 方')
    return 0


if __name__ == '__main__':
    sys.exit(main())
