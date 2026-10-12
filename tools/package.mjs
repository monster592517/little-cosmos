#!/usr/bin/env node
/**
 * 一键打包：把整个工程整理成「解压即用」的便携包。
 *
 *   · 自动下载官方 Node.js 运行时（只取 node.exe）放进 runtime/，目标机器无需安装 Node
 *   · 只复制运行必需的文件（源码 / 贴图 / 数据集 / 启动器），排除原始素材与缓存
 *   · 生成 使用说明.txt 与 zip 压缩包（Windows 自带 tar 或 Compress-Archive）
 *
 * 用法：node tools/package.mjs [--no-runtime] [--out=<目录>] [--no-zip]
 */
import { mkdir, copyFile, writeFile, readdir, stat, rm, rename } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_VERSION = 'v24.19.0';
const RUNTIME_CACHE = path.join(ROOT, 'data', 'raw', 'runtime', 'node.exe');
const NAME = '小小宇宙';
const args = process.argv.slice(2);
const noRuntime = args.includes('--no-runtime');
const noZip = args.includes('--no-zip');
const outArg = args.find((a) => a.startsWith('--out='));
const OUT = outArg ? path.resolve(outArg.slice(6)) : path.join(ROOT, 'dist');
const STAGE = path.join(OUT, NAME);

/* ---------- 1. 运行时 ---------- */
async function ensureRuntime() {
  if (noRuntime) return false;
  try { await stat(RUNTIME_CACHE); console.log('  · 运行时已缓存'); return true; } catch { /* 需下载 */ }
  const url = `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-win-x64.zip`;
  console.log(`  下载 Node.js ${NODE_VERSION} 运行时…`);
  await mkdir(path.dirname(RUNTIME_CACHE), { recursive: true });
  const tmpZip = path.join(path.dirname(RUNTIME_CACHE), 'node-runtime.zip');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  await writeFile(tmpZip, Buffer.from(await res.arrayBuffer()));
  console.log(`  解压 node.exe …`);
  execFileSync('tar', ['-xf', tmpZip, '-C', path.dirname(RUNTIME_CACHE), '--strip-components=1',
    `node-${NODE_VERSION}-win-x64/node.exe`], { stdio: 'inherit' });
  await rm(tmpZip, { force: true });
  await stat(RUNTIME_CACHE);
  return true;
}

/* ---------- 2. 复制 ---------- */
/**
 * 不打包进去的东西。前四条是「体积大 / 没用」，后三条是**防呆**：
 *   · `.trash` 是隔离区，里面放着改名和清理时的旧文件；
 *   · `logs` 是本机运行日志，对别人没有意义，还会泄露路径；
 *   · `.workbuddy` 是外部工具的工作区数据，跟本程序无关。
 * 这三条只靠"我复制的时候没列它"来保证是不够的——哪天有人在这加一个 `copyTree(ROOT)`，
 * 隔离区就跟着发布出去了。写进排除表才算真的排除。
 */
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'shots', 'raw', '.cache', '.git', 'runtime',
  '.trash', 'logs', '.workbuddy',
]);

/** 用 Python 的 `zipfile` 打包，并在**同一个进程里读回自检**。
 *
 * ⚠️★ 这里换过三次工具，别再改回去了（2026-09-15）。两个硬要求，缺一个就不叫「解压就能跑」：
 *
 *   ① **非 ASCII 名必须带 UTF-8 通用标志位（bit 11）**
 *      否则在**非中文 Windows** 上，解压器按本地代码页去解 ⇒ `小小宇宙/` 变成 `╨í╨í╙ε╓µ/`
 *      （实测读数）。用户拿到一个乱码名的文件夹。
 *   ② **必须写目录条目**
 *      否则老解压器会报错、或把文件落到错误的位置。
 *
 *   实测各家表现（都真跑过）：
 *     · PATH 上的 GNU tar（Git Bash）—— 把 `C:\...` 当**远程主机**，直接失败
 *     · Windows 自带 bsdtar            —— 目录条目 ✓ · **UTF-8 标志位 ✗**
 *     · PowerShell `Compress-Archive`  —— **目录条目 ✗**（整包只有 2 个空目录）· 标志位 ✓
 *     · Python `zipfile`               —— **两个都对** ✓✓
 *
 * ⚠️ 为什么自检必须在这里做：「目录名在别的机器上乱码」这个故障**在作者机器上完全看不见**
 *    —— 中文 Windows 的资源管理器按 GBK 解无标志位的中文名，看起来一切正常。
 *    只有读 zip 元数据才能发现。这条自检当场就抓到过一次我自己引入的回归。 */
