/**
 * 历史回填 —— 把已存在的会话日志一次性抽成账本明细。
 *
 * 规模（本机实测）：`~/.dsh/sessions` = 22 个 workspace / 3303 个
 * `session.v4.jsonl.zstd` / 1.26 GB。因此三条硬约束：
 *   1. **逐文件处理，不在内存里留全量**（解压后的文本按行消费即丢）；
 *   2. **可中断可续跑**：每个文件记 `{size, mtime, throughSeq, records}`，
 *      未变化的文件直接跳过，变化的从 `throughSeq+1` 继续；
 *   3. **与实时捕获不重叠**：会话级 `liveThroughSeq` 水位线以下的 seq 一律跳过，
 *      避免同一条错误被「实时」和「回填」各记一次。
 *
 * @module dsh-efficiency/lib/ledger/backfill
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { SessionAttribution } from './extract.js';
import { appendRecords, atomicWriteJson, ledgerDir, readJson, paths } from './store.js';
import { decompressAllZstdFrames } from './zstd.js';

/** 会话日志根：`DSH_EFF_DSH_HOME` > `~/.dsh`。 */
export function sessionsRoot() {
  const dshHome = process.env.DSH_EFF_DSH_HOME || join(homedir(), '.dsh');
  return join(dshHome, 'sessions');
}

/** 递归找出全部会话日志（`<root>/<workspace>/<sessionId>/session.v4.jsonl.zstd`）。 */
export async function discoverLogs(root = sessionsRoot(), opts = {}) {
  const out = [];
  let directs = [];
  try {
    directs = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of directs) {
    if (!d.isDirectory()) continue;
    if (opts.workspace && d.name !== opts.workspace) continue;
    const wsDir = join(root, d.name);
    let sessions = [];
    try { sessions = await readdir(wsDir, { withFileTypes: true }); } catch { continue; }
    for (const s of sessions) {
      if (!s.isDirectory()) continue;
      const file = join(wsDir, s.name, 'session.v4.jsonl.zstd');
      try {
        const st = await stat(file);
        if (!st.isFile() || st.size === 0) continue;
        out.push({ file, sessionId: s.name, workspace: d.name, size: st.size, mtimeMs: st.mtimeMs });
      } catch { /* 无日志的会话目录 */ }
    }
  }
  return out;
}

/** 状态文件（水位线），用于续跑与去重。 */
export async function loadBackfillState(dir = ledgerDir()) {
  return (await readJson(paths(dir).meta, undefined))
    ?? { v: 1, files: {}, sessions: {}, lastBackfillAt: undefined, backfillRuns: 0 };
}

export async function saveBackfillState(state, dir = ledgerDir()) {
  await atomicWriteJson(paths(dir).meta, state);
}

/**
 * 回填一批日志。
 * @param {object} [opts]
 * @param {string} [opts.root] 会话日志根
 * @param {string} [opts.workspace] 只回填某 workspace
 * @param {number} [opts.maxFiles] 本次最多处理多少个文件（分批推进用）
 * @param {number} [opts.concurrency] 并发解压数（默认 4；解压是 CPU 密集，别再高）
 * @param {boolean} [opts.force] 忽略水位线，重解全部
 * @param {(p:object)=>void} [opts.onProgress]
 */
