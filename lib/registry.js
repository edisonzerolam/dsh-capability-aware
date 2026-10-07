// dsh-capability-aware · registry.js
// 能力清单持久层：JSON 快照 + fingerprint 级增量 diff + 扫描错误计数。
// 数据落盘：~/.dsh/data/capability-aware/capabilities.json（topic-trail 先例：插件自有数据目录）。
// 并发纪律（harness-ops §C）：写前即时重读 + 原子替换写（tmp + rename），防并发窗口写坏。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { normalizeEntry, isRecognizable, CAP_TYPES } from './schema.js';
import { buildIdf } from './matcher.js';
import { applySeedAliases } from './seed.js';

export function dataFile(dshHome) {
  const home = dshHome || process.env.DSH_CAP_DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'data', 'capability-aware', 'capabilities.json');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function atomicWrite(file, obj) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** 读当前清单。清单不存在/损坏/为空时返回 null 状态对象（调用方据此走「未初始化」分支）。 */
export function load(file) {
  const f = file || dataFile();
  const raw = readJson(f);
  if (!raw || typeof raw !== 'object') {
    return { state: 'missing', entries: [], meta: null, file: f };
  }
  const entries = Array.isArray(raw.entries) ? raw.entries.filter(isRecognizable) : [];
  return {
    state: entries.length === 0 ? 'empty' : 'ok',
    entries,
    meta: raw.meta || null,
    file: f,
  };
}

/**
 * v5 缺陷 A 修复：条目唯一键。
 * 病灶：旧键 `${type}:${name}` 在清单存在 **18 组同名条目** 时互相覆盖，diff 失真。
 * 真实例子：`bili-daily` 同时存在
 *   - `skill-router:bili-daily`（顶层，disabled=true）
 *   - `skill-router:web-intel/skills/bili-daily`（web-intel 子技能，disabled=false）
 * 两者是同名但不同路径的不同能力；`skill-creator` 更有 3 条。
 * 正解：键带上来源（source 含 rel 路径），同名不同源各自独立。
 * 兼容性：旧清单条目若缺 source，退化为 `type:name`，仍能匹配上（不丢人工数据）。
 */
export function entryKey(e) {
  const base = `${e.type}:${e.name}`;
  return e.source ? `${base}:${e.source}` : base;
}

/**
 * 与扫描结果做 merge，产出 diff。
 * diff 语义：
 *  - added / removed：按 entryKey（type,name,source）对比；
 *  - changed：同键但 fingerprint 不同（能力「变了」，如 SKILL.md 改动、插件升级）；
 *  - stale：本地有但扫描不到（多为「能力被移除」→ 触发缺失引导口径）。
 * manual 覆盖尊重：hidden 条目仅记录、不删；manual.aliases/notes 永远保留。
 */
export function diff(prevEntries, scannedEntries) {
  const prev = new Map(prevEntries.map((e) => [entryKey(e), e]));
  const next = new Map(scannedEntries.map((e) => [entryKey(e), e]));
  const added = [];
  const removed = [];
  const changed = [];
  const kept = [];
  for (const [k, e] of next) {
    const p = prev.get(k);
    if (!p) added.push(e);
    else if (p.fingerprint !== e.fingerprint) changed.push({ from: p, to: e });
    else kept.push(e);
  }
  for (const [k, e] of prev) {
    if (!next.has(k)) removed.push(e);
  }
  return { added, removed, changed, kept };
}

/**
 * v5 Bug1 修复：合并人工覆盖字段。
 * 病灶（v1–v4.5）：`manual: { ...p.manual, ...(e.manual || {}) }` —— 扫描产出经 normalizeEntry
 * 后 manual 恒为「填满默认值的对象」（aliases:[], notes:'', hidden:false, priority:0），
 * 展开后**永远覆盖**已有人工数据 → 每次 boot/反应式扫描都把别名/备注/隐藏/优先级抹平。
 * 实测：给 AKShare 灌入 aliases 后跑一次 scan，读回 `[]`；全清单 563 条带人工数据者 = 0。
 * 正确语义：**扫描侧只能补空缺，不能抹已有人工值**（人工数据是跨扫描资产，见 README「人工覆盖层」）。
 */
function isManualEmpty(m) {
  if (!m || typeof m !== 'object') return true;
  return !(m.aliases?.length) && !String(m.notes || '').trim() && m.hidden !== true && !Number(m.priority);
}

