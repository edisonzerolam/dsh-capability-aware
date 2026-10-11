/**
 * 切面聚合 —— 「按插件、技能、对象以及其他合适的切面进行区分」的落点。
 *
 * 五个切面（每个都可独立排序、独立下钻）：
 *   1. **code**    错误码/签名  —— 最细粒度，自修复的直接把手
 *   2. **plugin**  插件（装载面 + 工具归属）
 *   3. **skill**   技能（错误发生前最近加载的技能 = 归因）
 *   4. **object**  对象（文件路径 / URL / 命令 / 工具）
 *   5. **owner**   责任方（local / provider / external / user）—— **决定该不该修**
 *
 * 另有维度：category / tool / provider / model / cwd / session。
 *
 * @module dsh-capability-aware/lib/ledger/rollup
 */

const FACETS = ['code', 'plugin', 'skill', 'object', 'owner', 'tool', 'provider', 'model', 'category', 'cwd'];

/** 一条记录 → 该记录在某个切面上的键（无值返回 undefined，不进聚合）。 */
export function facetKey(record, facet) {
  const v = record?.[facet];
  if (v === undefined || v === null || v === '') {
    // code 切面兜底：无错误码时用正文签名（实测 308/1650 条 ToolError 无 code）
    if (facet === 'code' && record?.signature) return `~${record.signature}`;
    return undefined;
  }
  if (facet === 'object') {
    const o = record.object;
    if (!o || typeof o.id !== 'string' || !o.id) return undefined;
    return `${o.kind}:${o.id}`;
  }
  return String(v);
}

/**
 * 聚合。
 * @param {Array} records 明细记录
 * @param {object} [opts]
 * @param {number} [opts.since] 只统计 time >= since
 * @param {string[]} [opts.facets] 只算这些切面
 * @param {number} [opts.topK] 每切面保留前 K（默认 50）
 */
export function rollup(records, opts = {}) {
  const since = Number.isFinite(opts.since) ? opts.since : 0;
  const facets = Array.isArray(opts.facets) && opts.facets.length ? opts.facets : FACETS;
  const topK = Number.isFinite(opts.topK) && opts.topK > 0 ? opts.topK : 50;

  const buckets = Object.fromEntries(facets.map((f) => [f, new Map()]));
  const bySession = new Map();
  const byDay = new Map();
  let total = 0;
  let firstTime = Infinity;
  let lastTime = 0;

  for (const r of records) {
    if (!r || (r.time ?? 0) < since) continue;
    total += 1;
    if (r.time < firstTime) firstTime = r.time;
    if (r.time > lastTime) lastTime = r.time;

    for (const f of facets) {
      const key = facetKey(r, f);
      if (key === undefined) continue;
      const m = buckets[f];
      let b = m.get(key);
      if (!b) { b = newCount(key); m.set(key, b); }
      bump(b, r);
    }

    if (r.session) {
      let s = bySession.get(r.session);
      if (!s) { s = { key: r.session, count: 0, categories: {}, ownerCounts: {}, cwd: r.cwd, lastTime: 0 }; bySession.set(r.session, s); }
      s.count += 1;
      if (r.category) s.categories[r.category] = (s.categories[r.category] ?? 0) + 1;
      if (r.owner) s.ownerCounts[r.owner] = (s.ownerCounts[r.owner] ?? 0) + 1;
      if (r.time > s.lastTime) s.lastTime = r.time;
    }

    const day = dayOf(r.time);
    if (day) byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }

  const out = {};
  for (const f of facets) {
    out[f] = [...buckets[f].values()]
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
      .slice(0, topK);
  }

  return {
    total,
    firstTime: Number.isFinite(firstTime) ? firstTime : undefined,
    lastTime: lastTime || undefined,
    facets: out,
    sessions: [...bySession.values()].sort((a, b) => b.count - a.count).slice(0, topK),
    byDay: Object.fromEntries([...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
  };
}

function newCount(key = '') {
  return { key, count: 0, categories: {}, owners: {}, retryable: 0, sessions: new Set(), lastTime: 0, lastMessage: '', fixHint: '' };
}

function bump(b, r) {
  // ⚠ 桶的 key 由建桶时的 facetKey 决定，**绝不能**在这里改写成 record.code
  //   —— 那会把 owner/object/plugin 等所有切面的键都变成错误码（实测踩过：
  //   「来源对象」显示 FS_EDIT_NOT_FOUND、「责任方分布」全 0）。
  b.count += 1;
  if (r.category) b.categories[r.category] = (b.categories[r.category] ?? 0) + 1;
  if (r.owner) b.owners[r.owner] = (b.owners[r.owner] ?? 0) + 1;
  if (r.retryable) b.retryable += 1;
  if (r.session) b.sessions.add(r.session);
  if ((r.time ?? 0) >= b.lastTime) {
    b.lastTime = r.time ?? 0;
    if (r.message) b.lastMessage = r.message;
    if (r.fixHint) b.fixHint = r.fixHint;
  }
}

export function dayOf(time) {
  if (!Number.isFinite(time)) return undefined;
  const d = new Date(time);
  if (Number.isNaN(d.getTime())) return undefined;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 序列化前把 Set 变成计数（JSON 友好）。 */
export function serializeFacets(r) {
  const clone = (b) => ({ ...b, sessionCount: b.sessions.size, sessions: [...b.sessions].slice(0, 20) });
  return {
    ...r,
    facets: Object.fromEntries(Object.entries(r.facets).map(([k, v]) => [k, v.map(clone)])),
  };
}

/**
 * 自修复候选 —— 只收 `owner === 'local'` 且非 abort/unknown 的签名，
 * 按「出现次数 × 影响会话数」排序。这是「以备自修复」的交付物。
 *
 * ⚠ 立场：**只给候选与证据，不做自动改动**。供应商配额类错误（owner=provider）
 *   一律不进此清单——否则会去「修」不该修的东西。
 */
export function selfRepairCandidates(records, opts = {}) {
  const since = Number.isFinite(opts.since) ? opts.since : 0;
  const minCount = Number.isFinite(opts.minCount) ? opts.minCount : 3;
  const map = new Map();

  for (const r of records) {
    if (!r || (r.time ?? 0) < since) continue;
    if (r.owner !== 'local') continue;
    if (r.category === 'abort' || r.category === 'unknown') continue;
    const sig = `${r.kind}:${r.code || r.signature || r.errorName || 'UNKNOWN'}:${r.tool ?? r.object?.kind ?? ''}`;
    let e = map.get(sig);
    if (!e) {
      e = {
        signature: sig, code: r.code || r.signature, errorName: r.errorName, category: r.category,
        textSignature: r.signature,
        tool: r.tool, objectKind: r.object?.kind, count: 0,
        sessions: new Set(), objects: new Set(), lastTime: 0, lastMessage: '', fixHint: r.fixHint,
      };
      map.set(sig, e);
    }
    e.count += 1;
    if (r.session) e.sessions.add(r.session);
    if (r.object?.id) e.objects.add(r.object.id);
    if ((r.time ?? 0) >= e.lastTime) {
      e.lastTime = r.time ?? 0;
      if (r.message) e.lastMessage = r.message;
      if (r.fixHint) e.fixHint = r.fixHint;
    }
  }

  return [...map.values()]
    .filter((e) => e.count >= minCount)
    .map((e) => ({
      ...e,
      sessionCount: e.sessions.size,
      sessions: undefined,
      sampleObjects: [...e.objects].slice(0, 5),
      objects: undefined,
      priority: e.count * Math.max(1, e.sessions.size),
    }))
    .sort((a, b) => b.priority - a.priority);
}

export { FACETS };
