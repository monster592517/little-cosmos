#!/usr/bin/env node
/* ==============================================================================
   selftest-injections.mjs —— 故障注入自测台

   为什么需要它
   ──────────────────────────────────────────────────────────────────────────────
   本项目有一条硬规矩：**一个从不失败的检查等于没有检查。**
   写了一条断言、但它永远不会响 —— 那和没写一样，只是多了一层"我们检查过了"的错觉。

   所以要定期往真实的磁盘文件里**注入一个已知故障**，跑一遍检查，确认它真的报错，
   再还原。每次加新检查，都应该在这里加一条对应的注入用例。

   安全性（会改磁盘，所以规则很死）
   ──────────────────────────────────────────────────────────────────────────────
   1. **必须前台运行。** 不要后台跑 —— 被中途杀掉会留下改过的文件。
   2. **备份先落盘**（`<file>.inject-backup`），改完立刻还原。
   3. **启动时自愈**：每次运行开头先扫一遍残留的 sidecar，有就还原。
      上一次被强杀留下的痕迹，这次跑就先把它修好，绝不带着脏文件往下走。
   4. **还原后必须逐字节校验**，再跑一遍全量检查确认回到绿。任一步不对就非零退出。

   ⚠️ **绝对不要用 `execFileSync` 跑"预期会失败"的命令。**
      它把非零退出码抛成异常，于是「判据响了」和「检查自己崩了」在调用方看来
      完全一样 —— 注入自测会在**成功的时候报失败**。用 `spawnSync` 拿 stdout 再判断。

   用法
   ──────────────────────────────────────────────────────────────────────────────
     node tools/selftest-injections.mjs            # 跑全部注入用例
     node tools/selftest-injections.mjs --list     # 只列用例
     node tools/selftest-injections.mjs --restore  # 只做自愈复原，不注入
   ============================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TRASH = path.join(ROOT, '.trash');

/* ==============================================================
   用例表
   ==============================================================
   file/mustFind  —— 注入点所在的文件与必须**唯一命中**的片段
   expect         —— 期望哪一个检查报出来（id + 错误信息里必须出现的关键词）
   ============================================================== */
/* ⚠️ 「不存在的编号」必须**拼出来**，不能写成字面量：本文件在 `tools/` 下，
 *   也在 `check-refs` 的扫描根里 —— 写出来就等于给仓库种了一条**真的**悬空引用，
 *   于是工具会报自己的样本（自指陷阱）。这里的写法保证源码里不出现「坑 <数字>」。 */
const GHOST_REF = ['坑', '999'].join(' ');
const GHOST_REF_RE = new RegExp(GHOST_REF.replace(' ', '\\s*'));

