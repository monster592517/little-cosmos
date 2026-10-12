#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 data/raw/textures 里的原始贴图加工成 web/textures 可直接使用的成品：

  · 统一缩放到目标宽度（默认 4096×2048，小天体 2048×1024 / 1024×512）
  · 颜色贴图 → JPEG (quality 88, progressive)，法线/高光/环透明度 → PNG
  · 天王星 / 海王星按 Irwin et al. 2024 的真实颜色重定色（Voyager 深蓝是传感器
    经过木星辐射带受损后的失真，海王星实际只比天王星略偏蓝、且更淡）
  · 处理完成后删除旧的 2k_* 贴图，避免新旧混淆
  · 为细节不足的天体生成法线贴图（影像灰度求梯度 + 程序化撞击坑），
    在三维场景里用真实光照表现起伏——相当于把模糊照片「还原」成有立体感的模型
  · 输出 data/texture-manifest.json：每个贴图的来源、许可、原始影像、分辨率，
    前端据此在详情页标注「建模图片来源」

用法：py -3.13 tools/build-textures.py [--keep-old]
"""
import os
import sys
import json
import glob
import numpy as np
from PIL import Image, ImageFilter

Image.MAX_IMAGE_PIXELS = None   # 官方全球马赛克可达 2 亿像素（如土卫四 23040×11520）

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'data', 'raw', 'textures')
OUT = os.path.join(ROOT, 'web', 'textures')
DATA = os.path.join(ROOT, 'data')

SSS = ('Solar System Scope 8K 贴图', 'CC BY 4.0')
CEL = ('Celestia Content 全球影像', 'GPL-2.0+（NASA / USGS / JPL 影像汇编）')
NASA = ('NASA / USGS 官方全球马赛克', '公有领域（NASA / JHUAPL / USGS）')
CREDIT = {
    'sun.jpg': (SSS[0], SSS[1], 'SDO / Solar Orbiter 全日面影像'),
    'mercury.jpg': (SSS[0], SSS[1], 'MESSENGER MDIS 全球马赛克（NASA/APL）'),
    'venus.jpg': (SSS[0], SSS[1], 'Magellan 雷达地形 + 金星表面重建'),
    'venus_atmosphere.jpg': (SSS[0], SSS[1], 'Mariner 10 / Venus Express 云顶影像'),
    'earth.jpg': (SSS[0], SSS[1], 'NASA Blue Marble（MODIS 影像合成）'),
    'earth_night.jpg': (SSS[0], SSS[1], 'NASA Black Marble（Suomi NPP VIIRS 夜间灯光）'),
    'earth_clouds.jpg': (SSS[0], SSS[1], 'NASA 云层合成影像'),
    'earth_normal.png': (SSS[0], SSS[1], '由 ETOPO 地形数据生成的法线图'),
    'earth_specular.png': (SSS[0], SSS[1], '海洋/陆地高光遮罩（NASA）'),
    'moon.jpg': (SSS[0], SSS[1], 'LRO LROC 全球影像（NASA/GSFC）'),
    'mars.jpg': (SSS[0], SSS[1], 'NASA / JPL 火星全球影像（Viking + MGS）'),
    'jupiter.jpg': (SSS[0], SSS[1], 'Juno JunoCam / Cassini ISS 全球图'),
    'jupiter_juno.jpg': (CEL[0], CEL[1], 'Juno JunoCam 2018 全球图'),
    'saturn.jpg': (SSS[0], SSS[1], 'Cassini ISS 全球图'),
    'saturn_ring.png': (SSS[0], SSS[1], 'Cassini 环系透明度图'),
    'uranus.jpg': (CEL[0], CEL[1], 'Voyager 2 影像（按 Irwin et al. 2024 重定色）'),
    'neptune.jpg': (CEL[0], CEL[1], 'Voyager 2 影像（按 Irwin et al. 2024 重定色）'),
    'io.jpg': (CEL[0], CEL[1], 'Galileo SSI / Voyager + JunoCam 全球图'),
    'europa.jpg': (CEL[0], CEL[1], 'Galileo SSI / Voyager 全球马赛克'),
    'ganymede.jpg': (CEL[0], CEL[1], 'Galileo SSI / Voyager 全球马赛克 + Juno 补充'),
    'callisto.jpg': (CEL[0], CEL[1], 'Galileo SSI / Voyager 全球马赛克'),
    'phobos.jpg': (CEL[0], CEL[1], 'Viking / Mars Express 全球马赛克'),
    'deimos.jpg': (CEL[0], CEL[1], 'Viking 全球马赛克'),
    'titan.jpg': (NASA[0], NASA[1], 'Cassini ISS 全球马赛克（PIA22770）'),
    'enceladus.jpg': (NASA[0], NASA[1], 'Cassini ISS 全球马赛克（PIA18435）'),
    'mimas.jpg': (NASA[0], NASA[1], 'Cassini ISS 全球马赛克（PIA18437）'),
    'tethys.jpg': (NASA[0], NASA[1], 'Cassini ISS 全球马赛克（PIA18439）'),
    'dione.jpg': (NASA[0], NASA[1], 'Cassini ISS 全球马赛克（PIA12577）'),
    'rhea.jpg': (NASA[0], NASA[1], 'Cassini ISS 全球马赛克（PIA18438）'),
    'iapetus.jpg': (NASA[0], NASA[1], 'Cassini ISS 全球马赛克（PIA18436）'),
    'phoebe.jpg': (CEL[0], CEL[1], 'Cassini ISS 飞掠影像'),
    'hyperion.jpg': (CEL[0], CEL[1], 'Cassini ISS 影像拼接'),
    'miranda.jpg': (CEL[0], CEL[1], 'Voyager 2 全球马赛克'),
    'ariel.jpg': (CEL[0], CEL[1], 'Voyager 2 全球马赛克'),
    'umbriel.jpg': (CEL[0], CEL[1], 'Voyager 2 影像'),
    'titania.jpg': (CEL[0], CEL[1], 'Voyager 2 影像'),
    'oberon.jpg': (CEL[0], CEL[1], 'Voyager 2 影像'),
    'puck.jpg': (CEL[0], CEL[1], 'Voyager 2 影像'),
    'triton.jpg': (NASA[0], NASA[1], 'Voyager 2 全球马赛克（PIA18668）'),
    'pluto.jpg': (NASA[0], NASA[1], 'New Horizons 全球彩色图（PIA11707）'),
    'charon.jpg': (NASA[0], NASA[1], 'New Horizons 全球马赛克（PIA19866）+ 彩色图上色'),
    'nix.jpg': (CEL[0], CEL[1], 'New Horizons 影像'),
    'ceres.jpg': (CEL[0], CEL[1], 'Dawn 取景相机全球马赛克'),
    'vesta.jpg': (CEL[0], CEL[1], 'Dawn 取景相机 HAMO 全球马赛克'),
    'eros.jpg': (CEL[0], CEL[1], 'NEAR Shoemaker MSI 全球马赛克'),
    'itokawa.jpg': (CEL[0], CEL[1], '隼鸟号 AMICA 影像拼接'),
    'bennu.jpg': (CEL[0], CEL[1], 'OSIRIS-REx OCAMS 全球马赛克'),
    'ryugu.jpg': (CEL[0], CEL[1], '隼鸟 2 号 ONC 全球马赛克'),
    'arrokoth.jpg': (CEL[0], CEL[1], 'New Horizons LORRI 飞掠影像'),
    'gaspra.jpg': (CEL[0], CEL[1], 'Galileo SSI 飞掠影像'),
    'ida.jpg': (CEL[0], CEL[1], 'Galileo SSI 飞掠影像'),
    'lutetia.jpg': (CEL[0], CEL[1], 'Rosetta OSIRIS 飞掠影像'),
    'mathilde.jpg': (CEL[0], CEL[1], 'NEAR Shoemaker MSI 飞掠影像'),
    'dinkinesh.jpg': (CEL[0], CEL[1], "Lucy L'LORRI 飞掠影像"),
}

NORMAL_TARGETS = {
    'mercury.jpg', 'moon.jpg', 'mars.jpg', 'phobos.jpg', 'deimos.jpg',
    'io.jpg', 'europa.jpg', 'ganymede.jpg', 'callisto.jpg',
    'titan.jpg', 'enceladus.jpg', 'mimas.jpg', 'tethys.jpg', 'dione.jpg', 'rhea.jpg',
    'iapetus.jpg', 'phoebe.jpg', 'hyperion.jpg',
    'miranda.jpg', 'ariel.jpg', 'umbriel.jpg', 'titania.jpg', 'oberon.jpg', 'puck.jpg',
    'triton.jpg', 'pluto.jpg', 'charon.jpg', 'nix.jpg', 'ceres.jpg', 'vesta.jpg',
    'eros.jpg', 'itokawa.jpg', 'bennu.jpg', 'ryugu.jpg', 'arrokoth.jpg',
}

# 贴图尺寸上限（显存/内存预算）：只让最常细看的天体保持高分辨率。
# 全景取景时球体约占画面高 60%（≈540px），2048 宽贴图的可见半球已有约 1024 像素，
# 已经超过屏幕像素，再大只是白占显存。
WIDTH_OVERRIDE = {
    'earth.jpg': 4096,          # 地球是门面，保留 4K
    'earth_night.jpg': 2048,
    'earth_clouds.jpg': 2048,
    'earth_normal.png': 1024,
    'earth_specular.png': 1024,
    'sun.jpg': 2048,
    'mercury.jpg': 2048, 'venus.jpg': 2048, 'mars.jpg': 2048, 'moon.jpg': 2048,
    'jupiter.jpg': 2048, 'saturn.jpg': 2048, 'saturn_ring.png': 1024,
    'venus_atmosphere.jpg': 1024, 'uranus.jpg': 1024, 'neptune.jpg': 1024,
    'io.jpg': 2048, 'europa.jpg': 2048, 'ganymede.jpg': 2048, 'callisto.jpg': 2048,
    'jupiter_juno.jpg': 2048,
    'titan.jpg': 2048, 'enceladus.jpg': 2048, 'pluto.jpg': 2048,
    'mimas.jpg': 1024, 'tethys.jpg': 1024, 'dione.jpg': 1024, 'rhea.jpg': 1024,
    'iapetus.jpg': 1024, 'triton.jpg': 1024, 'charon.jpg': 1024,
    'miranda.jpg': 1024, 'ariel.jpg': 1024, 'ceres.jpg': 1024, 'vesta.jpg': 1024,
    'phobos.jpg': 1024, 'deimos.jpg': 1024,
    'phoebe.jpg': 512, 'hyperion.jpg': 512, 'umbriel.jpg': 512, 'titania.jpg': 512,
    'oberon.jpg': 512, 'puck.jpg': 256, 'nix.jpg': 256,
    'eros.jpg': 512, 'itokawa.jpg': 256, 'bennu.jpg': 512, 'ryugu.jpg': 512,
    'arrokoth.jpg': 256, 'gaspra.jpg': 256, 'ida.jpg': 256, 'lutetia.jpg': 256,
    'mathilde.jpg': 256, 'dinkinesh.jpg': 256,
}
NORMAL_MAX_WIDTH = 1024


def crater_field(shape, seed, count=420, base=(320, 160)):
    """低分辨率程序化撞击坑高度场（再放大），给细节不足的小天体增加立体感。"""
    bw, bh = base
    rng = np.random.default_rng(seed)
    ys, xs = np.mgrid[0:bh, 0:bw].astype(np.float32)
    field = np.zeros((bh, bw), dtype=np.float32)
    for _ in range(count):
        cy, cx = rng.uniform(0, bh), rng.uniform(0, bw)
        r = rng.uniform(1.6, max(2.4, bh * 0.09))
        d = np.sqrt(((xs - cx) / r) ** 2 + ((ys - cy) / r) ** 2)
        field += (np.exp(-((d - 1.0) ** 2) / 0.10) * 0.55 - np.exp(-(d ** 2) / 0.30) * 0.45) * rng.uniform(0.35, 1.0)
    img = Image.fromarray(((field - field.min()) / max(1e-6, field.max() - field.min()) * 255).astype(np.uint8), 'L')
    return img.resize(shape, Image.BICUBIC)


def make_normal_map(im, strength=3.2, blur=1.0, crater=0.0, seed=1):
    """由灰度影像求梯度生成切线空间法线图（可叠加程序化撞击坑）。"""
    g = im.convert('L')
    if blur:
        g = g.filter(ImageFilter.GaussianBlur(blur))
    a = np.asarray(g, dtype=np.float32) / 255.0
    if crater > 0:
        cf = np.asarray(crater_field(im.size, seed), dtype=np.float32) / 255.0
        a = a * (1.0 - crater * 0.5) + cf * crater
    dx = (np.roll(a, -1, axis=1) - np.roll(a, 1, axis=1)) * 127.5
    dy = (np.roll(a, -1, axis=0) - np.roll(a, 1, axis=0)) * 127.5
    nx, ny, nz = -dx * strength, -dy * strength, np.full_like(dx, 255.0)
    ln = np.sqrt(nx * nx + ny * ny + nz * nz)
    out = np.stack([nx / ln * 127.5 + 127.5, ny / ln * 127.5 + 127.5, nz / ln * 127.5 + 127.5], axis=-1)
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), 'RGB')

# (源文件, 输出文件, 目标宽度, 类型, 后处理)
#   后处理：fill=填补极区缺失（整行近黑时用最近有效行拉伸） / auto=自动对比度 / sat=适度提饱和
JOBS = [
    # ---- 太阳与行星（Solar System Scope 8K，CC BY 4.0）----
    ('8k_sun.jpg',                'sun.jpg',             4096, 'rgb', ''),
    ('8k_mercury.jpg',            'mercury.jpg',         4096, 'rgb', ''),
    ('8k_venus_surface.jpg',      'venus.jpg',           4096, 'rgb', ''),
    ('4k_venus_atmosphere.jpg',   'venus_atmosphere.jpg', 2048, 'rgb', ''),
    ('8k_earth_daymap.jpg',       'earth.jpg',           4096, 'rgb', ''),
    ('8k_earth_nightmap.jpg',     'earth_night.jpg',     4096, 'rgb', ''),
    ('8k_earth_clouds.jpg',       'earth_clouds.jpg',    4096, 'rgb', ''),
    ('8k_earth_normal_map.tif',   'earth_normal.png',    2048, 'png', ''),
    ('8k_earth_specular_map.tif', 'earth_specular.png',  2048, 'png', ''),
    ('8k_moon.jpg',               'moon.jpg',            4096, 'rgb', ''),
    ('8k_mars.jpg',               'mars.jpg',            4096, 'rgb', ''),
    ('8k_jupiter.jpg',            'jupiter.jpg',         4096, 'rgb', ''),
    ('8k_saturn.jpg',             'saturn.jpg',          4096, 'rgb', ''),
    ('8k_saturn_ring_alpha.png',  'saturn_ring.png',     1024, 'png', ''),
    ('celestia_uranus.jpg',       'uranus.jpg',          2048, 'retint:#a8d9dd', 'fill,sharp'),
    ('celestia_neptune.jpg',      'neptune.jpg',         2048, 'retint:#93b6e6', 'fill,sharp'),
    # ---- 木星系 ----
    ('celestia_io.png',           'io.jpg',              4096, 'rgb', 'sat'),
    ('celestia_europa.jpg',       'europa.jpg',          4096, 'rgb', 'auto,sat'),
    ('celestia_ganymede.jpg',     'ganymede.jpg',        4096, 'rgb', ''),
    ('celestia_callisto.jpg',     'callisto.jpg',        4096, 'rgb', ''),
    ('celestia_jupiter2018.jpg',  'jupiter_juno.jpg',    4096, 'rgb', ''),
    # ---- 火星卫星 ----
    ('celestia_phobos.jpg',       'phobos.jpg',          2048, 'rgb', ''),
    ('celestia_deimos.jpg',       'deimos.jpg',          2048, 'rgb', ''),
    # ---- 土星系（NASA/USGS 官方全球马赛克，比通用贴图清晰得多）----
    ('nasa_titan.jpg',            'titan.jpg',           4096, 'colorize:celestia_titan.png', 'fill'),
    ('nasa_enceladus.jpg',        'enceladus.jpg',       4096, 'rgb', 'fill'),
    ('nasa_mimas.jpg',            'mimas.jpg',           2048, 'rgb', 'fill'),
    ('nasa_tethys.jpg',           'tethys.jpg',          2048, 'rgb', 'fill'),
    ('nasa_dione.jpg',            'dione.jpg',           2048, 'rgb', 'fill'),
    ('nasa_rhea.jpg',             'rhea.jpg',            2048, 'rgb', 'fill'),
    ('nasa_iapetus.jpg',          'iapetus.jpg',         2048, 'rgb', 'fill'),
    ('celestia_phoebe.jpg',       'phoebe.jpg',          1024, 'rgb', ''),
    ('celestia_hyperion.jpg',     'hyperion.jpg',        1024, 'rgb', ''),
    # ---- 天王星系 ----
    ('celestia_miranda.jpg',      'miranda.jpg',         2048, 'rgb', ''),
    ('celestia_ariel.jpg',        'ariel.jpg',           2048, 'rgb', ''),
    ('celestia_umbriel.jpg',      'umbriel.jpg',         1024, 'rgb', ''),
    ('celestia_titania.jpg',      'titania.jpg',         1024, 'rgb', ''),
    ('celestia_oberon.jpg',       'oberon.jpg',          1024, 'rgb', ''),
    ('celestia_puck.jpg',         'puck.jpg',             512, 'rgb', ''),
    # ---- 海王星系 ----
    ('nasa_triton.jpg',           'triton.jpg',          2048, 'rgb', 'fill'),
    # ---- 矮行星与海外天体 ----
    ('nasa_pluto.jpg',            'pluto.jpg',           4096, 'rgb', 'fill'),
    ('nasa_charon.jpg',           'charon.jpg',          4096, 'colorize:celestia_charon.jpg', 'fill'),
    ('celestia_nix.jpg',          'nix.jpg',              512, 'rgb', ''),
    ('celestia_ceres.jpg',        'ceres.jpg',           2048, 'rgb', 'auto'),
    ('celestia_vesta.jpg',        'vesta.jpg',           2048, 'rgb', ''),
    # ---- 小天体 ----
    ('celestia_eros.jpg',         'eros.jpg',            1024, 'rgb', ''),
    ('celestia_itokawa.jpg',      'itokawa.jpg',          512, 'rgb', ''),
    ('celestia_bennu.jpg',        'bennu.jpg',           1024, 'rgb', 'auto'),
    ('celestia_ryugu.jpg',        'ryugu.jpg',           1024, 'rgb', 'auto'),
    ('celestia_arrokoth.jpg',     'arrokoth.jpg',         512, 'rgb', 'auto'),
    ('celestia_gaspra.jpg',       'gaspra.jpg',           512, 'rgb', ''),
    ('celestia_ida.jpg',          'ida.jpg',              512, 'rgb', ''),
    ('celestia_lutetia.jpg',      'lutetia.jpg',          512, 'rgb', ''),
    ('celestia_mathilde.jpg',     'mathilde.jpg',         512, 'rgb', ''),
    ('celestia_dinkinesh.jpg',    'dinkinesh.jpg',        512, 'rgb', ''),
]


def hex_rgb(s):
    s = s.lstrip('#')
    return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))


def retint(im, target_hex, sat_cap=0.30):
    """把整体色调映射到科学测定色，同时压低色度、保留明暗细节。"""
    im = im.convert('RGB')
    target = hex_rgb(target_hex)
    mean = im.resize((1, 1), Image.BOX).getpixel((0, 0))
    mean = tuple(max(1, c) for c in mean)
    gains = [min(4.0, max(0.25, t / m)) for t, m in zip(target, mean)]
    lut = []
    for g in gains:
        lut.append([min(255, int(round(i * g))) for i in range(256)])
    im = Image.merge('RGB', [ch.point(lut[i]) for i, ch in enumerate(im.split())])
    # 压低饱和度，避免单色行星出现不真实的彩色噪点
    h, s, v = im.convert('HSV').split()
    cap = int(sat_cap * 255)
    s = s.point(lambda x: min(x, cap))
    return Image.merge('HSV', (h, s, v)).convert('RGB')


def fill_missing_rows(im, thresh=18, fade=0.94):
    """把影像里未拍摄的纯黑区域补上（逐像素，不按整行）。

    上下都有数据 → 线性过渡；只有一侧有数据（如冥王星南极未被拍到）→ 镜像该侧，
    并轻微压暗，避免出现拉伸条纹或突兀的黑色缺口。
    """
    a = np.asarray(im.convert('RGB'), dtype=np.float32)
    lum = a.mean(axis=2)
    mask = lum < thresh
    if not mask.any():
        return im
    h, w = mask.shape
    ys = np.arange(h, dtype=np.int32)[:, None]
    cols = np.arange(w, dtype=np.int32)[None, :]
    valid = ~mask
    ya = np.maximum.accumulate(np.where(valid, ys, -1), axis=0)
    yb = np.minimum.accumulate(np.where(valid, ys, h)[::-1], axis=0)[::-1]
    have_up = ya >= 0
    have_dn = yb < h
    both = have_up & have_dn

    yac = np.clip(ya, 0, h - 1)
    ybc = np.clip(yb, 0, h - 1)
    t = np.where(both, (ys - ya) / np.maximum(yb - ya, 1), 0.0).astype(np.float32)[..., None]
    blend = a[yac, cols] * (1 - t) + a[ybc, cols] * t

    up = np.clip(ya - (ys - ya), 0, h - 1)
    dn = np.clip(yb + (yb - ys), 0, h - 1)
    mirror_up = a[up, cols] * fade
    mirror_dn = a[dn, cols] * fade

    fill = np.where(both[..., None], blend,
                    np.where(have_up[..., None], mirror_up,
                             np.where(have_dn[..., None], mirror_dn, a)))
    out = np.where(mask[..., None], fill, a)
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), 'RGB')


def main():
    keep_old = '--keep-old' in sys.argv
    # `--only=io.jpg,europa.jpg` —— 只重建这几张。
    # ⚠️ 为什么需要它：本脚本的清单是**全量重写**的（manifest 从空字典开始）。
    #    只想重修一张坏图时如果跑全量，① 要解码 89 张（含 2 亿像素的官方马赛克）慢且吃内存；
    #    ② 会顺手把好图也重新"处理"一遍（画质/压缩参数一变，89 张全变样）。
    only = None
    for a in sys.argv[1:]:
        if a.startswith('--only='):
            only = {x.strip() for x in a.split('=', 1)[1].split(',') if x.strip()}
    os.makedirs(OUT, exist_ok=True)
    ok = miss = skip = 0
    manifest = {}
    print('=== 生成 web/textures ===' + (f'（只重建 {len(only)} 张：{", ".join(sorted(only))}）' if only else ''))
    for src, dst, width, kind, ops in JOBS:
        if only and dst not in only:
            skip += 1
            continue
        path = os.path.join(RAW, src)
        if not os.path.exists(path):
            print(f'  ✗ 缺少源文件 {src}')
            miss += 1
            continue
        im = Image.open(path)
        # ⚠️⚠️ 坑 96：**必须先收敛成 RGB，再缩放**。顺序反了会静默把图打黑。
        #    Pillow 对 RGBA 做 LANCZOS 缩放时会按 alpha 加权（预乘），于是
        #    alpha 大面积≈0 的源图（如 celestia_io.png：alpha 均值 0.6、99.3% 像素透明）
        #    缩完 RGB 就塌到接近 0 —— 且**不报任何错**，输出一张 29 KB 的"黑图带几粒白点"。
        #    实测：木卫一 亮度均值 178 → 0.7。判据 `prog.resize-before-rgb` 守这条。
        if dst.endswith('.jpg') and im.mode != 'RGB':
            im = im.convert('RGB')
        # 超大原图（官方全球马赛克可达 2 亿像素）先降到目标尺寸，避免解码/转换时爆内存
        width = WIDTH_OVERRIDE.get(dst, width)
        w, h = im.size
        if w > width:
            im = im.resize((width, max(1, round(h * width / w))), Image.LANCZOS)

        if kind.startswith('retint:'):
            im = retint(im, kind.split(':', 1)[1])
        elif kind.startswith('colorize:'):
            # 高分辨率灰度全球图 + 低分辨率彩色图 → 上色（LAB 的 a/b 通道）
            g = im.convert('L')
            ref = Image.open(os.path.join(RAW, kind.split(':', 1)[1])).convert('RGB').resize(g.size, Image.LANCZOS).convert('LAB')
            _, a, b = ref.split()
            im = Image.merge('LAB', (g, a, b)).convert('RGB')
        elif kind == 'rgb':
            im = im.convert('RGB')
        elif kind == 'png':
            im = im.convert('RGBA') if 'A' in im.getbands() else im.convert('RGB')

        opset = set(o for o in (ops or '').split(',') if o)
        if 'fill' in opset:
            im = fill_missing_rows(im)
        if 'auto' in opset and im.mode == 'RGB':
            from PIL import ImageOps
            im = ImageOps.autocontrast(im, cutoff=1)
        if 'sharp' in opset and im.mode == 'RGB':
            im = im.filter(ImageFilter.UnsharpMask(radius=2, percent=140, threshold=4))
        if 'sat' in opset and im.mode == 'RGB':
            hh, s, v = im.convert('HSV').split()
            s = s.point(lambda x: min(255, int(x * 1.25)))
            im = Image.merge('HSV', (hh, s, v)).convert('RGB')

        out = os.path.join(OUT, dst)
        if dst.endswith('.png'):
            im.save(out, 'PNG', optimize=True)
        else:
            im.save(out, 'JPEG', quality=88, optimize=True, progressive=True)

        # ---- 法线贴图：由影像灰度求梯度 + 程序化撞击坑 ----
        normal_file = None
        if dst in NORMAL_TARGETS and im.mode == 'RGB':
            nw = min(NORMAL_MAX_WIDTH, max(256, im.size[0] // 2))
            small = im.resize((nw, max(1, round(im.size[1] * nw / im.size[0]))), Image.LANCZOS)
            crater = 0.35 if im.size[0] <= 2048 else 0.16
            nm = make_normal_map(small, strength=3.4, blur=1.0, crater=crater,
                                 seed=(sum(ord(c) for c in dst) % 9973) + 7)
            normal_file = dst.rsplit('.', 1)[0] + '_normal.jpg'
            nm.save(os.path.join(OUT, normal_file), 'JPEG', quality=90, optimize=True, progressive=True)

        credit, license_, imaging = CREDIT.get(dst, (None, None, None))
        manifest[dst] = {
            'source': credit or '程序化生成',
            'license': license_ or '—',
            'imaging': imaging or None,
            'width': im.size[0], 'height': im.size[1],
            'normal': normal_file,
            'bytes': os.path.getsize(out),
        }
        extra = f'  + {normal_file}' if normal_file else ''
        print(f'  ✓ {dst:24} {im.size[0]}×{im.size[1]}  {os.path.getsize(out) / 1048576:.2f} MB{extra}')
        ok += 1

    if not keep_old and not only:
        old = glob.glob(os.path.join(OUT, '2k_*.jpg')) + glob.glob(os.path.join(OUT, '2k_*.png'))
        for f in old:
            os.remove(f)
        if old:
            print(f'  · 已删除 {len(old)} 个旧贴图（2k_*）')
    # ⚠️ 单张重建（--only）时，清理动作一律跳过 —— 那是**全量重建**才该做的事。

    manifest_path = os.path.join(DATA, 'texture-manifest.json')
    if only:
        # ⚠️ **单张重建必须合并已有清单，不能全量重写。**
        #    直接写盘会把另外 88 条记录抹掉 —— 那会让 `check-textures.mjs` 的
        #    「登记表诚实」全线报错，而登记表本身是**真的**。**修一张图顺手毁掉台账**，
        #    比不修还坏。读不到旧清单时**拒绝写盘**（宁可让这张图白重建一次）。
        try:
            with open(manifest_path, encoding='utf-8') as f:
                prev = json.load(f)
            merged = dict(prev.get('files') or {})
            merged.update(manifest)
            print(f'  · 合并清单：原有 {len(prev.get("files") or {})} 条 + 本次 {len(manifest)} 条 = {len(merged)} 条')
            manifest = merged
        except Exception as e:                                     # noqa: BLE001
            print(f'  ✗ 读不到已有清单（{e}）—— **拒绝写盘**，免得把台账覆盖成 {len(manifest)} 条')
            sys.exit(2)

    with open(manifest_path, 'w', encoding='utf-8') as f:
        json.dump({
            'meta': {
                'note': '每个贴图的来源 / 许可 / 原始影像 / 分辨率 / 法线贴图',
                'sources': ['Solar System Scope (CC BY 4.0)', 'Celestia Content (NASA/USGS/JPL, GPL-2.0+)'],
            },
            'files': manifest,
        }, f, ensure_ascii=False, indent=1)

    print(f'=== 完成 {ok} 个，缺失 {miss} 个 → {os.path.relpath(OUT, ROOT)} ===')
    print(f'=== 贴图来源清单 → data/texture-manifest.json（{len(manifest)} 条）===')


if __name__ == '__main__':
    main()
