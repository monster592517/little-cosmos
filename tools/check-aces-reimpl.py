#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""自证：`probe-galaxy-visual.py` 里的 ACES 复刻 == vendor 里的原式。

为什么必须有这个
----------------
第六节报出来的「核区线性峰值」是后面所有取舍的输入
（核球该降几倍、R_e 要不要改、白斑能不能消掉）。
**反演公式错了，等于拿一把刻度错的尺子量血压。**
而且这种错不会报错、不会崩，只会安静地给出一个看起来挺像样的数字。

判据（每条都要**两段式**：先证明它对，再证明它错会响）
  ① 正演复刻：与 `tools/aces-ref.mjs` **现算**出来的参考值逐用例比，差 >0.05 码值即失败。
  ② 反演自证：正演 → 反演 → 必须拿回原线性值，相对误差 >2% 即失败。
  ③ 换算表：把决策要用的几个「线性 ↔ 码值」换算打出来，供人工核对。

⚠️ 参考值**每次现算**（先跑 node 生成器），不读旧文件 —— 跟陈旧基线比等于自欺。
用法：py -3.13 -X utf8 tools/check-aces-reimpl.py
退出码：0 = 全过；1 = 有失败（可以直接接进自检）。
"""
import importlib.util
import json
import os
import subprocess
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REF = os.path.join(ROOT, 'tools', 'aces-ref.json')


def load_probe():
    spec = importlib.util.spec_from_file_location(
        'pgv', os.path.join(ROOT, 'tools', 'probe-galaxy-visual.py'))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def regen_ref():
    """现算参考值。node 路径优先用项目自带的运行时，找不到再退回 PATH。"""
    node = None
    for cand in (os.path.join(ROOT, 'runtime', 'node.exe'), 'node'):
        try:
            r = subprocess.run([cand, '--version'], capture_output=True, timeout=20)
            if r.returncode == 0:
                node = cand
                break
        except Exception:
            continue
    if node is None:
        print('  ✗ 找不到 node，无法现算参考值 ⇒ 拒绝拿旧文件当基线。')
        return False
    r = subprocess.run([node, os.path.join(ROOT, 'tools', 'aces-ref.mjs')],
                       capture_output=True, cwd=ROOT, timeout=60)
    out = r.stdout.decode('utf-8', 'replace').strip()
    if r.returncode != 0:
        print('  ✗ 生成参考值失败：' + r.stderr.decode('utf-8', 'replace')[:300])
        return False
    print(out)
    return os.path.exists(REF)


def main():
    pgv = load_probe()
    if not regen_ref():
        return 1
    cases = json.load(open(REF, encoding='utf-8'))

    # ① 正演复刻
    fail, worst = 0, 0.0
    for c in cases:
        mine = pgv.aces_forward(np.array(c['lin'], 'float32'), c['exposure'], np) * 255.0
        d = float(np.abs(mine - np.array(c['code'], 'float32')).max())
        worst = max(worst, d)
        if d > 0.05:
            fail += 1
            print(f'  ✗ 曝光 {c["exposure"]} 线性 {c["lin"]} → 我 {mine.round(3)} '
                  f'vs 参考 {[round(x, 3) for x in c["code"]]}  差 {d:.4f}')
    print(f'① 正演复刻：{len(cases)} 个用例，最大差 {worst:.6f} 码值，失败 {fail} 个')

    # ② 反演自证
    # 两个**合法**跳过条件，都要写明白 —— 否则「跳过」会变成「掩盖」：
    #   · 码值贴顶(≥254.5) ⇒ 被 `saturate` 削平，反演出来的是下界；
    #   · 码值全 0 ⇒ `RRTAndODTFit` 在 x<0.00325 处为负、被压成纯黑，信息已经没了。
    #     这是**函数的性质**，不是反演的错。
    inv_fail, inv_worst, skipped = 0, 0.0, 0
    for c in cases:
        if max(c['code']) >= 254.5 or max(c['code']) <= 0.0:
            skipped += 1
            continue
        lin, res, hit = pgv.aces_invert(c['code'], c['exposure'], np)
        rel = float(np.abs(np.array(lin, 'float32') - np.array(c['lin'], 'float32')).max()
                    / max(np.array(c['lin'], 'float32').max(), 1e-9))
        inv_worst = max(inv_worst, rel)
        if rel > 0.02:
            inv_fail += 1
            print(f'  ✗ 曝光 {c["exposure"]} 码值 {[round(x, 2) for x in c["code"]]} '
                  f'→ 反演 {lin.round(4)}，真值 {c["lin"]}，相对误差 {rel * 100:.2f}%')
    print(f'② 反演自证：最大相对误差 {inv_worst * 100:.3f}%，失败 {inv_fail} 个'
          f'（按函数性质跳过 {skipped} 个削平/压黑用例）')

    # ③ 决策要用的换算表
    print('③ 线性 → 码值（曝光 1.05，本项目实际用的一档）：')
    for v in [0.18, 0.359, 0.5566, 0.85, 1.0, 1.75, 2.0, 2.7, 4.0, 8.0]:
        code = float(pgv.aces_forward(np.array([v] * 3, 'float32'), 1.05, np).mean()) * 255.0
        print(f'     线性 {v:>7} → 码值 {code:>6.2f}')
    print('     码值 255 是**不可达**的（ACES 末端是 saturate）'
          '⇒ 「贴顶」只能说明线性 ≥4，不能说明具体多大。')

    ok = not (fail or inv_fail)
    print('结论：' + ('两段都过 ✅' if ok else '有失败 ❌ —— 第六节的线性值不可用'))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
