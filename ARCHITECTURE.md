# 07_little_cosmos · 架构

> **结构真源**：`README.md` 的「项目结构」树（逐行带职责注释）。
> 本文件把它整理成**分层 + 链路**视角，专门回答一个问题：**改某处，要同步谁。**

## 一、运行形态

| | |
|---|---|
| 形态 | **本地服务（Node）+ 浏览器前端（three.js）** —— 打开浏览器即用 |
| 服务端 | **零第三方依赖**（纯 Node 内置模块） |
| 便携 | `runtime/node.exe` 随包分发；`web/vendor/{three,astronomy}` 本地化 ⇒ **离线可用** |
| 启动 | `启动小小宇宙.bat`（纯 ASCII + CRLF，路径处理见 `坑与雷点.md`） |
| 日志 | `logs/*.jsonl`（**同步落盘**、保留 14 天） |

## 二、分层

```
┌────────────────────────── 浏览器（web/）──────────────────────────┐
│  main.js ── 注册六个尺度层级                                        │
│                                                                   │
│  core/      engine(渲染器/层级/跨尺度/显存回收/过渡) · gpu(显卡探测+画质档位) │
│             scales(尺度阶梯唯一定义源) · ephemeris(星历核心) · time · translator │
│  levels/    solar · neighborhood · galaxy · cosmos · supercluster   │
│  objects/   builders(地球/太阳/云层着色器、小行星形状、星环、粒子带)      │
│  proc/      textures(程序化贴图)                                    │
│  data/      dataset(装载+目录树+全尺度检索索引+overrides) · overrides(人工修正应用器) │
│  ui/        nav(顶栏/尺度条/搜索/命令面板) · panel(属性面板/目录树)      │
│             datacenter(数据更新中心) · research · hud · labels        │
├───────────────────────────────────────────────────────────────────┤
│  静态资源：index.html(importmap) · css/ · textures/(含 35 张法线贴图) │
│            images/(88 张真实影像) · vendor/(three + astronomy 本地化) │
└───────────────────────┬───────────────────────────────────────────┘
                        │ HTTP（静态资源 + JSON API）
                        ▼
┌──────────── server/（本地服务，零第三方依赖）────────────┐
│  server.mjs   静态资源 + API（研究检索 / 数据更新中心 / 日志 / 自检）│
│  lib/                                                          │
│    log.mjs         统一日志（同步落盘 · JSONL · 降级不崩 · 环形缓冲）│
│    selfcheck.mjs   自检内核（七组检查，每条都带「怎么办」）           │
│    run-capture.mjs 跑子进程取 stdout 的**唯一实现**（不建管道，见 坑 159）│
│    papers.mjs      四源论文元搜索引擎                            │
│    translate.mjs   翻译（浏览器内置优先 + 公共接口回退）             │
│    datacenter.mjs  数据源状态 / 管线更新 / 科研监测 / overrides      │
│    cache.mjs       缓存                                         │
└───────────────────────┬─────────────────────────────────────────┘
                        ▼
┌──────────────────── data/（数据集与登记表）────────────────────┐
│  stars.json(120 ly/5258 颗) · stars-galactic.json(全量 109,400 颗，懒加载) │
│  exoplanets.json(40 pc/471 个) · small-bodies.json(91) · deep-sky.json(12,950) │
│  gallery.json(88) · local-group.json(McConnachie 2012 全表)              │
│  sources.json(数据源登记表) · watch-topics.json(9 主题)                  │
│  watch-queue.json / overrides.json / audit-findings.json（运行时生成）    │
│  raw/（上游原始数据：HYG csv / OpenNGC / SBDB …）                       │
└──────────────────────────────────────────────────────────────────┘
                        ▲
                        │ tools/（53 个脚本：抓取 / 构建 / 校验 / 打包 / 回归）
```

## 三、模块职责（改代码前查这张表）

