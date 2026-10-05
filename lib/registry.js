// dsh-capability-aware · registry.js
// 能力清单持久层：JSON 快照 + fingerprint 级增量 diff + 扫描错误计数。
// 数据落盘：~/.dsh/data/capability-aware/capabilities.json（topic-trail 先例：插件自有数据目录）。
// 并发纪律（harness-ops §C）：写前即时重读 + 原子替换写（tmp + rename），防并发窗口写坏。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { normalizeEntry, isRecognizable, CAP_TYPES } from './schema.js';
import { buildIdf } from './matcher.js';

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
 * 与扫描结果做 merge，产出 diff。
 * diff 语义：
 *  - added / removed：按 (type,name) 键对比；
 *  - changed：同键但 fingerprint 不同（能力「变了」，如 SKILL.md 改动、插件升级）；
 *  - stale：本地有但扫描不到（多为「能力被移除」→ 触发缺失引导口径）。
 * manual 覆盖尊重：hidden 条目仅记录、不删；manual.aliases/notes 永远保留。
 */
export function diff(prevEntries, scannedEntries) {
  const keyOf = (e) => `${e.type}:${e.name}`;
  const prev = new Map(prevEntries.map((e) => [keyOf(e), e]));
  const next = new Map(scannedEntries.map((e) => [keyOf(e), e]));
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
 * 应用一次扫描结果到清单（写盘）。
 * @returns {{state:'ok'|'empty', diff: object, entries: object[], meta: object}}
 */
export function applyScan(file, scanResult, opts = {}) {
  const f = file || dataFile();
  const prev = load(f);
  const { entries: prevEntries } = prev;
  const scanned = (scanResult.entries || []).map((raw) => normalizeEntry(raw)).filter((r) => r.ok).map((r) => r.entry);

  // 以扫描产出为准重建，但尊重 manual 字段
  const prevByKey = new Map(prevEntries.map((e) => [`${e.type}:${e.name}`, e]));
  const merged = scanned.map((e) => {
    const p = prevByKey.get(`${e.type}:${e.name}`);
    if (!p) return e;
    return {
      ...e,
      description: e.manual?.notes ? e.manual.notes : e.description,
      manual: { ...p.manual, ...(e.manual || {}) },
    };
  });

  // v4：部分探针扫描（轻量重扫）时，保留本次未覆盖类型的既有条目——
  // 否则反应式轻扫会把 hardware/software（PowerShell 慢探针，本就不参与轻扫）
  // 整批从清单里抹掉（实测：total 125 → 10）。
  const preserve = new Set(Array.isArray(opts.preserveTypes) ? opts.preserveTypes : []);
  if (preserve.size) {
    const have = new Set(merged.map((e) => `${e.type}:${e.name}`));
    for (const pe of prevEntries) {
      if (preserve.has(pe.type) && !have.has(`${pe.type}:${pe.name}`)) merged.push(pe);
    }
  }

  const d = diff(prevEntries, merged);
  // v2：IDF 索引随清单一起落盘（检索端复用，保证 query 与 scan 同权重口径）
  const { idf } = buildIdf(merged);
  const idfObj = {};
  for (const [k, v] of idf) idfObj[k] = Math.round(v * 1000) / 1000;
  const meta = {
    lastScanAt: scanResult.scannedAt,
    // v4：扫描触发源（boot / <watcher 原因> / rpc / periodic / manual）——审计「清单为何更新」
    lastScanReason: typeof opts.reason === 'string' ? opts.reason : 'manual',
    lastScanProbeErrors: scanResult.probeErrors || [],
    dshHome: scanResult.dshHome,
    counts: countByType(merged),
    version: 2,
    idf: idfObj,
  };
  if (opts.dryRun) return { state: merged.length ? 'ok' : 'empty', diff: d, entries: merged, meta, file: f };
  atomicWrite(f, { entries: merged, meta });
  return { state: merged.length ? 'ok' : 'empty', diff: d, entries: merged, meta, file: f };
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
