#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""贴图**内容**体检：这张图真的是一张表面贴图吗？

为什么有这个东西
----------------
用户报「部分天体贴图不对或者加载失败（如图这鬼样子）」，截图里木卫一是个黑球。

先跑的是 `check-textures.mjs`，它报 **「0 错误 · 0 告警 · 全部通过」** —— 因为那个脚本查的是
**引用完整性 / 分辨率 / 登记表诚实**：`web/textures/io.jpg` 确实存在、确实是 2048×1024、
登记表也承认它。**四条判据全绿。**

但把那张图打开看：**几乎全黑，只有零星几个小白斑**（像一张掩膜，不是表面贴图）。

  ⇒ **「贴图文件在」和「贴图是对的」是两件事。**
     前者是引用问题，后者是**内容**问题。所有静态检查都查不出后者 ——
     一张全黑的图和一张正确的图，在「文件存在 + 尺寸达标」这个视角下**完全一样**。

这是本项目「判据少认一个维度，就会把坏东西判成好的」的又一例（同族见 坑 56 / 坑 91）。
所以本脚本只做一件静态检查做不到的事：**把像素读出来，算它的统计量。**

口径（三条，都可证伪）
----------------------
1. **嫌疑·全黑**：平均亮度 < 12/255。表面贴图不可能整张全黑。
2. **嫌疑·近乎单色**：亮度标准差 < 4。真实表面（有地貌/云带/陨石坑）不可能这么平。
   ⚠️ 纯色图**有时候是故意的**（分类学反照率的示意色），所以这条只报「嫌疑」，
   要不要改由人判断 —— **判据负责把可疑的挑出来，不负责替你下结论**。
3. **嫌疑·掩膜样**：暗像素（<16）占比 > 80% **且** 亮点很少。

⚠️ **本脚本第一版就会误报**：法线贴图（`*_normal.jpg`）整张是淡紫蓝色、方差也不大，
   **它不是表面贴图，本来就不该按表面贴图的阈值判**。所以：
     · `*_normal.jpg` / `*_bump*` 单独归一类，只看「是不是全黑」（近乎全黑 = 一定坏了）；
     · 阈值**先只报数、不判定**，并打印完整表格供人抽查 ——
       这正是「新增会造成假警报的判据时，先手工抽查它报的 2–3 条」那条规矩。

用法
----
    py -3.13 -X utf8 tools/check-texture-content.py                # 默认扫 web/textures
    py -3.13 -X utf8 tools/check-texture-content.py --dirs=web/textures,web/images
    py -3.13 -X utf8 tools/check-texture-content.py --selftest     # 自证：合成的坏图必须被抓到
    py -3.13 -X utf8 tools/check-texture-content.py --json