| 模块 | 职责 | 改它要同步 |
|---|---|---|
| `web/js/core/scales.js` | **尺度阶梯的唯一定义来源**（六层 + 排序 + 换算） | 加/改尺度 ⇒ `levels/` 新增文件 + `main.js` 注册 + README 的「尺度阶梯」节 |
| `web/js/core/engine.js` | 渲染器 / 跨尺度过渡 / **显存回收** | 显存问题看这里；改动要跑尺度回归 |
| `web/js/core/gpu.js` | 显卡探测 + 画质档位 + GPU 偏好（持久化） | 档位变 ⇒ README 的「显卡与性能」节 |
| `web/js/core/ephemeris.js` | 星历：真实位置 / 轨道路径 / 探测器 / 实时物理量 | 有交叉校验脚本 `tools/verify-ephemeris.mjs` |
| `web/js/data/dataset.js` | 数据装载 + 目录树 + **全尺度检索索引** + overrides 应用 | 数据 schema 变 ⇒ `data/` 与 `tools/build-data.mjs` |
| `web/js/data/overrides.js` | 人工修正应用器（`entityId` + `path` 寻址） | 与 `data/overrides.json` 的格式是一对 |
| `server/lib/log.mjs` | 统一日志（**同步落盘** / JSONL / 降级不崩） | 日志格式变 ⇒ 日志查看器 + `README` 的「日志」节 |
| `server/lib/selfcheck.mjs` | **自检内核**（七组检查） | 命令行 `tools/selfcheck.mjs` 与界面自检**跑的是同一个内核** |
| `server/lib/run-capture.mjs` | 子进程 stdout 捕获的**唯一实现** | 见 坑 159：不要另建管道 |
| `server/lib/datacenter.mjs` | 数据源状态 / 管线更新 / 科研监测 / overrides | 与 `web/js/ui/datacenter.js` 是一对 |

## 四、三条主链路

### 4.1 渲染与跨尺度
```
main.js 注册层级 → engine 建场景 → 当前层级(levels/*.js)按 scales.js 换算单位
  → 切层时 engine 做过渡 + 回收显存；dataset.js 按需懒加载（如全量恒星)
```

### 4.2 数据更新中心
```
UI(datacenter.js) → server API(datacenter.mjs) → 取上游 → 对比 sources.json
  → 产出待复核 → 人工采纳 ⇒ 写 overrides.json ⇒ dataset 应用
```

### 4.3 论文检索 / 科研监测
```
UI → server(lib/papers.mjs 四源元搜索 / watch-topics.json 主题)
  → 结果 → watch-queue.json 待复核
  ⇒ 原则：**只给线索，不下结论**
```

## 五、几个「看起来奇怪、其实有原因」的设计

1. **服务端零第三方依赖**。便携包要在**没有 npm / 没有网**的机器上跑 ⇒ 依赖只能藏在前端 `web/vendor/`（本地化）。
2. **`run-capture.mjs` 是唯一实现**。历史上多份"建管道取 stdout"的副本各坏各的（坑 159），
   收敛成一份，改一处即全改。
3. **自检内核共用**。命令行 `tools/selfcheck.mjs` 与界面上的自检面板**同一个 `selfcheck.mjs`** ——
   避免"命令行说好、界面说坏"。
4. **日志同步落盘**。异步写在崩溃时会丢最后几行，而崩溃现场恰恰最需要那几行。
5. **数据不抽样**（如 `local-group.json` 用 McConnachie 2012 全表）——
   科研场景下"抽样"会让结论失真。

## 六、故障点

| 位置 | 典型症状 | 为什么易坏 |
|---|---|---|
| `engine.js` 的显存回收 | 切层后越来越卡 | 显存不回收会累积 |
| `stars-galactic.json` 懒加载 | 进银河系层卡住 | 6.5 MB 全量数据，加载时机敏感 |
| `server/lib/log.mjs` | 日志空 ⇒ 误判"健康" | 它是**同步**落盘，异常路径要保证不静默吞 |
| 自检 | 报红但原因不明 | 自检器自身也可能坏 ⇒ `check-selfcheck.mjs` 专门验它 |
| 打包 | 包内行为与源侧不一致 | `dist/` 是打包产物，**别手改**；包内自检在重打包前不代表现场 |

## 七、改了要同步什么

| 你改了什么 | 必须同步 |
|---|---|
| 模块 / 数据流 / 目录 | `README.md` 的「项目结构」树（**它是结构真源**） |
| 尺度阶梯 | `scales.js` + `levels/` + `main.js` + README |
| 服务 API | 前端调用点 + 本文件 §三 |
| 自检项 | `自检维修手册.md`（症状→判据→根因→处置）+ `check-selfcheck.mjs` |
| 任何代码 | **铁律**（`README.md`「维护与自检」节）：每次改动要同时维护四类东西 |

---

<sub>文档地图：`README.md`（说明书/结构真源）· **`ARCHITECTURE.md`（本文）** · `操作手册.md` · `自检维修手册.md` · `坑与雷点.md`</sub>