const INJECTIONS = [
  {
    id: 'pipeline-bins',
    why: '管线步骤不在脚本白名单里 —— 这条管线在界面上能点，一跑必报 BAD_STEP',
    file: 'server/lib/datacenter.mjs',
    find: "'fetch-mboss',",
    to: '',
    check: {
      cmd: ['tools/selfcheck.mjs', '--json'],
      kind: 'selfcheck',
      id: 'data.pipeline-bins',
      wantLevel: 'error',
      wantText: /fetch-mboss/,
    },
  },
  {
    id: 'photometry-invented',
    why: '给鸟神星**编**一个上游表里根本不存在的 V−R（最难发现的一类错：颜色只会安静地偏一点）',
    file: 'web/js/color/photometric-colors.js',
    find: "mbossKey: '136472-Makemake',",
    to: "mbossKey: '136472-Makemake',\n    vr: 0.45,   // ← 注入：上游表里这一列是空的",
    check: {
      cmd: ['tools/check-photometry.mjs'],
      kind: 'exit',
      wantExit: 1,
      wantText: /上游没有/,
    },
  },
  {
    id: 'dwarf-color-field',
    why: '把矮行星的 color 字段注释掉（这正是它原本失效的方式）—— 渲染会安静地吃兜底灰',
    file: 'web/js/data/solar-system.js',
    find: "    color: '#575656',\n    radiusKm: 469.7,",
    to: "    // color: '#575656',\n    radiusKm: 469.7,",
    check: {
      cmd: ['tools/check-body-colors.mjs'],
      kind: 'exit',
      wantExit: 1,
      wantText: /谷神星|ceres/,
    },
  },
  {
    id: 'bloom-kernel-wiring',
    why: '把泛光核整定（丙）的调用注释掉 —— 这就是它最可能的失效方式：'
      + '**页面照样能跑、控制台一条错都不报，方斑（坑 118）静默回来**。'
      + '⚠️ 特意用「注释掉」而不是「删掉」，因为注释是最自然的「临时关一下」写法，'
      + '也正好检验判据有没有先剥注释再判（拿原始行去正则会**假绿**）。',
    file: 'web/js/core/engine.js',
    find: '    this.bloomKernel = retuneBloomKernel(this.bloomPass);',
    to: '    // this.bloomKernel = retuneBloomKernel(this.bloomPass);   // 注入：临时关掉接线',
    check: {
      cmd: ['tools/selfcheck.mjs', '--json'],
      kind: 'selfcheck',
      id: 'shell.bloom-kernel',
      wantLevel: 'error',
      wantText: /接线/,
    },
  },
  {
    id: 'dangling-ref-graded',
    /* ⚠️ 不存在的那个编号**不能在这里写成字面量** —— 本文件也在 `tools/` 下、
     *   同样在 `check-refs` 的扫描根里，写出来它就等于给仓库种了一条真的悬空引用
     *   （**自指陷阱**：扫描/替换类工具被自己的样本绊倒，本项目踩过不止一次）。
     *   所以拼出来用。 */
    why: '把一条「坑 130」的引用改成一个**不存在的编号** —— 悬空引用本身不报错、页面上什么都不显示。'
      + '这个用例同时守两件事：'
      + '① check-refs 抓得到悬空引用（它退出码 1）；'
      + '② **自检要把「工具找到了问题」和「工具跑不起来」分开报** —— '
      + '`execFileSync` 在子进程非零退出时会抛异常，只看这个就会把「4 处悬空」报成「跑不起来」，'
      + '把人派去查工具而不是查引用。'
      + '⚠️ 所以断言的是 detail 里出现那个**假编号本身**（正确分级才会把它列出来），'
      + '**不是**出现「编号引用」——后者在两条消息里都有，判不出差别。',
    file: 'web/js/levels/supercluster.js',
    find: '保持无操作是**有意**的（坑 130 的行内自证豁免',
    to: `保持无操作是**有意**的（${GHOST_REF} 的行内自证豁免`,
    check: {
      cmd: ['tools/selfcheck.mjs', '--json'],
      kind: 'selfcheck',
      id: 'shell.doc-refs',
      wantLevel: 'warn',
      wantText: GHOST_REF_RE,
    },
  },
  {
    id: 'disc-edge-fade',
    why: '把盘面贴图的**外缘渐隐**注释掉 —— 这是它最自然的失效方式：'
      + '那一步在函数末尾、看着像可有可无的收尾，删掉之后**页面照跑、控制台一条错都不报**，'
      + '只是盘边变成一圈一刀切的硬边（用户原话「边缘没有淡出效果」）。'
      + '⚠️ 特意用「注释掉」而不是「删掉」：注释是最自然的「临时关一下」写法，'
      + '也正好检验判据有没有先剥注释再判（拿原始行去正则会**假绿**）。'
      + '⚠️ 这个注入点在重构后是**唯一**的（渐隐收敛成了 `fadeDiscEdge` 一份实现），'
      + '所以「命中必须唯一」那条守卫也顺带钉住了「不许再各写一份」。',
    file: 'web/js/proc/textures.js',
    find: "  g.globalCompositeOperation = 'destination-in';",
    to: "  // g.globalCompositeOperation = 'destination-in';   // 注入：临时关掉外缘渐隐",
    check: {
      cmd: ['tools/selfcheck.mjs', '--json'],
      kind: 'selfcheck',
      id: 'textures.disc-edge-fade',
      wantLevel: 'warn',
      wantText: /没有 destination-in/,
    },
  },
];

const argv = process.argv.slice(2);
const LIST = argv.includes('--list');
const RESTORE_ONLY = argv.includes('--restore');

if (LIST) {
  for (const inj of INJECTIONS) console.log(`${inj.id.padEnd(22)} ${inj.file}  —— ${inj.why}`);
  process.exit(0);
}

/* ==============================================================
   自愈：把上次被强杀留下的 sidecar 还原掉
   ============================================================== */
function backups() {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === '.trash' || e.name === 'dist') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.inject-backup')) out.push(p);
    }
  };
  for (const d of ['server', 'web', 'tools', 'data']) {
    const p = path.join(ROOT, d);
    if (fs.existsSync(p)) walk(p);
  }
  return out;
}

function repairLeftovers(verbose = true) {
  const baks = backups();
  for (const b of baks) {
    const target = b.slice(0, -'.inject-backup'.length);
    fs.writeFileSync(target, fs.readFileSync(b));
    fs.mkdirSync(TRASH, { recursive: true });
    fs.renameSync(b, path.join(TRASH, `inject-backup-${path.basename(target)}-${Date.now()}`));
    if (verbose) console.log(`⟲ 自愈：残留 sidecar 已还原 → ${path.relative(ROOT, target)}`);
  }
  return baks.length;
}