export async function backfill(opts = {}) {
  const dir = opts.dir ?? ledgerDir();
  const root = opts.root ?? sessionsRoot();
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 4, 16));
  const state = await loadBackfillState(dir);
  const logs = await discoverLogs(root, { workspace: opts.workspace });

  const pending = [];
  for (const log of logs) {
    const prev = state.files[log.file];
    if (!opts.force && prev && prev.size === log.size && prev.mtimeMs === log.mtimeMs) continue;
    pending.push(log);
  }
  pending.sort((a, b) => b.size - a.size); // 大文件优先，避免最后收尾卡住
  const work = Number.isFinite(opts.maxFiles) && opts.maxFiles > 0 ? pending.slice(0, opts.maxFiles) : pending;

  const result = {
    discovered: logs.length,
    unchanged: logs.length - pending.length,
    processed: 0,
    skippedForLive: 0,
    records: 0,
    badLines: 0,
    torn: 0,
    errors: [],
  };

  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, work.length) }, async () => {
    while (index < work.length) {
      const log = work[index++];
      try {
        const one = await backfillOne(log, state, dir);
        result.processed += 1;
        result.records += one.records;
        result.skippedForLive += one.skippedForLive;
        result.badLines += one.badLines;
        if (one.torn) result.torn += 1;
      } catch (error) {
        result.errors.push({ file: log.file, error: String(error?.message ?? error) });
      }
      opts.onProgress?.({ ...result, current: basename(dirname(log.file)) });
    }
  });
  await Promise.all(workers);

  state.lastBackfillAt = Date.now();
  state.backfillRuns = (state.backfillRuns ?? 0) + 1;
  await saveBackfillState(state, dir);
  return result;
}

/** 处理单个日志文件。返回本文件新增记录数与跳过数。 */
async function backfillOne(log, state, dir) {
  const raw = await readFile(log.file);
  const { content, torn, frameCount } = await decompressAllZstdFrames(raw);
  const sessionId = log.sessionId;
  let sinceSeq = state.sessions[sessionId]?.liveThroughSeq ?? -1;
  const filePrev = state.files[log.file];
  if (!sinceSeq && filePrev?.throughSeq !== undefined) sinceSeq = filePrev.throughSeq;

  const attribution = new SessionAttribution(() => ({
    id: sessionId,
    header: state.sessions[sessionId]?.header,
  }));
  // 回填时 header 从文件内首条含 cwd 的记录推断，供归属使用
  const records = [];
  let badLines = 0;
  let skippedForLive = 0;
  let maxSeq = sinceSeq;
  let sawHeader = false;

  for (const line of content.toString('utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let event;
    try {
      event = JSON.parse(t);
    } catch { badLines += 1; continue; }
    if (!sawHeader && typeof event?.data?.cwd === 'string') {
      attribution.sessionRef = () => ({ id: sessionId, header: event.data });
      state.sessions[sessionId] = { ...(state.sessions[sessionId] ?? {}), header: pickHeader(event.data) };
      sawHeader = true;
    }
    const seq = Number.isFinite(event?.seq) ? event.seq : undefined;
    if (seq !== undefined && seq > maxSeq) maxSeq = seq;
    if (sinceSeq >= 0 && seq !== undefined && seq <= sinceSeq) {
      // 已由实时通道记录过，但仍要喂给归因状态机（callId↔工具名映射）
      attribution.observe(event);
      skippedForLive += 1;
      continue;
    }
    for (const rec of attribution.observe(event)) {
      rec.backfill = true;
      rec.key = `${sessionId}:${rec.seq ?? seq ?? '?'}:${rec.kind}`;
      records.push(rec);
    }
  }

  if (records.length) await appendRecords(records, dir);
  state.files[log.file] = { size: log.size, mtimeMs: log.mtimeMs, throughSeq: maxSeq, records: records.length, frames: frameCount, at: Date.now() };
  const s = state.sessions[sessionId] ?? {};
  state.sessions[sessionId] = { ...s, header: s.header, backfillThroughSeq: maxSeq };
  if (state.sessions[sessionId].backfillThroughSeq === undefined) state.sessions[sessionId].backfillThroughSeq = maxSeq;
  return { records: records.length, skippedForLive, badLines, torn };
}

function pickHeader(h) {
  if (!h || typeof h !== 'object') return undefined;
  const out = {};
  for (const k of ['cwd', 'id', 'origin', 'delegationDepth', 'agentPreset', 'parentSession']) {
    if (h[k] !== undefined) out[k] = h[k];
  }
  return Object.keys(out).length ? out : undefined;
}
