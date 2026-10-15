/**
 * 人工数据覆盖（overrides）
 *
 *  科研监测抓到的候选结论，只有人在「数据更新中心」点下「采纳」才会写进
 *  data/overrides.json；本模块把它应用到运行时实体上，让修正在不重跑任何
 *  抓取脚本的情况下立即生效。
 *
 *  边界：只能改「字段值」，不能新增/删除天体，也不能改 id —— 那属于数据结构的
 *  改动，必须回源文件改，否则目录树与索引会互相打架。
 */

/** 读取覆盖表；文件不存在或损坏时安静降级为空表，绝不因此让整个程序起不来 */
export async function loadOverrides() {
  try {
    const r = await fetch('./data/overrides.json', { cache: 'no-store' });
    if (!r.ok) return { overrides: [], error: `HTTP ${r.status}` };
    const j = await r.json();
    if (!Array.isArray(j.overrides)) return { overrides: [], error: 'overrides 不是数组' };
    return { overrides: j.overrides, updatedAt: j.updatedAt || null };
  } catch (e) {
    return { overrides: [], error: e.message };
  }
}

/** 解析 'facts[1]' / 'ring.widthKm' 这类路径 → ['facts', 1] */
export function parsePath(p) {
  const out = [];
  for (const seg of String(p).split('.')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)((?:\[\d+\])*)$/.exec(seg);
    if (!m) return null;
    out.push(m[1]);
    for (const idx of m[2].matchAll(/\[(\d+)\]/g)) out.push(Number(idx[1]));
  }
  return out.length ? out : null;
}

/**
 * 把覆盖表应用到数据集。
 * 返回 { applied, failed }，两者都会带上 before 值，便于界面展示「从什么改成什么」。
 */
export function applyOverrides(dataset, list = []) {
  const applied = [];
  const failed = [];

  for (const o of list) {
    if (!o || typeof o !== 'object') continue;
    const body = dataset.get(o.entityId);
    if (!body) { failed.push({ ...o, reason: '找不到该天体（id 可能已变）' }); continue; }

    const seg = parsePath(o.path);
    if (!seg) { failed.push({ ...o, reason: '路径格式不合法' }); continue; }

    // 逐段下钻，最后一段之前必须已存在——不替数据「凭空造字段」
    let cur = body;
    let broken = false;
    for (let i = 0; i < seg.length - 1; i++) {
      const k = seg[i];
      if (cur == null || typeof cur !== 'object' || !(k in cur)) { broken = true; break; }
      cur = cur[k];
    }
    if (broken || cur == null || typeof cur !== 'object') {
      failed.push({ ...o, reason: `路径 ${o.path} 在数据里不存在` });
      continue;
    }

    const last = seg[seg.length - 1];
    if (Array.isArray(cur)) {
      if (typeof last !== 'number' || last < 0 || last >= cur.length) {
        failed.push({ ...o, reason: `数组下标越界：${o.path}` });
        continue;
      }
    }
    const before = cur[last];
    cur[last] = o.value;
    applied.push({ ...o, before });
  }

  return { applied, failed };
}
