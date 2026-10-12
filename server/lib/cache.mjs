/**
 * 极简磁盘缓存：内存 Map + 延迟落盘 JSON。
 * 用于翻译结果、检索结果，避免重复调用付费 API。
 */
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

export class DiskCache {
  constructor(file, { maxEntries = 20000, saveDelay = 1500 } = {}) {
    this.file = file;
    this.maxEntries = maxEntries;
    this.saveDelay = saveDelay;
    this.map = new Map();
    this.timer = null;
    this.ready = this.#load();
  }

  async #load() {
    try {
      const raw = await readFile(this.file, 'utf8');
      const obj = JSON.parse(raw);
      for (const [k, v] of Object.entries(obj)) this.map.set(k, v);
      // 简单 LRU 裁剪
      if (this.map.size > this.maxEntries) {
        const keys = [...this.map.keys()].slice(0, this.map.size - this.maxEntries);
        for (const k of keys) this.map.delete(k);
      }
    } catch { /* 首次运行无缓存 */ }
  }

  async get(key) {
    await this.ready;
    return this.map.get(key);
  }

  async set(key, value) {
    await this.ready;
    this.map.set(key, value);
    this.#scheduleSave();
  }

  #scheduleSave() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush().catch(() => {}); }, this.saveDelay);
    this.timer.unref?.();
  }

  async flush() {
    await this.ready;
    await mkdir(path.dirname(this.file), { recursive: true });
    const obj = Object.fromEntries(this.map);
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(obj));
    await rename(tmp, this.file);
  }
}