const healed = repairLeftovers();
if (healed === 0 && !RESTORE_ONLY) console.log('· 没有残留 sidecar，干净起步');
if (RESTORE_ONLY) {
  console.log(healed ? `已自愈 ${healed} 个残留文件` : '没有需要自愈的残留');
  process.exit(0);
}

/* ==============================================================
   检查解析器
   ============================================================== */
function runCheck(spec) {
  const r = spawnSync(process.execPath, spec.cmd, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 24 });
  const out = String(r.stdout || '');
  const err = String(r.stderr || '');
  const text = out + err;

  if (spec.kind === 'exit') {
    return { fired: r.status === spec.wantExit && spec.wantText.test(text), detail: `exit=${r.status}`, text };
  }
  // selfcheck --json：多行美化 JSON，且字段名是 `level` 不是 `status`
  let j = null;
  try { j = JSON.parse(out.trim()); } catch { try { j = JSON.parse(out.trim().split('\n').pop()); } catch { /* ignore */ } }
  if (!j) return { fired: false, detail: '输出不是 JSON', text };
  const flat = [];
  const walk = (g) => {
    if (Array.isArray(g)) return g.forEach(walk);
    if (!g || typeof g !== 'object') return;
    if (g.id) flat.push(g);
    for (const v of Object.values(g)) if (v && typeof v === 'object') walk(v);
  };
  walk(j.groups || j.checks || j);
  const hit = flat.find((c) => c.id === spec.id);
  if (!hit) return { fired: false, detail: `没找到检查 ${spec.id}`, text };
  return {
    fired: hit.level === spec.wantLevel && spec.wantText.test(String(hit.detail || '')),
    detail: `[${hit.id}] level=${hit.level} · ${hit.detail}`,
    text,
  };
}

/* ==============================================================
   逐个跑
   ============================================================== */
let allOk = true;
console.log(`\n  故障注入自测台 · ${INJECTIONS.length} 个用例\n  ${'─'.repeat(60)}\n`);

for (const inj of INJECTIONS) {
  const F = path.join(ROOT, inj.file);
  const BAK = F + '.inject-backup';
  const orig = fs.readFileSync(F, 'utf8');
  const origBuf = Buffer.from(orig, 'utf8');
  let restored = false;
  const restore = () => {
    if (!restored) { fs.writeFileSync(F, orig); restored = true; }
  };

  try {
    const n = orig.split(inj.find).length - 1;
    if (n !== 1) {
      allOk = false;
      console.log(`  ✗ ${inj.id.padEnd(20)} 注入点命中 ${n} 次（必须唯一）—— 用例过期了，请修 tools/selftest-injections.mjs`);
      continue;
    }

    fs.writeFileSync(BAK, orig, 'utf8');          // 备份先落盘
    fs.writeFileSync(F, orig.replace(inj.find, inj.to), 'utf8');

    const before = runCheck(inj.check);
    restore();

    const back = fs.readFileSync(F);
    const same = back.equals(origBuf);

    // 还原后再跑一遍：必须回到"没响"
    const after = runCheck(inj.check);

    const ok = before.fired && same && !after.fired;
    if (!ok) allOk = false;
    console.log(`  ${ok ? '✓' : '✗'} ${inj.id.padEnd(20)} 注入后${before.fired ? '被捕获' : '★没响★'} · 还原${same ? '逐字节一致' : '★不一致★'} · 还原后${after.fired ? '★仍然在报★' : '已回到正常'}`);
    console.log(`      ${before.detail}`);
    if (!before.fired) console.log(`      ⚠️ 判据没响 —— 这个检查是摆设，或者注入点已经失效`);
    if (after.fired) console.log(`      ⚠️ 还原后检查还在报 —— 说明报的不是注入的故障，用例无效`);
  } catch (e) {
    restore();
    allOk = false;
    console.log(`  ✗ ${inj.id.padEnd(20)} 异常：${e.message}（已还原）`);
  } finally {
    if (fs.existsSync(BAK)) {
      fs.mkdirSync(TRASH, { recursive: true });
      try { fs.renameSync(BAK, path.join(TRASH, `inject-backup-${inj.id}-${Date.now()}`)); } catch { /* ignore */ }
    }
  }
}

console.log(`\n  ${'─'.repeat(60)}`);
if (allOk) {
  console.log('  ✓ 全部用例：注入被捕获 · 还原逐字节一致 · 还原后回到正常\n');
  process.exit(0);
}
console.log('  ✗ 有用例没通过 —— 见上方 ⚠️\n');
process.exit(1);