const PY_ZIP = `
import sys, os, zipfile
stage, out = sys.argv[1], sys.argv[2]
root = os.path.dirname(stage.rstrip(os.sep))
name = os.path.basename(stage.rstrip(os.sep))
if os.path.exists(out):
    os.remove(out)
z = zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9)
z.write(stage, name + '/')
for dirpath, dirnames, filenames in os.walk(stage):
    dirnames.sort()
    filenames.sort()
    for d in dirnames:
        full = os.path.join(dirpath, d)
        z.write(full, os.path.relpath(full, root).replace(os.sep, '/') + '/')
    for f in filenames:
        full = os.path.join(dirpath, f)
        z.write(full, os.path.relpath(full, root).replace(os.sep, '/'))
z.close()

# ---- 打包后读回自检（作者机器上肉眼看不出来的那两条）----
zz = zipfile.ZipFile(out)
names = zz.namelist()
non = [n for n in names if any(ord(c) > 127 for c in n)]
noflag = [n for n in non if not (zz.getinfo(n).flag_bits & 0x800)]
dirs = [n for n in names if n.endswith('/')]
files = [n for n in names if not n.endswith('/')]
print('  · 条目 %d（文件 %d + 目录 %d）· 非 ASCII 名 %d 个' % (len(names), len(files), len(dirs), len(non)))
if noflag:
    print('  X FATAL: %d 个非 ASCII 名**没有** UTF-8 标志位 => 英文 Windows 上会解成乱码。样例: %s'
          % (len(noflag), noflag[:3]))
    sys.exit(2)
if len(dirs) < 5:
    print('  X FATAL: 目录条目只有 %d 个 => 老解压器可能出错' % len(dirs))
    sys.exit(2)
for must in [name + '/START.bat', name + '/runtime/node.exe', name + '/web/index.html', name + '/data/stars.json']:
    if must not in names:
        print('  X FATAL: 包里缺 %s' % must)
        sys.exit(2)
print('  OK  UTF-8 标志位 · 目录条目 · 四个必需文件 都在')
`;

