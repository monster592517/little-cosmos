#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
宏观尺度「光斑」回归检查：自管服务生命周期 → 量点尺寸 → 断言 → 截图。

为什么必须单独有这个检查
------------------------
用户报的是「这个宏观图没法看，光斑太大了」。这类缺陷**任何现有检查都抓不到**：
  · 自检内核（server/lib/selfcheck.mjs）不碰渲染；
  · check-body-colors 只管颜色口径，不看几何尺寸；
  · check-scales 只管能切层级、能回收显存。
而「光斑」的本质是**可测量**的：点在世界坐标里的直径 ÷ 当前视高 = 屏幕占比。
所以这里把「多大算太大」写成阈值，不靠肉眼看截图。

判据
  · 点云 Points：**p90** > 10px 告警，> 24px 故障；另加「>40px 的点超过 5%」直接判故障
  · 光晕精灵 Sprite：按**各自**到相机的距离算屏幕占比，> 25% 视高告警，> 40% 故障

为什么用 p90 而不是 max（这条是被假故障教出来的）
  第一版检查里所有对象共用一个距离（相机到目标），结果星场壳（半径 900）和
  背景星系（120~520）被当成 7.8 单位处的物体算，凭空报出 274px / 494px / 1049px
  三个**根本没发生**的故障。现在改成逐点算距离。
  但即便逐点算，点云的 max 天生就是「离相机最近的那个点」，三维点云里
  总有离镜头很近的点，它投影大是几何必然而不是缺陷。
  所以要判的是**主体**糊没糊：p90 就是「绝大多数点长什么样」。
  另留一条硬判据（>40px 占 5% 以上）兜住「一大批点都很大」的情况。

阈值来历（数字是故障现场反推的，不是拍的）
  加法混合下，37px 的点乘 9000 个 = 整屏白雾（用户报的那张图）；
  softness 0.34 的辉光贴图**半径 49% 是死白**，366px 的精灵就是 212px 的死白盘；
  泛光阈值 0.7，亮度超过它的点会被再糊一层。
  ⇒ 所以「点 p90 > 24px」在这套叠加链路上已经不是"大"，而是"必糊"。
  阈值定在**默认取景**：用户报的就是默认视角下的观感。
  拉到很近去看单个星系，点按设计会变大，那是正常的。

用法：py -3.13 -X utf8 tools/check-macro.py [--port=8795] [--keep] [--no-shots] [--selftest]
退出码：0 = 全通过（--selftest 时：注入故障后**如期报错**才算通过）

--selftest 是「检查器自检」：把 supercluster 的星系点尺寸改回出故障的 0.26，
跑一遍**必须报故障**，然后原样还原。
理由：一个从不失败的检查等于没有检查——本项目已经吃过「自检假绿」的亏
（见 坑与雷点.md）。所以这里证明它真的看得见这个故障。
"""

import argparse
import asyncio
import os
import shutil
import subprocess
import sys
import time

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, "shots", "macro")

PORT = 8795
KEEP = False
WANT_SHOTS = True
SELFTEST = False

INJECT_FILE = os.path.join("web", "js", "levels", "supercluster.js")
INJECT_NEEDLE = "const GALAXY_DOT = 0.030;"
INJECT_VALUE = "const GALAXY_DOT = 0.26;"   # 用户报故障时的取值
"""注入式自检的**崩溃安全**约定（2026-09-11 踩出来的）：
  把「先写 sidecar 备份、再改源文件」当成硬规矩，启动时先自愈。

  为什么：那一轮我把 --selftest 作为**后台进程**跑，宿主在回合结束时直接把进程收走，
  finally 根本没执行 —— 磁盘上留下一个故意改坏的 GALAXY_DOT = 0.26。
  教训有两条，都要固化下来：
    (1) 会改仓库的检查**不能扔到后台**，必须在同一个回合内前台跑完；
    (2) 即便如此也不能只靠 finally —— 强杀（SIGKILL/进程树回收）不给任何清理机会。
       所以备份必须先落盘，且每次启动先做一遍自愈。
