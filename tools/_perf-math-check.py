#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""离线自证：`probe-bloom-kernel-perf.py` 的 Python 侧算术与**传参关口**。

不开浏览器。用**出厂公式重建**五级核造一个**假的页面响应**，然后：
 ① σ_eff 必须对上上一轮**从活页面读回来**的值
    （1.359 / 2.451 / 3.534 / 4.616 / 5.696）—— 对不上说明公式抄错了；
 ② `prepare()` 这条**与 `run()` 完全相同的路径**必须能跑通
    —— 这一步就是为了把「dict / list 传错」挡在开浏览器之前
    （那种错在浏览器路径里会被驱动拆解吞掉，表现成「无声卡死」）；
 ③ **守卫会响**：把整个 dict 传进 `plan_for` 必须抛 `TypeError` 且带人话消息；
 ④ 抽头数代理量要与手算一致；
 ⑤ `design_selfproof` 必须过。

退出码：0 = 全过；1 = 有断言不过。
"""
import importlib.util
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location(
    'pbkp', os.path.join(HERE, 'probe-bloom-kernel-perf.py'))
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)

KS = [3, 5, 7, 9, 11]
RT = [(699, 429), (350, 215), (175, 108), (88, 54), (44, 27)]
LIVE_SIG = [1.359, 2.451, 3.534, 4.616, 5.696]     # shots/_bloom-kernel-perf.log 读回来的


def stock_coeffs(K):
    """出厂构造式逐字重建（`UnrealBloomPass.js:376-382`）：0.39894 * exp(-0.5 i^2 / K^2) / K。"""
    return [0.39894 * math.exp(-0.5 * i * i / (K * K)) / K for i in range(K)]


def fake_page_response():
    """形状与 `READ_KERNELS_JS` 的返回值**逐字段一致** —— 包括那个坑人的 `levels` 嵌套。"""
    return {
        'nMips': 5, 'strength': 0.72, 'radius': 0.6, 'threshold': 0.45,
        'bloom': True, 'programs': 22, 'calls': 1, 'triangles': 12345,
        'levels': [{'i': i, 'K': KS[i], 'len': KS[i], 'coeffs': stock_coeffs(KS[i]),
                    'rtWH': RT[i]} for i in range(5)],
    }


print('① σ_eff 重建 vs 活页面读回')
ok = True
resp = fake_page_response()
for i, lv in enumerate(resp['levels']):
    s = M.sigma_eff(lv['coeffs'])
    d = abs(s - LIVE_SIG[i])
    good = d < 0.002                      # 日志只打了 3 位小数
    ok &= good
    print(f'   第{i}级 K={KS[i]:>2}  重建 σ_eff={s:.4f}   读回={LIVE_SIG[i]:.3f}   '
          f'差={d:.5f}  {"✓" if good else "✗"}')
print(f'   ⇒ {"✓ 公式抄对了" if ok else "✗ 公式不对，先别开浏览器"}')

print('\n② prepare()（= run() 里那条路径）必须能跑通')
try:
    P = M.prepare(resp)
    print(f'   ✓ levels={len(P["levels"])} 级 · k0={P["k0"]} · 取样代理={P["fetch"]:,}')
    for k in ('levels', 'k0', 'rt', 'sig', 'fetch'):
        assert k in P, f'prepare 少返回了 {k}'
    print('   ✓ 五个键都在')
except Exception as e:
    ok = False
    print(f'   ✗ prepare 抛了：{type(e).__name__}: {e}')

# ---------------------------------------------------------------------------
# ②b 标尺不许跟着生产漂 ★ 2026-09-12 新增
# ---------------------------------------------------------------------------
# 背景：生产环境现在默认套用「丙」（`web/js/core/bloom-kernel.js`，
# mip2 K 7→12、mip3 9→15）。如果探针的 `prepare()` 照活页面取值，
# `ctrl` 锚点会**静默变成丙** —— 历史基线（6.90 ms / 取样 5,056,074）对不上，
# `wide-23` 与 `ctrl` 逐位相同（一档白测），`design_selfproof` 必红。
# 这条判据盯的就是那个漂移：**喂一份「生产口径」的响应，标尺必须仍然回到出厂。**
print('\n②b 标尺必须钉在出厂（喂「生产口径」响应，看它会不会跟着漂）')
PROD_K = [3, 5, 12, 15, 11]          # 生产现状：mip2=12、mip3=15
try:
    def prod_coeffs(i):
        if i in (2, 3):
            # 丙：σ 取出厂 σ_eff、K 加够到 3σ 截断（与 bloom-kernel.js 同式）
            se = M.sigma_eff(stock_coeffs(KS[i]))
            K = int(math.ceil(3.0 * se)) + 1
            return [math.exp(-0.5 * j * j / (se * se)) for j in range(K)]
        return stock_coeffs(KS[i])

    prod_resp = {
        'nMips': 5, 'strength': 0.72, 'radius': 0.6, 'threshold': 0.45,
        'bloom': True, 'programs': 24, 'calls': 1, 'triangles': 12345,
        'levels': [{'i': i, 'K': PROD_K[i], 'len': PROD_K[i], 'coeffs': prod_coeffs(i),
                    'rtWH': RT[i]} for i in range(5)],
    }
    Pp = M.prepare(prod_resp)
    chk = [
        ('prepare 仍按出厂 K 整理', Pp['k0'] == KS),
        ('取样代理量仍是出厂口径 5,056,074', Pp['fetch'] == 5056074),
        ('活页面 K 另存成 liveK 且 = 生产', Pp.get('liveK') == PROD_K),
        ('σ 取自出厂（不与生产混）', abs(Pp['sig'][2] - M.sigma_eff(stock_coeffs(7))) < 1e-12),
    ]
    kn, cn, _ = M.plan_for('none', prod_resp['levels'])
    chk.append(('plan_for("none") 写回的是**出厂**系数，不是丙的', kn == KS and all(
        abs(a - b) < 1e-12 for a, b in zip(cn[2], stock_coeffs(7)))))
    kk, cc, _ = M.plan_for('wide23', prod_resp['levels'])
    chk.append(('plan_for("wide23") 仍算出 K=12/15（与生产同值）', kk[2] == 12 and kk[3] == 15))
    for what, good in chk:
        ok &= good
        print(f'   {"✓" if good else "✗"} {what}')
    if not all(g for _, g in chk):
        print('   ⇒ ✗ 标尺跟着生产漂了 —— 修 `prepare()` / `plan_for()`，别去动被测的核。')
except Exception as e:
    ok = False
    print(f'   ✗ 抛了：{type(e).__name__}: {e}')

print('\n②c 级数不是 5 时必须**拒绝**（标尺绑在出厂 5 级上）')
try:
    M.plan_for('wide23', prod_resp['levels'][:4])
    ok = False
    print('   ✗ 4 级居然没抛 —— 标尺会静默套到错的级数上')
except ValueError as e:
    print(f'   ✓ 抛了 ValueError：{str(e)[:58]}…')

print('\n③ 守卫会响：把整个 dict 传进 plan_for 必须抛 TypeError')
for fn, name in ((M.plan_for, 'plan_for'), (M.design_selfproof, 'design_selfproof')):
    try:
        fn('none', resp) if name == 'plan_for' else fn(resp)
        print(f'   ✗ {name} 居然没抛 —— **守卫失效**，那个错又会被静默吞掉')
        ok = False
    except TypeError as e:
        print(f'   ✓ {name} 抛 TypeError：{str(e)[:88]}…')
    except Exception as e:
        print(f'   ⚠ {name} 抛的是 {type(e).__name__}（应该是 TypeError）：{e}')
        ok = False
try:
    M.prepare(P['levels'])
    print('   ✗ prepare 收下了 list —— 守卫失效')
    ok = False
except TypeError as e:
    print(f'   ✓ prepare 拒收 list：{str(e)[:70]}…')

print('\n④ 抽头数代理量：函数 vs 手算（每次 pass 2K−1，每级 X/Y 两趟）')
base = P['fetch']
for tag, _d, kind in M.CONFIGS:
    ks, _cs, note = M.plan_for(kind, P['levels'])
    f = M.fetch_proxy(ks, P['rt'])
    hand = sum(2 * (2 * k - 1) * (w * h) for k, (w, h) in zip(ks, P['rt']))
    good = hand == f
    ok &= good
    print(f'   {tag:<9} K={"/".join(map(str, ks)):<15} {f:>12,}  '
          f'{(f - base) / base * 100:>+7.1f}%  手算 {"✓" if good else "✗"}')
print('   ↳ 「预测帧时间」列 = 上面那列 × 0.25（假设泛光链占一帧 25%，**该假设由实测检验**）')

print('\n⑤ 设计自证（σ 相对容差 / K 真的动了）')
sp = M.design_selfproof(P['levels'])
print(f'   ⇒ {"✓ 过" if sp else "✗ 不过"}')
ok &= sp

print('\n⑥ σ 摘要')
for i in range(5):
    print(f'   第{i}级 出厂 σ_eff={P["sig"][i]:.4f}   3σ 需要的抽头数 K=⌈3σ⌉+1='
          f'{M.k_for(P["sig"][i], 3.0)}（出厂 {KS[i]}）')

print(f'\n总判定：{"✓ 全过 —— 可以开浏览器了" if ok else "✗ 有不过项，先修"}')
sys.exit(0 if ok else 1)