async function copyTree(src, dst) {
  const s = await stat(src);
  if (s.isFile()) {
    await mkdir(path.dirname(dst), { recursive: true });
    await copyFile(src, dst);
    return 1;
  }
  let n = 0;
  for (const e of await readdir(src, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    if (e.isFile() && e.name.endsWith('.bak')) continue;
    n += await copyTree(path.join(src, e.name), path.join(dst, e.name));
  }
  return n;
}

const README = `小小宇宙 · 便携版（v1.2.0）
========================================

【怎么用】
  1. 把整个「小小宇宙」文件夹解压到一个**普通可写目录**（桌面 / D:\ 都行）
     ⚠️ 必须先「全部解压」再运行。直接在压缩包里双击里面的文件是**跑不起来**的
        —— 它会被解到临时目录，那里写不了数据。启动器会检测到并明确提示。
  2. 双击「START.bat」
     ⚠️ 这个名字是**故意用英文的**：解压工具对压缩包里的中文名处理不一致，
        老版本可能把中文名解成乱码，那样就找不到启动器了。其余文档保持中文名。
  3. 会自动打开一个独立应用窗口（没有地址栏），直接就能用

  首次打开需要几秒启动本地服务；服务窗口（标题为 Little Cosmos Server）最小化在任务栏，
  关闭它就等于停止服务。想换端口：编辑启动器里的 set PORT=8787。

【需要什么】
  · Windows 10 / 11 64 位
  · 一个 Chromium 内核浏览器：Edge（系统自带）或 Chrome
  · 不需要安装 Node.js —— 运行时已经打包在 runtime\\node.exe 里
  · 联网只在两处需要：论文检索、以及「数据更新中心」抓上游数据。其余功能完全离线。

【六个尺度，一路拉远】
  太阳系 → 邻近恒星系 → 银河系 → 本星系群 → 室女座超星系团 → 可观测宇宙

  每个层级有独立的场景与长度单位（从 1 AU 到 10 亿光年，跨 20 个数量级），
  靠在界面里连续拉远 / 拉近切换。四种切层方式任选：
    · 顶部尺度条直接点
    · 右下角 ⤢ / ⤡ 按钮
    · PageUp 拉远 / PageDown 拉近
    · 把滚轮一直拉到底（顶到本层边界后会累计，攒够就跨层）
  跨尺度是通的：在太阳系里搜「仙女座星系」，会先切到本星系群层再聚焦它。

【有什么功能】
  · 253 个太阳系天体全部有 3D 模型：太阳、八大行星、5 颗矮行星、156 颗卫星、
    86 个小天体（主带 / 特洛伊 / 半人马 / 柯伊伯带 / 彗星 / 星际天体）
  · 位置全部由 astronomy-engine 实时计算（VSOP87 / ELP2000 / 木卫模型），与真实天象对应
  · 恒星与深空：邻近恒星系层 10.9 万颗恒星（HYG v41），深空目录 12,950 条（OpenNGC）
  · 目录树：卫星与行星环挂在各自母行星下；小行星带收录带内天体；彗星与星际天体单独成组
  · 探测器：在轨的画出轨道，着陆的标在着陆点，飞向星际的画出真实飞行轨迹
  · 每个天体的详细属性、发现与探测历史、内部结构、3D 建模与影像来源（含授权）
  · 论文检索：arXiv / OpenAlex / Crossref / Semantic Scholar 四源聚合
  · 数据更新中心：14 个数据源状态 + 4 条更新管线，点一下就重抓数据
  · 科研监测：按 9 个高风险主题盯 arXiv 新论文，产出待你拍板的数据修正线索
  · 中文翻译：优先用浏览器内置翻译（离线、不联网、不花钱），不行才回退公共翻译接口
  · 进展简报：本地抽取式摘要，不需要任何 API Key

【显卡不用担心】
  启动时自动探测显卡（Intel / AMD / NVIDIA / Apple / Qualcomm / Microsoft，独显 / 核显 / 软件渲染），
  据此选一个起始画质档位。三档画质：省电 / 均衡 / 高质量。三种 GPU 偏好：自动 / 省电 / 高性能。
  两项省电开关：
    · 离开页面时暂停渲染 —— 切到别的窗口就完全停帧，把显卡让给前台程序。强烈建议保持开启。
    · 帧率上限 —— 限制每秒最多渲染多少帧，进一步压低功耗与发热。
  另外还有两道保险：显存回收（只保留当前层与相邻层，其余彻底释放）与自动降档（帧率持续偏低时降档；
  手动锁定过档位就不会被擅自改掉）。

【更新数据 / 盯最新研究】
  设置面板 →「数据更新中心」（或按 Ctrl + K 搜「更新」）：
    ① 看状态：14 个数据源各自的条目数、体积、最后构建时间（实时读取，不是缓存字段）
    ② 一键更新：按管线为单位重抓（core / deepsky / textures / gallery），日志逐行实时回传；
       任一步失败即中止，原有数据保持不变
    ③ 盯前沿：按监测主题检索 arXiv 最新预印本
    ④ 人拍板：采纳的结论写入 overrides，可撤销。自动流程永远不会直接改写程序数据。

  注意：数据更新需要联网，且会下载几十 MB 到上百 MB 的上游数据，视管线而定。

【翻译说明】
  翻译有三条路，程序会自动选：
    ① 浏览器内置翻译（Chrome / Edge 138+ 的 Translator API）——本地模型，完全离线
    ② 本地服务代理的公共翻译接口（Google / MyMemory，均无需密钥）
    ③ 每条论文右下角的「整页翻译」——交给浏览器自带的网页翻译

【常见问题】
  · 双击没反应 / 出现「请按任意键继续」：看同目录的 launch-log.txt，那里写了每一步的结果。
    三种最常见：① 解压没完成（runtime 文件夹里的 node.exe 缺了，或大小不对）
                ② 杀毒软件 / Windows SmartScreen 拦了它（未签名的 88MB 程序）
                ③ 从压缩包里直接双击（没先解压）
  · 实在不行：装一个 Node 18+ 再双击 START.bat，会自动改用系统 Node
  · 页面空白：等一下（首次加载贴图较慢），或按 F5 刷新；显存太小的老机器请把画质调到「省电」
  · 卡顿 / 风扇狂转：设置面板里锁「省电」，并保持「离开页面时暂停渲染」开启
  · 高分辨率屏幕字太小：浏览器里按 Ctrl + 加号 放大
  · 数据想恢复到出厂状态：删掉 data\\overrides.json（只影响人工修正，不影响原始数据）
  · 重新生成数据集：删掉 data\\stars.json 后重新双击启动器，会自动重建

【出问题了怎么办】
  · 界面里：设置 → 打开数据更新中心 → 滚到最底「系统自检」→ 运行自检
    六组检查（运行环境 / 程序骨架 / 数据集与登记表 / 人工覆盖 / 本地服务 / 命名一致性），
    每一项都直接告诉你该怎么做。
  · 界面看不到时（比如页面根本打不开）：在本文件夹开个终端跑
      runtime\\node.exe tools\\selfcheck.mjs
    它不依赖服务，能读盘就能跑。加 --json 出机器可读结果。
  · 想干活痕迹：设置 → 数据更新中心 →「查看近期日志」；
    日志文件在 logs\\server-年-月-日.jsonl，保留 14 天。
  · 想查踩过的坑：看「坑与雷点.md」，每条都标了「固化成什么了」。

【随包的文档】
  README.md                  项目全貌
  操作手册.md                界面怎么用 / 参数什么意思 / 边界在哪（建议先读第 6 章「做不到什么」）
  自检维修手册.md            按症状查：症状 → 判据 → 根因 → 处置，每条都给可执行命令
  坑与雷点.md                踩过的坑，逐条标注是否已固化成测试或脚本
  README.md（原《参考资料-开源项目与数据源.md》）
  坑与雷点.md（原《对话记录.md》） / 自检维修手册.md（原《审计报告-数据正确性.md》）

【目录结构】
  启动小小宇宙.bat   启动器
  runtime/          便携 Node.js 运行时（无需另装 Node）
  server/           本地服务（零第三方依赖）+ 论文检索 / 翻译 / 数据更新中心 / 日志 / 自检
  web/              前端（three.js 场景、界面、贴图、影像）
  data/             数据集与登记表（恒星表、系外行星、小天体、深空目录、影像索引、数据源登记、覆盖表）
  tools/            数据抓取、校验与自检脚本（可选，需要 Node / Python 才能跑）
  assets/           图标
  logs/             运行日志（首次启动后生成）
`;

/* ---------- 0. 清空暂存目录 ---------- */
/**
 * 清空 `dist/小小宇宙`。
 *
 * 这里**优先改名而不是递归删除**，理由有三：
 *   1. 改名是 O(1) 的元数据操作；递归删除要走过 650+ 个文件。
 *   2. 实测遇到过一次 `rm(STAGE, {recursive:true})` **永久卡死**：
 *      进程存活、但 CPU 时间 11 分钟零增长；文件并没有被锁（`runtime/node.exe` 能独占打开）；
 *      同一目录改名**瞬间成功**；换成不删任何东西直接重跑，全程 30 秒跑完。
 *      用合成的目录树（含中文目录名、含 20MB 大文件）**复现不出来** → 成因未确定，
 *      记为待查（见「坑与雷点.md」坑 28）。既然改名一定能走通，就别让打包卡在一个说不清的地方。
 *   3. 顺带留了一份「上一版暂存目录」，出问题可对照/回滚。
 *
 * 副作用：旧暂存目录会留在 `.trash/` 里（`.trash` 不进发布包，可随时手动清）。
 */
async function clearStage() {
  let exists = false;
  try { await stat(STAGE); exists = true; } catch { /* 不存在，最省事 */ }
  if (!exists) return;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = path.join(ROOT, '.trash', `old-stage-${stamp}`);
  try {
    await mkdir(path.dirname(dest), { recursive: true });
    await rename(STAGE, dest);
    console.log(`  · 旧暂存目录已移入隔离区：.trash/old-stage-${stamp}`);
  } catch (e) {
    console.log(`  ! 改名失败（${e.code || e.message}），退回递归删除`);
    console.log('    若这行之后再无输出，就是卡在删除这一步 —— 见「坑与雷点.md」坑 28');
    await rm(STAGE, { recursive: true, force: true });
  }
}

async function main() {
  console.log('=== 打包小小宇宙 ===');
  console.log(`输出目录：${OUT}`);
  console.log('[0/4] 清空暂存目录');
  await clearStage();
  await mkdir(STAGE, { recursive: true });

  console.log('[1/4] 准备 Node 运行时');
  const hasRuntime = await ensureRuntime();
  if (hasRuntime) {
    await mkdir(path.join(STAGE, 'runtime'), { recursive: true });
    await copyFile(RUNTIME_CACHE, path.join(STAGE, 'runtime', 'node.exe'));
    console.log('  ✓ runtime/node.exe');
  } else {
    console.log('  · 跳过（启动器将使用系统 Node）');
  }

  console.log('[2/4] 复制工程文件');
  let count = 0;
  for (const dir of ['server', 'web', 'tools', 'assets']) {
    count += await copyTree(path.join(ROOT, dir), path.join(STAGE, dir));
  }
  await mkdir(path.join(STAGE, 'data'), { recursive: true });
  for (const f of await readdir(path.join(ROOT, 'data'))) {
    if (!f.endsWith('.json')) continue;
    await copyFile(path.join(ROOT, 'data', f), path.join(STAGE, 'data', f));
    count++;
  }
  /* ⚠️ 启动器在包里改成 **ASCII 名**（2026-09-15，为了「不论什么电脑都能跑」）。
   *
   * 为什么只改它一个：包顶层有 8 个非 ASCII 文件名，而**解压器对 zip 里 UTF-8 名字的处理并不一致**
   * —— 老版 WinRAR / 部分国产解压工具会按本地代码页去解，名字就乱了。另外 7 个是文档与使用说明，
   * 乱码只影响阅读；**启动器是唯一必须被用户找到的那个**，所以只有它必须 ASCII。
   *
   * ⚠️ 脚本内容里**没有任何地方引用自己的文件名**（已核，它只用 `%~dp0` 定位自己所在目录），
   *    所以改名是安全的。
   * ⚠️ 源码目录里它仍叫 `启动小小宇宙.bat`（桌面快捷方式指着它），**只有包内改名**。 */
  const TOP_FILES = [
    ['启动小小宇宙.bat', 'START.bat'],
    ['README.md', 'README.md'],
    ['操作手册.md', '操作手册.md'],
    ['自检维修手册.md', '自检维修手册.md'],
    ['坑与雷点.md', '坑与雷点.md'],
    ['坑与雷点.md', '坑与雷点.md'],
    ['自检维修手册.md', '自检维修手册.md'],
    ['README.md', 'README.md'],
  ];
  for (const [src, dst] of TOP_FILES) {
    await copyFile(path.join(ROOT, src), path.join(STAGE, dst));
    count++;
  }
  console.log(`  ✓ ${count} 个文件`);

  console.log('[3/4] 写使用说明');
  await writeFile(path.join(STAGE, '使用说明.txt'), '\ufeff' + README.replace(/\n/g, '\r\n'), 'utf8');

  const size = (await dirSize(STAGE)) / 1048576;
  console.log(`[4/4] 体积 ${size.toFixed(1)} MB`);

  if (!noZip) {
    const zip = path.join(OUT, `${NAME}-便携版.zip`);
    await rm(zip, { force: true });
    console.log('  压缩中…');
    /* 见文件顶部 `PY_ZIP`：Python zipfile 是唯一同时写对「目录条目」与「UTF-8 标志位」的现成工具，
     * 而且它自带读回自检。缺 Python 的机器退回 bsdtar（会点名警告标志位问题）。 */
    const py = process.env.COSMOS_PYTHON || 'py';
    let made = false;
    try {
      execFileSync(py, ['-3', '-X', 'utf8', '-c', PY_ZIP, STAGE, zip], { stdio: 'inherit' });
      made = true;
    } catch (e) {
      console.log(`  ! Python 打包失败（${e.code || e.message}）⇒ 退回 bsdtar`);
    }
    if (!made) {
      const TAR = process.env.SystemRoot
        ? path.join(process.env.SystemRoot, 'System32', 'tar.exe')
        : 'tar';
      try {
        execFileSync(TAR, ['-a', '-c', '-f', zip, '-C', OUT, NAME], { stdio: 'inherit' });
        made = true;
        console.log('  ⚠️ 用 bsdtar 打的 —— 它**不写 UTF-8 标志位**，'
          + '非中文 Windows 上目录名会乱码。装了 Python 就能避免。');
      } catch (e2) {
        execFileSync('powershell', ['-NoProfile', '-Command',
          `Compress-Archive -Path '${STAGE}' -DestinationPath '${zip}' -CompressionLevel Optimal -Force`],
          { stdio: 'inherit' });
        made = true;
        console.log('  ⚠️ 用 Compress-Archive 打的 —— 它**不写目录条目**，老解压器可能出错。');
      }
    }
    const zs = (await stat(zip)).size / 1048576;
    console.log(`  ✓ ${zip}  (${zs.toFixed(1)} MB)`);
  }
  console.log('=== 完成 ===');
}

async function dirSize(dir) {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += await dirSize(p);
    else n += (await stat(p)).size;
  }
  return n;
}

await main();