退出码：0 = 没抓到坏图；1 = 有坏图；2 = 自证失败（拒绝判定）。
"""
import json
import os
import sys

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    print('需要 Pillow：py -3.13 -m pip install pillow')
    sys.exit(2)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIRS = ['web/textures']
JSON_OUT = False
SELFTEST = False
for a in sys.argv[1:]:
    if a.startswith('--dirs='):
        DIRS = [d.strip() for d in a.split('=', 1)[1].split(',') if d.strip()]
    elif a == '--json':
        JSON_OUT = True
    elif a == '--selftest':
        SELFTEST = True

# ---- 阈值（改这里就改口径；三处都在这里，别散落）----
BLACK_MEAN = 12.0        # 平均亮度低于此 ⇒ 「暗」（**单独不构成坏**，要和 DARK_P99 同时成立）
DARK_P99 = 5.0           # ★ 主判据：99 百分位亮度低于此 ⇒ 前 99% 像素几乎全黑 = **结构缺失**
FLAT_STD = 4.0           # 亮度标准差低于此 ⇒ 嫌疑·近乎单色
DARK_SHARE = 0.80        # 参考打印：暗像素（<16）占比
DARK_TIP = 0.005         # 参考打印：亮像素（>64）占比（**已不用于判定**，见下）
#
# ★★ 为什么「坏图」的主判据是 **p99**，而不是平均亮度或亮像素占比 —— 这是**两次误报**换来的：
#
#    第一版用「亮像素（>200）占比 < 0.05」判掩膜，把 `earth_night.jpg`（地球夜面灯图）判死。
#    手工看原图：大陆轮廓 + 密密麻麻的城市灯光，**完全正确**。于是把门槛收到 0.005。
#    **但那没解决问题** —— 第二次实测它的「>64 占比」只有 0.00457，仍在门槛下；
#    而且判据是在缩到 512 的采样图上算的，降采样把点状光源再缩小 3.7 倍（>150 占比 0.00095 → 0.00002）。
#    ⇒ 根因是**指标选错了**：占比会被「亮点有多稀」带偏，稀疏光源天生吃亏。
#
#    改用 p99（99 百分位亮度）后，标定样本一刀切开（均为全分辨率实测）：
#        旧 io.jpg（坏，全黑底 + 几粒白点）  mean 0.71   p99 =  0.9
#        earth_night.jpg（对，夜面灯图）      mean 10.03  p99 = 35.9
#        最暗的正常贴图 mathilde.jpg          mean 29.20  p99 = 31.0
#    门槛 5.0 ⇒ 坏侧余量 5×、好侧余量 6×。而 `max` / `p99.9` / `>64 占比` 都分不开：
#    坏图里那几粒白点足以把高分位撑到 164、把 max 撑到 255。**p99 不被极少数像素带偏。**
#
#    教训（已固化为自证里的「暗但有点状光源」正面用例）：
#    **判"坏"要证明的是「没有结构」，不是「暗」。暗是夜面的正常形态。**
SAMPLE_MAX = 512         # 采样缩放上限。p99 对降采样不敏感（earth_night 512 采样 p99=29.9，仍远超门槛）

NORMAL_SUFFIX = ('_normal', '-normal', '_bump', '_bumpmap')


def is_normal(name):
    stem = os.path.splitext(os.path.basename(name))[0].lower()
    return stem.endswith(NORMAL_SUFFIX)


def stats(path):
    """读一张图，返回统计量。**只做数值，不做判定**。"""
    with Image.open(path) as im:
        im = im.convert('RGB')
        w, h = im.size
        # 采样：缩到 ≤SAMPLE_MAX 再统计。整图统计量的采样偏差可以忽略，
        # 但读一张 4096² 的原图和读它的缩略图，耗时差一个数量级。
        if max(w, h) > SAMPLE_MAX:
            k = SAMPLE_MAX / max(w, h)
            im = im.resize((max(1, int(w * k)), max(1, int(h * k))), Image.BILINEAR)
        px = list(im.getdata())
    n = len(px)
    # 亮度用 Rec.709（和人眼一致；用算术平均会把蓝色通道抬得过高）
    lum = [0.2126 * r + 0.7152 * g + 0.0722 * b for r, g, b in px]
    mean = sum(lum) / n
    var = sum((v - mean) ** 2 for v in lum) / n
    dark = sum(1 for v in lum if v < 16) / n
    bright = sum(1 for v in lum if v > 64) / n
    # ★ 主判据用的 p99：99 百分位亮度。代表「绝大多数像素的亮度水平」，
    #   不被少数亮点撑高、也不被稀疏性带偏（对比 max / bright 见常量区的标定表）。
    sl = sorted(lum)
    p99 = sl[min(n - 1, int(n * 0.99))]
    # 色相离散度：纯灰的图 std 低但未必是全黑/掩膜，分开量化便于人判断
    return {
        'w': w, 'h': h, 'size': os.path.getsize(path),
        'mean': round(mean, 1), 'std': round(var ** 0.5, 1),
        'dark': round(dark, 3), 'bright': round(bright, 3), 'p99': round(p99, 1),
        'normal': is_normal(path),
    }


def verdict(name, s):
    """判定：**法线贴图只判「全黑」**；其余以 p99 为主判据。"""
    if s['normal']:
        return '坏' if s['mean'] < BLACK_MEAN else None
    # ★ 坏 = 「整体暗」**且**「前 99% 像素几乎是黑的」。两个条件同时成立才判。
    #   （单看 mean 会冤枉夜面图：earth_night.jpg mean 只有 10.0，它是对的。
    #     单看亮像素占比会冤枉稀疏光源：坏图里那几粒白点反而撑起了占比。见常量区标定表。）
    if s['mean'] < BLACK_MEAN and s['p99'] < DARK_P99:
        return '坏'
    if s['std'] < FLAT_STD:
        return '嫌疑'
    return None


def scan(dirs):
    rows = []
    for d in dirs:
        full = os.path.join(ROOT, d)
        if not os.path.isdir(full):
            continue
        for f in sorted(os.listdir(full)):
            if not f.lower().endswith(('.jpg', '.jpeg', '.png', '.webp')):
                continue
            p = os.path.join(full, f)
            try:
                s = stats(p)
            except Exception as e:                       # 解不开的图本身就是坏图
                rows.append({'file': f'{d}/{f}', 'err': str(e)[:80], 'verdict': '坏'})
                continue
            s['file'] = f'{d}/{f}'
            s['verdict'] = verdict(s['file'], s)
            rows.append(s)
    return rows


# ---------------------------------------------------------------- 自证
def selftest():
    """造合成图：判据必须把坏图抓出来，且不能把好图误报。"""
    from PIL import Image as I
    import io as _io

    def mk(fn):
        buf = _io.BytesIO()
        fn().save(buf, format='PNG')
        buf.seek(0)
        return I.open(buf)

    cases = []
    # 好图：有纹理、亮度中等（用棋盘 + 噪声模拟地貌）
    def good():
        im = I.new('RGB', (256, 256))
        px = [((x * 7 + y * 13) % 200 + 40, (x * 3 + y * 5) % 180 + 50, (x + y) % 160 + 40)
              for y in range(256) for x in range(256)]
        im.putdata(px)
        return im

    def black():
        return I.new('RGB', (256, 256), (0, 0, 0))

    def flat():
        return I.new('RGB', (256, 256), (128, 128, 128))

    def mask():
        im = I.new('RGB', (256, 256), (0, 0, 0))
        for i in range(30):
            im.putpixel((i * 7 % 256, i * 11 % 256), (255, 255, 255))
        return im

    def night():
        # ★ 正面用例：「暗但占绝大多数的像素仍有结构」= 地球夜面灯图的形态
        #   （真图实测 mean 10.0 / p99 35.9）。它是**正确贴图**，判据必须放行。
        #   这就是 p99 取代「平均亮度」的理由 —— 这条用例是为了防止误报复发才加的。
        #   ⚠️ 铺地表必须走网格：早先用 (i*37)%256 那种乘法散列，**模 256 的周期就是 256**，
        #      循环 9361 次实际只覆盖 256 个像素（0.39%），于是 p99 掉回暗底、
        #      这个"正面用例"反而被判坏（自证 4/5）。**用例自己算错，比判据错更难查。**
        im = I.new('RGB', (256, 256), (4, 4, 7))                 # 近黑的夜面底（亮度≈4）
        for y in range(0, 256, 3):                               # ~11% 暗灰地表（亮度≈35）
            for x in range(0, 256, 3):
                im.putpixel((x, y), (36, 34, 41))
        for i in range(0, 256, 17):                              # 稀疏城市灯光（~0.04%）
            im.putpixel((i, (i * 7 + 3) % 256), (225, 210, 175))
        for i in range(0, 256, 23):
            im.putpixel(((i * 5 + 11) % 256, i), (225, 210, 175))
        return im

    for name, im in [('好图·有纹理', good()), ('坏图·全黑', black()),
                     ('嫌疑·纯单色', flat()), ('坏图·掩膜样', mask()),
                     ('对图·夜面灯', night())]:
        cases.append((name, im))

    def measure(im):
        buf = _io.BytesIO()
        im.save(buf, format='PNG')
        buf.seek(0)
        w, h = im.size
        with I.open(buf) as x:
            x = x.convert('RGB')
            px = list(x.getdata())
        n = len(px)
        lum = [0.2126 * r + 0.7152 * g + 0.0722 * b for r, g, b in px]
        mean = sum(lum) / n
        var = sum((v - mean) ** 2 for v in lum) / n
        sl = sorted(lum)
        return {'w': w, 'h': h, 'size': 0, 'mean': round(mean, 1),
                'std': round(var ** 0.5, 1),
                'dark': round(sum(1 for v in lum if v < 16) / n, 3),
                'bright': round(sum(1 for v in lum if v > 64) / n, 3),
                'p99': round(sl[min(n - 1, int(n * 0.99))], 1),
                'normal': False}

    expect = {'好图·有纹理': None, '坏图·全黑': '坏', '嫌疑·纯单色': '嫌疑',
              '坏图·掩膜样': '坏', '对图·夜面灯': None}
    lines, passed, failed = [], 0, 0
    for name, im in cases:
        s = measure(im)
        got = verdict(name, s)
        ok = got == expect[name]
        passed += ok
        failed += (not ok)
        lines.append(f"  {'✓' if ok else '✗'} {name:<10} mean={s['mean']:>6} std={s['std']:>5} "
                     f"p99={s['p99']:>6} bright={s['bright']:>6} → 判定 {got}（期望 {expect[name]}）")
    lines.append('')
    lines.append(f"  {'✓' if failed == 0 else '✗'} 自证 {passed}/{len(cases)}"
                 + (' —— 口径会响，可以拿去查真贴图了。' if failed == 0
                    else ' —— **口径有问题，拒绝判定**。'))
    return {'pass': passed, 'fail': failed, 'total': len(cases), 'lines': lines}


def main():
    out = {'root': ROOT, 'selftest': None, 'rows': []}
    code = 0
    if SELFTEST:
        st = selftest()
        out['selftest'] = {'pass': st['pass'], 'fail': st['fail'], 'total': st['total']}
        if not JSON_OUT:
            print('\n'.join(st['lines']))
        if st['fail']:
            if JSON_OUT:
                print(json.dumps(out, ensure_ascii=False))
            sys.exit(2)

    rows = scan(DIRS)
    out['rows'] = rows
    bad = [r for r in rows if r.get('verdict') == '坏']
    sus = [r for r in rows if r.get('verdict') == '嫌疑']
    if not JSON_OUT:
        print(f'\n  扫了 {len(rows)} 张贴图（{", ".join(DIRS)}）')
        print('  最暗的 12 张（按平均亮度升序，便于抽查看阈值合不合理）：')
        for r in sorted(rows, key=lambda x: x.get('mean', 0))[:12]:
            tag = {'坏': '✗ 坏  ', '嫌疑': '! 嫌疑', None: '  ·   '}[r.get('verdict')]
            print(f'    {tag} {r["file"]:<34} mean={r.get("mean"):>6} std={r.get("std"):>6} '
                  f'p99={r.get("p99"):>6} {r.get("w")}×{r.get("h")} {r.get("size", 0) // 1024}KB')
        print()
        if bad:
            print(f'  ✗ {len(bad)} 张是坏的（前 99% 像素近乎全黑 = 没有结构）：')
            for r in bad:
                print(f'      {r["file"]}  mean={r.get("mean")} p99={r.get("p99")}')
            print('    → 这些天体在界面上就是**黑球/糊球**。处置：从公开源重抓真实表面贴图，')
            print('      或改用「按反照率与色指数算出的示意色」（并如实标注为示意色）。')
            code = 1
        if sus:
            print(f'  ! {len(sus)} 张近乎单色（可能是有意的示意色，也可能是坏图）：')
            for r in sus[:12]:
                print(f'      {r["file"]}  std={r.get("std")}')
            print('    → 判据只负责挑可疑，改不改由人判断。')
        if not bad and not sus:
            print('  ✓ 没有全黑 / 单色可疑的贴图。')
    else:
        if bad:
            code = 1
    if JSON_OUT:
        print(json.dumps(out, ensure_ascii=False))
    sys.exit(code)


if __name__ == '__main__':
    main()