export function mergeManual(prevManual, nextManual) {
  const p = prevManual && typeof prevManual === 'object' ? prevManual : null;
  const n = nextManual && typeof nextManual === 'object' ? nextManual : null;
  if (!p) return n || { aliases: [], notes: '', hidden: false, priority: 0 };
  if (isManualEmpty(n)) return { ...p };
  // 扫描侧非空（未来若某探针自带人工数据）：逐字段「非空者胜」，空字段保留人工值
  return {
    aliases: n.aliases?.length ? n.aliases : (p.aliases || []),
    notes: String(n.notes || '').trim() ? n.notes : (p.notes || ''),
    hidden: n.hidden === true ? true : p.hidden === true,
    priority: Number(n.priority) || Number(p.priority) || 0,
  };
}

/**
 * 应用一次扫描结果到清单（写盘）。
 * @returns {{state:'ok'|'empty', diff: object, entries: object[], meta: object}}
 */
export function applyScan(file, scanResult, opts = {}) {
  const f = file || dataFile();
  const prev = load(f);
  const { entries: prevEntries } = prev;
  const scanned = (scanResult.entries || []).map((raw) => normalizeEntry(raw)).filter((r) => r.ok).map((r) => r.entry);

  // 以扫描产出为准重建，但尊重 manual 字段。
  // v5 缺陷 A：主键用 entryKey（含 source）——同名不同源（bili-daily 顶层 vs web-intel 子技能）
  // 不再互相覆盖；同时保留 `type:name` 兜底映射：旧清单（v≤4）无 source 或技能迁移目录时，
  // 只要该 name 在旧清单里**唯一**，人工数据仍能续上（避免升级即丢别名）。
  const prevByKey = new Map(prevEntries.map((e) => [entryKey(e), e]));
  const prevByName = new Map();
  for (const e of prevEntries) {
    const k = `${e.type}:${e.name}`;
    prevByName.set(k, prevByName.has(k) ? null : e); // 重名 → null，禁止模糊续接
  }
  const merged = scanned.map((e) => {
    const p = prevByKey.get(entryKey(e)) || prevByName.get(`${e.type}:${e.name}`) || null;
    if (!p) return e;
    const manual = mergeManual(p.manual, e.manual);
    return {
      ...e,
      // 人工 notes 覆盖扫描 description（notes 是人工权威；空则用扫描产出）
      description: manual.notes ? manual.notes : e.description,
      manual,
    };
  });

  // v4：部分探针扫描（轻量重扫）时，保留本次未覆盖类型的既有条目——
  // 否则反应式轻扫会把 hardware/software（PowerShell 慢探针，本就不参与轻扫）
  // 整批从清单里抹掉（实测：total 125 → 10）。
  const preserve = new Set(Array.isArray(opts.preserveTypes) ? opts.preserveTypes : []);
  if (preserve.size) {
    const have = new Set(merged.map(entryKey));
    for (const pe of prevEntries) {
      if (preserve.has(pe.type) && !have.has(entryKey(pe))) merged.push(pe);
    }
  }

  // v5 数据层：注入随插件分发的预置别名（并集，只增不减）。
  // 放在 manual 合并**之后**——mergeManual 保证人工值跨扫描存活，这一步保证**预置**值
  // 也跨扫描存活（新装机器第一次扫描即生效，无需手工 `cap.mjs alias`）。
  const seeded = applySeedAliases(merged);
  const finalEntries = seeded.entries;

  const d = diff(prevEntries, finalEntries);
  // v2：IDF 索引随清单一起落盘（检索端复用，保证 query 与 scan 同权重口径）
  const { idf } = buildIdf(finalEntries);
  const idfObj = {};
  for (const [k, v] of idf) idfObj[k] = Math.round(v * 1000) / 1000;
  const meta = {
    lastScanAt: scanResult.scannedAt,
    // v4：扫描触发源（boot / <watcher 原因> / rpc / periodic / manual）——审计「清单为何更新」
    lastScanReason: typeof opts.reason === 'string' ? opts.reason : 'manual',
    lastScanProbeErrors: scanResult.probeErrors || [],
    dshHome: scanResult.dshHome,
    counts: countByType(finalEntries),
    version: 2,
    idf: idfObj,
  };
  if (opts.dryRun) return { state: finalEntries.length ? 'ok' : 'empty', diff: d, entries: finalEntries, meta, file: f };
  atomicWrite(f, { entries: finalEntries, meta });
  return { state: finalEntries.length ? 'ok' : 'empty', diff: d, entries: finalEntries, meta, file: f };
}

/** 全量删空（测试/重置用），保留 meta 审计 */
export function clear(file) {
  const f = file || dataFile();
  atomicWrite(f, { entries: [], meta: { clearedAt: new Date().toISOString(), version: 1 } });
  return load(f);
}

function countByType(entries) {
  const c = {};
  for (const t of CAP_TYPES) c[t] = 0;
  for (const e of entries) c[e.type] = (c[e.type] || 0) + 1;
  return c;
}
