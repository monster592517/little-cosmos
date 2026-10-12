# -*- coding: utf-8 -*-
"""
浏览器启动参数的**唯一来源**。

为什么有这个文件
====================================================================
坑 136 记过一件事：**有头 Chromium 的窗口被别的窗口盖住时**，Windows 的
`CalculateNativeWinOcclusion` 会判定它被遮挡，于是 Chromium 把渲染进程降级 ——
rAF 被节流、合成器不再出新帧。后果分两种长相：

  * `page.screenshot()` 要等一个新帧 ⇒ **永远等不到**（假死，30 秒超时）；
  * 整个探针卡在 `page.goto()` 之后等首帧那一步 ⇒ **没有任何输出地挂住**
    （2026-09-12 实测：`perf-probe.py` 卡了 4m39s）。

⚠️ 而且它**只会让读数偏慢**，所以症状看起来像「性能变差了」，
会把人引去查显卡 —— 归因抢跑。

后来发现更难看的一件事
====================================================================
坑 136 当时的做法是**在文档里列一个手写名单**（「这两个探针已带」），
于是「已固化」只对名单上写的成立。2026-09-12 全量扫了一遍：

    tools/*.py 里有头探针 20 个，带这三个开关的只有 3 个
    而且名单里点的那个文件名根本不存在

⇒ 这就是坑 149：**「手写名单」出现在文档里，就等于在文档里埋一个会烂的判据。**
解药是把常量抽到**单点定义**（本文件），再让每个探针 import 它。
**判据**：`node tools/check-occlusion-args.mjs` —— 它扫全仓库，报出「谁没带」。

用法
====================================================================
    from browser_args import OCCLUSION_ARGS
    browser = await pw.chromium.launch(headless=not HEADED, args=OCCLUSION_ARGS)

不需要动 `sys.path`：以 `python tools/xxx.py` 方式启动时，
脚本所在目录（`tools/`）本来就在 `sys.path[0]` 上。

**无头模式下加这三个开关是无害的**（无头本来就没有「窗口被遮挡」这回事），
所以调用点不必分无头/有头两种情况。
"""

# 让渲染循环无视「窗口被遮挡」状态。三条缺一不可：
#   ① --disable-backgrounding-occluded-windows  别把被遮挡的窗口「降为后台」
#   ② --disable-renderer-backgrounding          别把渲染进程降为后台
#   ③ --disable-features=CalculateNativeWinOcclusion  干脆别做这个判定
# 2026-09-12：在 RTX 3050 Ti 的机器上实测，加了之后 perf-probe 从
# 「卡在打开浏览器 4m39s」变成「22 秒跑完」，读数正常。
OCCLUSION_ARGS = [
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion',
]


def with_occlusion(args=None):
    """把遮挡开关并进一份已有的启动参数里（不修改传入的列表）。

    `args=None` 时只返回遮挡开关本身。
    """
    return list(args or []) + list(OCCLUSION_ARGS)
