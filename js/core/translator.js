/**
 * 客户端翻译器 —— 不依赖任何 API Key
 *
 *  引擎优先级：
 *   ① 浏览器内置翻译（Chrome 138+ / Edge 的 Translator API，本地模型，可离线）
 *   ② 本地服务代理的公共翻译接口（/api/research/translate）
 *   ③ 都不可用 → 提供「用浏览器打开原文并整页翻译」的入口
 *
 *  用法：
 *    const t = await translator.translate(text);          // 返回 { text, engine }
 *    translator.availability();                            // 'browser' | 'server' | 'none'
 */

const LANG = { zh: 'zh', 'zh-CN': 'zh', en: 'en' };

class Translator {
  constructor() {
    this.browserOk = null;      // null = 未检测
    this.pairs = new Map();     // 'en>zh' → Promise<Translator>
    this.engineUsed = null;
  }

  /** 浏览器是否支持内置翻译（含语言包可用性检查） */
  async detect() {
    if (this.browserOk !== null) return this.browserOk;
    const T = globalThis.Translator;
    if (!T?.create) { this.browserOk = false; return false; }
    try {
      const a = await T.availability({ sourceLanguage: 'en', targetLanguage: 'zh' });
      this.browserOk = a === 'available' || a === 'downloadable' || a === 'downloading';
      this.downloadable = a === 'downloadable';
    } catch { this.browserOk = false; }
    return this.browserOk;
  }

  async #pair(source, target) {
    const key = `${source}>${target}`;
    if (this.pairs.has(key)) return this.pairs.get(key);
    const promise = (async () => {
      const T = globalThis.Translator;
      if (!T?.create) throw new Error('浏览器不支持内置翻译');
      return T.create({
        sourceLanguage: source,
        targetLanguage: target,
        monitor: (m) => m.addEventListener?.('downloadprogress', (e) => {
          globalThis.__translatorProgress?.(e.loaded);
        }),
      });
    })();
    this.pairs.set(key, promise);
    return promise;
  }

  /** 当前可用的引擎（异步检测） */
  async availability() {
    if (await this.detect()) return 'browser';
    return 'server';
  }

  /**
   * 翻译一段文本
   * @returns {{text:string, engine:string}}
   */
  async translate(text, { target = 'zh', source = 'en' } = {}) {
    const src = LANG[source] || source;
    const dst = LANG[target] || target;
    const clean = String(text ?? '').trim();
    if (!clean) return { text: '', engine: 'none' };

    // ① 浏览器内置翻译
    if (await this.detect()) {
      try {
        const t = await this.#pair(src, dst);
        const out = await t.translate(clean);
        if (out?.trim()) { this.engineUsed = 'browser'; return { text: out.trim(), engine: 'browser' }; }
      } catch (e) { console.warn('[translator] 浏览器内置翻译失败：', e.message); }
    }

    // ② 本地服务代理的公共接口
    try {
      const r = await fetch('/api/research/translate', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ texts: [clean], target: dst, source: src }),
      }).then((x) => x.json());
      if (r.ok && r.items?.[0]) { this.engineUsed = 'server'; return { text: r.items[0], engine: 'server' }; }
      throw new Error(r.error || '翻译服务不可用');
    } catch (e) {
      this.engineUsed = 'none';
      throw e;
    }
  }

  /** 整页翻译入口：交给浏览器自带的翻译功能 */
  pageTranslateUrl(url) {
    if (!url) return null;
    return `https://translate.google.com/translate?sl=auto&tl=zh-CN&u=${encodeURIComponent(url)}`;
  }

  get engineLabel() {
    return { browser: '浏览器内置翻译（离线）', server: '公共翻译接口', none: '不可用' }[this.engineUsed] || '';
  }
}

export const translator = new Translator();
