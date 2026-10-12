/**
 * 小小宇宙 · 统一日志
 *
 * 设计取舍（别乱改，改了先想清楚）：
 *  1. **同步写盘**。日志量本来就小（每天几百行），而"崩溃后再也读不到日志"是最糟的失败模式。
 *     用 appendFileSync 换来"进程被杀也留得下最后一行"，这笔交易划算。
 *  2. **JSONL**。一行一条，`t` / `level` / `scope` / `msg` / `data` 五个字段固定。
 *     人能读，脚本也能直接解析——排查时不用再写正则去啃自由文本。
 *  3. **降级不崩**。日志目录不可写（只读挂载、权限问题）时，自动退化成"只打控制台"，
 *     绝不因为写不了日志就把服务干死。
 *  4. **内存环形缓冲**。保留最近 N 条，供 `/api/logs` 和面板即时查看，不用去翻文件。
 *
 * 用法：
 *   import { createLogger } from './lib/log.mjs';
 *   const log = createLogger(ROOT, { scope: 'server' });
 *   log.info('服务启动', { port: 8787 });
 *   log.error('抓取失败', { source: 'hyg', err: e.message });
 */

import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const KEEP_DAYS = 14;          // 日志保留天数；超过就在跨天时清掉
const RING_SIZE = 2000;        // 内存里保留的最近条数

const pad = (n) => String(n).padStart(2, '0');

/** 本地日期（不是 UTC）——日志按"我这边的一天"分文件，排查时才对得上直觉。 */
export function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function createLogger(root, { scope = 'server', level = 'debug', mirrorConsole = true } = {}) {
  const dir = path.join(root, 'logs');
  const ring = [];
  let writable = true;
  let writableChecked = false;
  let pruned = false;
  let writen = 0;

  function ensureDir() {
    if (writableChecked) return writable;
    writableChecked = true;
    try {
      mkdirSync(dir, { recursive: true });
      // 真写一下才算数——mkdir 成功不等于可写（只读盘 / 配额 / 目录被别的程序锁着）。
      // 空追加：文件不在就建出来，在就什么也不加。别另写一个 ".writable" 探针文件去污染日志目录。
      appendFileSync(path.join(dir, `server-${dayKey()}.jsonl`), '', 'utf8');
      writable = true;
    } catch {
      writable = false;
      if (mirrorConsole) console.error(`[log] 日志目录不可写，已降级为仅控制台输出：${dir}`);
    }
    return writable;
  }

  /** 跨天时顺手清理过期日志。只做一次，避免每行都去 readdir。 */
  function pruneIfNeeded() {
    if (pruned) return;
    pruned = true;
    try {
      const cutoff = Date.now() - KEEP_DAYS * 86400 * 1000;
      for (const f of readdirSync(dir)) {
        if (!/^[a-z]+-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue;
        const p = path.join(dir, f);
        if (statSync(p).mtimeMs < cutoff) { unlinkSync(p); writen++; }
      }
    } catch { /* 清理失败不影响使用 */ }
  }

  function write(lv, msg, data) {
    if (LEVELS[lv] < LEVELS[level]) return;
    const rec = { t: new Date().toISOString(), level: lv, scope, msg: String(msg) };
    if (data !== undefined) rec.data = data;

    ring.push(rec);
    if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);

    if (ensureDir()) {
      pruneIfNeeded();
      try {
        appendFileSync(path.join(dir, `server-${dayKey()}.jsonl`), JSON.stringify(rec) + '\n', 'utf8');
      } catch {
        writable = false;   // 中途变不可写（磁盘满等）：降级，别再抛
      }
    }
    if (mirrorConsole) {
      const tail = data === undefined ? '' : ' ' + JSON.stringify(data);
      console[LEVELS[lv] >= LEVELS.error ? 'error' : LEVELS[lv] >= LEVELS.warn ? 'warn' : 'log'](
        `[${rec.t.slice(11, 19)}] ${lv.toUpperCase().padEnd(5)} [${scope}] ${msg}${tail}`
      );
    }
  }

  const logger = {
    get dir() { return dir; },
    get file() { return path.join(dir, `server-${dayKey()}.jsonl`); },
    get writable() { return writable; },
    debug: (m, d) => write('debug', m, d),
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),

    /**
     * 记录一个 Error，尽量带上栈和上下文。
     * 上下文很重要——「请求处理异常」这类消息不带 URL 就等于没说；带上才知道去找哪条路径。
     */
    exception(msg, e, ctx) {
      const base = e instanceof Error
        ? { name: e.name, message: e.message, stack: (e.stack || '').split('\n').slice(0, 6).join('\n') }
        : { value: String(e) };
      write('error', msg, ctx && typeof ctx === 'object' ? { ...base, ...ctx } : base);
    },

    /** 内存缓冲的最近 n 条，可按最低级别过滤 */
    tail(n = 200, minLevel = 'debug') {
      const out = ring.filter((r) => LEVELS[r.level] >= LEVELS[minLevel]);
      return out.slice(-n);
    },

    /** 从今天的日志文件里读尾巴（进程重启后 ring 是空的，这时靠文件） */
    tailFile(n = 200, minLevel = 'debug') {
      try {
        const lines = readFileSync(logger.file, 'utf8').trim().split('\n');
        const out = [];
        for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
          try {
            const r = JSON.parse(lines[i]);
            if (LEVELS[r.level] >= LEVELS[minLevel]) out.push(r);
          } catch { /* 跳过半行（正在写） */ }
        }
        return out.reverse();
      } catch { return []; }
    },

    /** 统计今天的 error/warn 条数，给自检用 */
    counts() {
      const c = { debug: 0, info: 0, warn: 0, error: 0 };
      for (const r of ring) c[r.level] = (c[r.level] || 0) + 1;
      return c;
    },

    /** 挂上进程级兜底：未捕获异常 / 未处理 Promise / 收到退出信号 */
    captureProcessErrors() {
      process.on('uncaughtException', (e) => {
        logger.exception('uncaughtException', e);
        // 关键：未捕获异常后进程状态不可信，打完日志就退出，让启动器重拉。
        setTimeout(() => process.exit(1), 50);
      });
      process.on('unhandledRejection', (e) => logger.exception('unhandledRejection', e));
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.on(sig, () => logger.warn(`收到信号 ${sig}，准备退出`));
      }
      return logger;
    },
  };

  return logger;
}