"""
INJECT_SIDECAR = ".inject-backup"

# 被检查的宏观层级（顺序即截图顺序；supercluster 是用户报的那一层，放第一个）
LEVELS = [
    ("supercluster", "室女座超星系团"),
    ("localgroup", "本星系群"),
    ("universe", "可观测宇宙"),
]

POINT_WARN_PX, POINT_BAD_PX = 10.0, 24.0
SPRITE_WARN_PCT, SPRITE_BAD_PCT = 25.0, 40.0

errors = []
checks = []


def emit(*a):
    print(*a, flush=True)


def ok(name, cond, extra=""):
    checks.append((bool(cond), name, extra))
    emit(f"  {'✓' if cond else '✗'} {name}{(' — ' + extra) if extra else ''}")


def warn(name, extra=""):
    emit(f"  ⚠ {name}{(' — ' + extra) if extra else ''}")


def find_node():
    """找一个真能跑的 node。

    不写死托管运行时路径——那个版本目录会被替换掉（曾遇到 22.22.2-2 被移除）。
    先问 PATH，再退到已知的托管/系统位置，最后才报错。
    """
    cands = [shutil.which("node"), shutil.which("node.exe")]
    home = os.path.expanduser("~")
    base = os.path.join(home, ".workbuddy", "binaries", "node", "versions")
    if os.path.isdir(base):
        for ver in sorted(os.listdir(base), reverse=True):
            cands.append(os.path.join(base, ver, "node.exe"))
    cands.append(r"C:\Program Files\nodejs\node.exe")
    for c in cands:
        if c and os.path.isfile(c):
            return c
    return None


async def wait_port(url, timeout=25.0):
    import urllib.request

    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                if r.status == 200:
                    return True
        except Exception:
            pass
        await asyncio.sleep(0.25)
    return False


MEASURE_JS = r"""
() => {
  const u = window.__universe;
  if (!u || !u.engine) return { error: 'window.__universe.engine 不存在' };
  const lv = u.engine.current;
  if (!lv) return { error: '当前没有层级' };
  const cam = lv.camera;
  const H = (u.engine.size && u.engine.size.h) || window.innerHeight;
  // three 的 PointsMaterial：gl_PointSize = size * scale / -mvPosition.z
  //   sizeAttenuation=true  → scale = H_draw / 2 → px = size * (H/2) / (dist * tan(fov/2))
  //   sizeAttenuation=false → gl_PointSize 直接用 size（framebuffer 像素）
  const k = H / (2 * Math.tan((cam.fov * Math.PI) / 360));
  const cp = cam.position;
  const e = new (cp.constructor)();
  const out = { id: lv.id, H, k: +k.toFixed(1), points: [], sprites: [] };

  const stats = (list) => {
    list.sort((a, b) => a - b);
    const q = (p) => list[Math.min(list.length - 1, Math.floor((list.length - 1) * p))];
    let o10 = 0, o24 = 0, o40 = 0;
    for (const v of list) {
      if (v > 40) o40++;
      else if (v > 24) o24++;
      if (v > 10) o10++;
    }
    const n = list.length;
    return { n, p50: q(0.5), p90: q(0.9), p99: q(0.99), max: list[n - 1],
             f10: o10 / n, f24: o24 / n, f40: o40 / n };
  };

  lv.scene.traverse((o) => {
    if (o.visible === false) return;

    if (o.isPoints && o.material && o.geometry && o.geometry.attributes.position) {
      const pos = o.geometry.attributes.position;
      const arr = pos.array, n = pos.count;
      const stride = Math.max(1, Math.ceil(n / 40000));   // 大点云抽样，够统计不卡
      const sz = o.material.size, atten = !!o.material.sizeAttenuation;
      o.updateWorldMatrix(true, false);
      const list = [];
      for (let i = 0; i < n; i += stride) {
        e.set(arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]).applyMatrix4(o.matrixWorld);
        list.push(atten ? (sz * k) / Math.max(1e-4, cp.distanceTo(e)) : sz);
      }
      out.points.push(Object.assign(
        { size: +sz.toFixed(4), atten, op: +(+o.material.opacity).toFixed(2) }, stats(list)));
    }

    if (o.isSprite) {
      // ⚠ 必须用**精灵自己**到相机的距离，不能用「相机到目标」那个距离：
      //   星场壳半径 900、背景星系在 120~520，用统一距离会把它们算大几十倍（假故障）。
      o.updateWorldMatrix(true, false);
      e.setFromMatrixPosition(o.matrixWorld);
      const d = Math.max(1e-4, cp.distanceTo(e));
      const s = Math.max(Math.abs(o.scale.x), Math.abs(o.scale.y));
      const px = (s * k) / d;
      out.sprites.push({ px: +px.toFixed(1), pct: +((100 * px) / H).toFixed(1),
                         op: +(+(o.material ? o.material.opacity : 1)).toFixed(2) });
    }
  });
  return out;
}
"""


def pct(seq, q):
    if not seq:
        return 0.0
    s = sorted(seq)
    i = min(len(s) - 1, max(0, int(round((len(s) - 1) * q))))
    return s[i]


async def wait_level(page, want, timeout_ms=60000):
    """轮询等引擎真的切到目标层级。

    绝不能用固定 sleep —— 软件渲染下帧率很低，引擎的过渡进度按每帧 dt 累加
    （上限 0.1s/帧），1.05s 的过渡在低帧率下要 3~6 秒真实时间。
    """
    t0 = time.monotonic()
    deadline = t0 + timeout_ms / 1000.0
    last = t0
    while time.monotonic() < deadline:
        try:
            cur = await page.evaluate("window.__universe.engine.current?.id")
        except Exception:
            cur = None
        if cur == want:
            return True, time.monotonic() - t0
        await page.wait_for_timeout(250)
        now = time.monotonic()
        if now - last >= 3.0:
            emit("      · 等过渡", "")
            last = now
    return False, time.monotonic() - t0


def repair_leftovers(verbose=True):
    """把上一次被掐断的注入还原回去 —— 每次启动先跑，属于自愈而不是可选步骤。

    判据不靠「sidecar 存在」这一条（正常收尾也会留 sidecar 直到搬走），
    而是**比内容**：sidecar ≠ 源文件 ⇒ 源文件被改脏过 ⇒ 还原。
    这样即使 sidecar 是上一次正常跑完残留的，也不会误判。
    """
    fixed = []
    side = os.path.join(ROOT, INJECT_FILE + INJECT_SIDECAR)
    src = os.path.join(ROOT, INJECT_FILE)
    if os.path.exists(side) and os.path.exists(src):
        with open(side, encoding="utf-8") as f:
            good = f.read()
        with open(src, encoding="utf-8") as f:
            cur = f.read()
        if cur != good:
            with open(src, "w", encoding="utf-8") as f:
                f.write(good)
            fixed.append(INJECT_FILE)
            if verbose:
                emit(f"  ⚠ 发现上一次注入被强杀留下的脏文件，已还原：{INJECT_FILE}")
        # sidecar 搬进隔离区（本机约定：不永久删除）
        try:
            trash = os.path.join(ROOT, ".trash")
            os.makedirs(trash, exist_ok=True)
            dst = os.path.join(trash, f"{os.path.basename(INJECT_FILE)}-inject-{int(time.time())}.bak")
            os.replace(side, dst)
            if verbose:
                emit(f"  · sidecar 已移入隔离区 {os.path.relpath(dst, ROOT)}")
        except Exception as ex:
            if verbose:
                emit(f"  ⚠ sidecar 搬运失败（不影响正确性）：{type(ex).__name__}: {ex}")
    return fixed


async def main():
    from playwright.async_api import async_playwright

    node = find_node()
    if not node:
        emit("✗ 找不到可用的 node，无法拉起服务")
        return 1
    if WANT_SHOTS:
        os.makedirs(SHOTS, exist_ok=True)

    base = f"http://127.0.0.1:{PORT}"
    emit("=== 小小宇宙 · 宏观尺度光斑回归 ===")
    emit(f"node      {node}")
    emit(f"服务      {base}（由本脚本自行拉起并收工关掉）")
    emit(f"判据      点 p90 > {POINT_WARN_PX:g}px 告警 / > {POINT_BAD_PX:g}px 故障"
         f"　精灵 > {SPRITE_WARN_PCT:g}% 视高告警 / > {SPRITE_BAD_PCT:g}% 故障")
    if SELFTEST:
        emit("模式      --selftest（注入故障，验证本检查真的能报出来）")
    emit("")

    # ---- 先自愈：上一次被强杀可能留下脏文件 ----
    repair_leftovers()

    # ---- 自检注入：故意把尺寸改回出故障的取值，期望检查报错 ----
    src_backup, src_path = None, os.path.join(ROOT, INJECT_FILE)
    if SELFTEST:
        with open(src_path, encoding="utf-8") as f:
            src_backup = f.read()
        hits = src_backup.count(INJECT_NEEDLE)
        if hits != 1:
            emit(f"✗ 注入失败：{INJECT_NEEDLE!r} 在 {INJECT_FILE} 里命中 {hits} 次（期望恰好 1 次）"
                 "—— 常量改名了？同步更新 INJECT_NEEDLE")
            return 1
        # 备份**先落盘**：这样即使下一行写盘后进程被强杀，下次启动还能自愈
        with open(src_path + INJECT_SIDECAR, "w", encoding="utf-8") as f:
            f.write(src_backup)
        with open(src_path, "w", encoding="utf-8") as f:
            f.write(src_backup.replace(INJECT_NEEDLE, INJECT_VALUE))
        emit(f"  · 已注入故障 {INJECT_FILE}：{INJECT_NEEDLE} → {INJECT_VALUE}")
        emit("  · 期望：supercluster 的「点云尺寸」判为故障\n")

    # 自检只跑被注入的那一层，省时间；正式跑跑全部
    levels = [l for l in LEVELS if l[0] == "supercluster"] if SELFTEST else LEVELS

    log_path = os.path.join(SHOTS, "server.log")
    logf = open(log_path, "w", encoding="utf-8", errors="replace") if WANT_SHOTS else subprocess.DEVNULL
    srv = subprocess.Popen(
        [node, os.path.join(ROOT, "server", "server.mjs"), f"--port={PORT}"],
        cwd=ROOT, stdout=logf, stderr=subprocess.STDOUT,
        # 别让这个临时服务器改写 data/.port：那会让自检的 svc.port 把
        # 「日常服务 8787」误判成「与记录不一致」——由测试工具自己制造的假告警。
        env={**os.environ, "LC_NO_PORT_RECORD": "1"},
    )
    exit_code = 0
    try:
        if not await wait_port(f"{base}/api/health"):
            emit("✗ 服务 25 秒内没起来；把 shots/macro/server.log 贴出来看根因")
            return 1
        emit("  ✓ 服务已就绪\n")

        async with async_playwright() as pw:
            browser = await pw.chromium.launch(
                args=["--enable-unsafe-swiftshader", "--use-gl=swiftshader"])
            page = await browser.new_page(viewport={"width": 1440, "height": 810})
            page.on("pageerror", lambda e: errors.append(f"PAGEERROR: {e}"))
            page.on("console", lambda m: errors.append(f"[console.error] {m.text}")
                    if m.type == "error" else None)

            t0 = time.monotonic()
            await page.goto(f"{base}/", wait_until="load", timeout=60000)
            try:
                await page.wait_for_function(
                    "document.getElementById('boot').style.display === 'none'", timeout=90000)
                emit(f"  ✓ 启动完成（{time.monotonic() - t0:.1f}s）")
            except Exception:
                status = await page.text_content("#boot-status")
                emit(f"  ✗ 启动超时，界面停在：{status}")
                errors.append(f"BOOT TIMEOUT: {status}")
                return 1
            await page.wait_for_timeout(1200)

            for sid, label in levels:
                emit("")
                emit(f"■ {label}（{sid}）")
                await page.evaluate(f"window.__universe.gotoScale('{sid}')")
                got, secs = await wait_level(page, sid)
                if not got:
                    ok(f"{label} 能切过去", False, f"{secs:.1f}s 内没切到")
                    errors.append(f"LEVEL {sid} 切换超时")
                    continue
                # 过渡结束后再等几帧稳定，避免量到过渡中途的相机位姿
                await page.wait_for_timeout(1500)

                m = await page.evaluate(MEASURE_JS)
                if m.get("error"):
                    ok(f"{label} 可测", False, m["error"])
                    errors.append(f"MEASURE {sid}: {m['error']}")
                    continue

                emit(f"  画布高 {m['H']}px · 距离→像素系数 {m['k']}px（d 单位处的物体会被放大 {m['k']:.0f}/d 倍）")

                # ---- 点云 ----
                if m["points"]:
                    for p in sorted(m["points"], key=lambda x: -x["p90"]):
                        bad = p["p90"] > POINT_BAD_PX or p["f40"] > 0.05
                        wn = p["p90"] > POINT_WARN_PX or p["f24"] > 0.02
                        flag = "✗" if bad else ("⚠" if wn else "·")
                        emit(f"    {flag} 点云 {p['n']:>7,} 个 · 尺寸 {p['size']:<8g} "
                             f"衰减={'是' if p['atten'] else '否'} · 不透明 {p['op']:<5g} · "
                             f"屏幕 p50 {p['p50']:.1f} / p90 {p['p90']:.1f} / p99 {p['p99']:.1f} / "
                             f"max {p['max']:.0f}px · >24px 占 {p['f24'] * 100:.2f}%")
                    worst = max(m["points"], key=lambda x: x["p90"])
                    why = (f"p90 {worst['p90']:.1f}px > {POINT_BAD_PX:g}px"
                           + (f"，且 {worst['f40'] * 100:.1f}% 的点 > 40px" if worst["f40"] > 0.05 else "")
                           + "（加法混合下必糊成白斑）")
                    if worst["p90"] > POINT_BAD_PX or worst["f40"] > 0.05:
                        ok(f"{label} 点云尺寸", False, why)
                        errors.append(f"POINT TOO BIG {sid}: p90={worst['p90']:.1f}px")
                    elif worst["p90"] > POINT_WARN_PX or worst["f24"] > 0.02:
                        warn(f"{label} 点云尺寸偏大",
                             f"p90 {worst['p90']:.1f}px · >24px 占 {worst['f24'] * 100:.2f}%")
                        ok(f"{label} 点云尺寸", True, f"p90 {worst['p90']:.1f}px（告警级）")
                    else:
                        ok(f"{label} 点云尺寸", True, f"p90 {worst['p90']:.1f}px")
                else:
                    ok(f"{label} 有可测的点云", False, "场景里一个 Points 都没有")

                # ---- 精灵 ----
                sp = m["sprites"]
                if sp:
                    pxs = sorted(s["px"] for s in sp)
                    maxpct = max(s["pct"] for s in sp)
                    bad = [s for s in sp if s["pct"] > SPRITE_BAD_PCT]
                    wn = [s for s in sp if s["pct"] > SPRITE_WARN_PCT]
                    emit(f"    · 精灵 {len(sp)} 个 · 屏幕尺寸 中位 {pct(pxs, .5):g}px / "
                         f"p90 {pct(pxs, .9):g}px / 最大 {pxs[-1]:g}px · 最大占视高 {maxpct:g}%")
                    if bad:
                        ok(f"{label} 精灵尺寸", False,
                           f"{len(bad)} 个超过 {SPRITE_BAD_PCT:g}% 视高，最大 "
                           f"{max(s['pct'] for s in bad):g}%")
                        errors.append(f"SPRITE TOO BIG {sid}: {len(bad)} 个")
                    elif wn:
                        warn(f"{label} 精灵尺寸偏大", f"{len(wn)} 个超过 {SPRITE_WARN_PCT:g}% 视高")
                        ok(f"{label} 精灵尺寸", True, f"最大 {maxpct:g}% 视高（告警级）")
                    else:
                        ok(f"{label} 精灵尺寸", True, f"最大 {maxpct:g}% 视高")
                else:
                    emit("    · 无精灵（本层只用点云/网格，符合预期）")
                    ok(f"{label} 精灵尺寸", True, "无精灵")

                if WANT_SHOTS:
                    path = os.path.join(SHOTS, f"{sid}.png")
                    await page.screenshot(path=path)
                    emit(f"    · 截图 {os.path.relpath(path, ROOT)}")

            await browser.close()
    finally:
        # 无论中途怎么退出，注入的源文件都必须还原——否则会留下一个坏掉的仓库。
        # 走 repair_leftovers() 同一条代码路径：这样「自愈」这条路径每次 --selftest
        # 都会被真正执行一遍，而不是只有出事那天才第一次生效。
        if src_backup is not None:
            try:
                repair_leftovers(verbose=False)
                with open(src_path, encoding="utf-8") as f:
                    restored = f.read()
                if restored == src_backup:
                    emit(f"\n  · 已还原 {INJECT_FILE}（字节一致）")
                else:
                    emit(f"\n  ✗ 还原后内容不一致！{INJECT_FILE} 需要人工检查（git diff）")
                    errors.append(f"RESTORE MISMATCH {INJECT_FILE}")
            except Exception as ex:
                emit(f"\n  ✗ 还原 {INJECT_FILE} 失败：{type(ex).__name__}: {ex}")
                errors.append(f"RESTORE FAILED {INJECT_FILE}: {ex}")
        if KEEP:
            emit(f"\n(--keep) 服务保留在 {base}，PID {srv.pid}")
        else:
            try:
                srv.terminate()
                srv.wait(timeout=8)
            except Exception:
                try:
                    srv.kill()
                except Exception:
                    pass
        try:
            if logf not in (None, subprocess.DEVNULL):
                logf.close()
        except Exception:
            pass

    emit("")
    emit("=== 页面错误 ===")
    if errors:
        for e in errors[:20]:
            emit("  " + e)
    else:
        emit("  （无）")

    npass = sum(1 for c, _, _ in checks if c)
    nfail = len(checks) - npass
    emit("")
    emit(f"结果：{npass} 通过 / {nfail} 未通过")
    for c, n, ex in checks:
        if not c:
            emit(f"  ✗ {n} — {ex}")

    if SELFTEST:
        # 自检模式：唯一要证明的是「注入故障之后，检查真的报出来了」
        caught = [n for c, n, _ in checks if not c and "点云尺寸" in n]
        emit("")
        emit("=== 检查器自检 ===")
        ok("注入故障后确实报出了「点云尺寸」故障", bool(caught),
           ("命中 " + "、".join(caught)) if caught
           else "**没报出来 —— 这个检查是假绿的，等于没有检查**")
        return 0 if caught else 1

    if nfail or errors:
        exit_code = 1
    return exit_code


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8795)
    ap.add_argument("--keep", action="store_true", help="跑完不关服务（排障用）")
    ap.add_argument("--no-shots", action="store_true", help="不写截图与服务日志")
    ap.add_argument("--selftest", action="store_true",
                    help="注入故障以验证本检查真的能报错（会临时改 supercluster.js，跑完还原）")
    ap.add_argument("--restore", action="store_true",
                    help="只做还原：把上次被强杀留下的注入脏文件恢复后退出")
    a = ap.parse_args()
    PORT = a.port
    KEEP = a.keep
    WANT_SHOTS = not a.no_shots
    SELFTEST = a.selftest

    if a.restore:
        print("=== 还原注入残留 ===", flush=True)
        fixed = repair_leftovers()
        print(("  · 已还原 " + "、".join(fixed)) if fixed else "  · 没有残留，无需还原", flush=True)
        sys.exit(0)
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        sys.exit(130)
