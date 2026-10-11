// dsh-efficiency · lib/ledger/index.js（错误账本 host 半）
//
// 目标（用户原话，m04583）：**记录每个会话的报错信息，按插件／技能／对象以及
// 其他合适的切面进行区分并记录，以备后续自修复与自进化。**
//
// 为什么住在 efficiency 里（用户 m05633 裁决）：
//   「本机有什么能力」与「什么坏了 / 缺什么」是同一个问题的两面 —— 后者正是
//   本插件定位原则④「其他系统出问题我兜底」的落地。做成独立插件会让「能力清单」
//   与「能力失效史」分家，agent 得记住两个工具、两份清单。
//
// 挂载方式：本模块**不自己 apply**，由 lib/index.js 调用
//   `mountLedger(ctx, config, { version })`
// 因此 RPC 前缀是 `/api/efficiency/ledger/*`，段名归 `efficiency:*`。
//
// 架构 —— 三条互不重叠的数据通道：
//   ① 实时捕获：订阅宿主公开事件（`session/event` firehose + `agent/error`
//      + loader 事件）。**只读**，不碰会话日志，不改任何用户文件。
//   ② 历史回填：boot 后在后台把 `~/.dsh/sessions` 里已有的日志抽成账本明细，
//      按「文件 size+mtime / 会话 seq 水位线」跳过已完成部分，可中断可续跑。
//   ③ 交付面：1 个 Agent 工具（`error_ledger_query`）+ RPC + CLI。
//
// ⚠ 三个实测坑（都写进注释，别再踩）：
//   1) 用 `export const inject = [...]` **硬声明** → 无该服务的 profile 里
//      apply() 整体 pending，连核心（捕获/回填）都不跑。RPC 是加分面，
//      核心不得被它绑架 → 一律 `ctx.inject` 软注入。（同 dsh-efficiency）
//   2) 裸 register 不挂 `ctx.effect` → 热重载 duplicate route → 打掉整棵插件树。
//   3) **绝不访问 `entry.id`** —— loader 在 Entry 构造函数内 emit `loader/entry-init`，
//      此时 parent.tree 未就绪，读 getter 抛异常会让整个 DSH 起不来。
//      （由 dsh-my-guardian 注释 + 隔离实例复现确证，见 lib/extract.js entryName）

import fs from 'node:fs';
import path from 'node:path';
import { SessionAttribution, recordFromLoader } from './extract.js';
import { appendRecords, paths, ledgerDir } from './store.js';
import { buildLedgerTool } from './tool.js';
import { backfill, loadBackfillState, saveBackfillState, sessionsRoot } from './backfill.js';
import { rollup, selfRepairCandidates, serializeFacets } from './rollup.js';
import { mountPromptSection } from './prompt-section.js';
import { safeService } from '../svc.js';

/** 账本日志标签（宿主日志里与能力扫描区分开）。 */
const LEDGER_NAME = 'efficiency/ledger';
/** RPC 前缀：挂在 efficiency 的同一 webServer 命名空间下，一个插件一套 API。 */
const LEDGER_BASE = '/api/efficiency/ledger';

/** 同一 (session,turn,step,code) 在此窗口内的重复上报视为同一条（agent/error 与 turn/end 会成对出现）。 */
const DEDUP_WINDOW_MS = 5000;

function jsonOut(res, code, body) {
  try {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body, null, 2));
  } catch { try { res.end(); } catch {} }
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e6) { try { req.destroy(); } catch {} } });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function urlQuery(req) {
  try { return Object.fromEntries(new URL(req.url, 'http://127.0.0.1').searchParams); } catch { return {}; }
}

/**
 * 挂载错误账本（由 lib/index.js 的 apply 调用，本模块不自带 apply）。
 *
 * @param {any} ctx 宿主 Context
 * @param {object} [config] 插件 config 里的 ledger.* 子对象
 * @param {{version?:string, log?:(m:string)=>void, warn?:(m:string)=>void, promptSection?:boolean}} [opts]
 * @returns {{flushNow:Function, runBackfill:Function, stats:object, health:Function, dir:string, promptSection:object}}
 */
function mountLedger(ctx, config, opts = {}) {
  const hostLog = typeof opts.log === 'function' ? opts.log : () => {};
  const hostWarn = typeof opts.warn === 'function' ? opts.warn : () => {};
  const version = opts.version ?? '?';
  const cfg = {
    capture: config?.capture !== false,
    flushMs: Number.isFinite(config?.flushMs) ? config.flushMs : 2000,
    maxPending: Number.isFinite(config?.maxPending) ? config.maxPending : 5000,
    recordInterrupts: config?.recordInterrupts !== false,
    recordLoader: config?.recordLoader !== false,
    backfillOnBoot: config?.backfillOnBoot !== false,
    backfillDelayMs: Number.isFinite(config?.backfillDelayMs) ? config.backfillDelayMs : 8000,
    backfillMaxFiles: Number.isFinite(config?.backfillMaxFiles) ? config.backfillMaxFiles : 0,
    backfillMaxBytes: Number.isFinite(config?.backfillMaxBytes) ? config.backfillMaxBytes : 400 * 1024 * 1024,
    sessionsRoot: typeof config?.sessionsRoot === 'string' ? config.sessionsRoot : undefined,
    dir: typeof config?.dir === 'string' ? config.dir : undefined,
    // 常驻指令面（默认开）：不改用户任何文件，纯运行时贡献。
    // 宿主可经 opts.promptSection 统一否决（efficiency 主开关 promptSection:false）。
    promptSection: config?.promptSection !== false && opts.promptSection !== false,
  };

  const logger = (() => { try { return ctx?.logger || null; } catch { return null; } })();
  const log = (m) => { hostLog(`[ledger] ${m}`); try { logger?.info?.(`[${LEDGER_NAME}] ${m}`); } catch {} };
  const warn = (m) => { hostWarn(`[ledger] ${m}`); try { logger?.warn?.(`[${LEDGER_NAME}] ${m}`); } catch {} };

  const dir = cfg.dir ?? ledgerDir();
  const P = paths(dir);
  const root = cfg.sessionsRoot ?? sessionsRoot();

  // ── 运行时状态 ───────────────────────────────────────────────
  /** sessionId → SessionAttribution（归因状态机） */
  const attr = new Map();
  /** sessionId → 已实时捕获到的最大 seq（回填水位线，防重复） */
  const liveSeq = new Map();
  /** sessionId → session 对象（取 header 用；避免在事件里反复 find） */
  const liveSession = new Map();
  let pending = [];
  let flushTimer = null;
  let dropped = 0;
  const stats = {
    startedAt: Date.now(),
    observedEvents: 0,
    captured: 0,
    written: 0,
    dedup: 0,
    dropped: 0,
    loaderEvents: 0,
    agentErrors: 0,
    sessionsSeen: 0,
    lastWriteAt: undefined,
    lastFlushAt: undefined,
    backfill: undefined,
    backfillState: 'idle',
  };

  function attributionFor(session, id) {
    const sid = id ?? session?.id ?? '(unknown)';
    let a = attr.get(sid);
    if (!a) {
      a = new SessionAttribution(() => liveSession.get(sid) ?? session);
      attr.set(sid, a);
      stats.sessionsSeen = attr.size;
    }
    if (session && !liveSession.has(sid)) liveSession.set(sid, session);
    return { a, sid };
  }

  const recentKeys = new Map(); // dedupKey → time

  function enqueue(records, sid) {
    if (!records.length) return;
    const now = Date.now();
    for (const r of records) {
      if (!cfg.recordInterrupts && r.category === 'abort') continue;
      const k = `${sid}|${r.turn ?? ''}|${r.step ?? ''}|${r.code || r.errorName}`;
      const seen = recentKeys.get(k);
      if (seen !== undefined && now - seen < DEDUP_WINDOW_MS) { stats.dedup += 1; continue; }
      recentKeys.set(k, now);
      pending.push(r);
      stats.captured += 1;
    }
    if (recentKeys.size > 4000) {
      for (const [k, t] of recentKeys) if (now - t > DEDUP_WINDOW_MS) recentKeys.delete(k);
    }
    if (pending.length > cfg.maxPending) {
      const over = pending.length - cfg.maxPending;
      pending = pending.slice(over);
      dropped += over;
      stats.dropped = dropped;
    }
    scheduleFlush();
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => { flushTimer = null; void flushNow(); }, cfg.flushMs);
    try { flushTimer.unref?.(); } catch {}
  }

  async function flushNow() {
    if (!pending.length) { stats.lastFlushAt = Date.now(); return { appended: 0 }; }
    const batch = pending;
    pending = [];
    stats.lastFlushAt = Date.now();
    try {
      await appendRecords(batch, dir);
      stats.written += batch.length;
      stats.lastWriteAt = Date.now();
      return { appended: batch.length };
    } catch (e) {
      // 写失败：放回队首，下次重试（不静默丢弃证据）
      pending = batch.concat(pending);
      warn(`账本落盘失败（已保留 ${pending.length} 条待重试）：${e?.message}`);
      return { appended: 0, error: String(e?.message ?? e) };
    }
  }

  // ── ① 实时捕获 ───────────────────────────────────────────────
  if (cfg.capture) {
    ctx.effect(() => {
      const offs = [];
      offs.push(ctx.on('session/created', (session) => {
        try { attributionFor(session); } catch (e) { warn(`adopt 失败：${e?.message}`); }
      }));
      offs.push(ctx.on('session/event', (session, event) => {
        try {
          stats.observedEvents += 1;
          const sid = session?.id ?? '(unknown)';
          const { a } = attributionFor(session, sid);
          const recs = a.observe(event);
          if (Number.isFinite(event?.seq)) {
            const prev = liveSeq.get(sid) ?? -1;
            if (event.seq > prev) liveSeq.set(sid, event.seq);
          }
          if (recs.length) {
            for (const r of recs) r.live = true;
            enqueue(recs, sid);
          }
        } catch (e) { warn(`事件抽取失败（已跳过）：${e?.message}`); }
      }));
      offs.push(ctx.on('agent/error', ({ agent, turn, step, error }) => {
        try {
          stats.agentErrors += 1;
          const session = agent?.session ?? agent;
          const sid = session?.id ?? '(unknown)';
          const { a } = attributionFor(session, sid);
          const recs = a.observe({ type: 'turn/end', seq: undefined, time: Date.now(), data: { reason: { kind: 'error', error }, turn } });
          for (const r of recs) { r.live = true; r.step = step; r.source = 'agent/error'; }
          enqueue(recs, sid);
        } catch (e) { warn(`agent/error 记录失败：${e?.message}`); }
      }));
      offs.push(ctx.on('session/disposed', (session) => {
        try {
          const sid = session?.id;
          if (sid) {
            // 把水位线固化到状态文件，供下次回填续跑（否则重启后会重放整段）
            void persistLiveSeq(sid, session);
            attr.delete(sid);
            liveSession.delete(sid);
          }
          void flushNow();
        } catch (e) { warn(`会话收尾失败：${e?.message}`); }
      }));
      // 存量会话补归因（插件可能在会话已开始后才加载）。
      // ⚠ 用 safeService：真实 Cordis Context 上 `ctx.sessions` 属性访问会抛
      //   `cannot get property "sessions" without inject`，`?.` 拦不住。
      try { for (const s of safeService(ctx, 'sessions')?.list?.() ?? []) attributionFor(s); } catch {}

      return () => { for (const off of offs) { try { typeof off === 'function' ? off() : off?.dispose?.(); } catch {} } };
    }, `${LEDGER_NAME}: session capture`);

    // 定时兜底 flush（防抖计时器在空闲时可能永远不会被再次触发）
    ctx.effect(() => {
      const iv = setInterval(() => { void flushNow(); }, Math.max(cfg.flushMs, 5000));
      try { iv.unref?.(); } catch {}
      return () => clearInterval(iv);
    }, `${LEDGER_NAME}: ledger flush timer`);
  }

  async function persistLiveSeq(sid, session) {
    try {
      const state = await loadBackfillState(dir);
      const seq = liveSeq.get(sid);
      const header = session?.header ? {
        cwd: session.header.cwd, origin: session.header.origin,
        delegationDepth: session.header.delegationDepth, agentPreset: session.header.agentPreset,
        parentSession: session.header.parentSession,
      } : state.sessions?.[sid]?.header;
      state.sessions = state.sessions ?? {};
      state.sessions[sid] = { ...(state.sessions[sid] ?? {}), liveThroughSeq: Number.isFinite(seq) ? seq : -1, header };
      await saveBackfillState(state, dir);
    } catch (e) { warn(`水位线落盘失败：${e?.message}`); }
  }

  // ── ② 插件装载错误（loader 事件面，权威） ────────────────────
  // ⚠ 受 capture 总开关约束：`capture:false` 的语义是「完全不订阅运行期事件」，
  //   否则关掉捕获后仍会在宿主 loader 上留钩子，与配置承诺不符（单测 T53 覆盖）。
  if (cfg.capture && cfg.recordLoader) {
    ctx.effect(() => {
      const offs = [];
      offs.push(ctx.on('loader/partial-dispose', (entry, legacy, active) => {
        try {
          // 正常卸载不记；只有「已有 fiber 却又被重新 init」这类异常路径值得记
          if (active === false && legacy === undefined) return;
          stats.loaderEvents += 1;
          const rec = recordFromLoader('dispose', entry, { legacy: !!legacy, active: !!active, message: `entry disposed (legacy=${!!legacy}, reactivating=${!!active})` });
          enqueue([rec], `loader:${rec.plugin}`);
        } catch (e) { warn(`loader 记录失败：${e?.message}`); }
      }));
      return () => { for (const off of offs) { try { typeof off === 'function' ? off() : off?.dispose?.(); } catch {} } };
    }, `${LEDGER_NAME}: loader capture`);
  }

  // ── ③ 历史回填（后台，分批，可续跑） ──────────────────────────
  if (cfg.backfillOnBoot) {
    const t = setTimeout(() => { void runBackfill(); }, cfg.backfillDelayMs);
    ctx.effect(() => () => clearTimeout(t), `${LEDGER_NAME}: backfill timer`);
  }

  async function runBackfill(opts = {}) {
    stats.backfillState = 'running';
    const started = Date.now();
    try {
      const state = await loadBackfillState(dir);
      const res = await backfill({
        dir, root,
        maxFiles: opts.maxFiles ?? (cfg.backfillMaxFiles > 0 ? cfg.backfillMaxFiles : undefined),
        concurrency: opts.concurrency ?? 4,
        workspace: opts.workspace,
        force: opts.force === true,
        onProgress: opts.onProgress,
      });
      // 用实时水位线刷新会话记录，避免回填重放已实时捕获的事件
      for (const [sid, seq] of liveSeq) {
        state.sessions = state.sessions ?? {};
        const cur = state.sessions[sid]?.liveThroughSeq ?? -1;
        if (seq > cur) state.sessions[sid] = { ...(state.sessions[sid] ?? {}), liveThroughSeq: seq };
      }
      await saveBackfillState(state, dir);
      stats.backfill = { ...res, durationMs: Date.now() - started };
      stats.backfillState = 'done';
      log(`回填完成：处理 ${res.processed}/${res.discovered} 个日志（跳过未变 ${res.unchanged}），新增 ${res.records} 条明细，跳过已实时捕获 ${res.skippedForLive} 条，耗时 ${Date.now() - started}ms`);
      if (res.errors.length) warn(`回填有 ${res.errors.length} 个文件失败：${res.errors.slice(0, 3).map((e) => `${path.basename(path.dirname(e.file))}:${e.error}`).join(' | ')}`);
      return stats.backfill;
    } catch (e) {
      stats.backfillState = 'failed';
      stats.backfill = { error: String(e?.message ?? e) };
      warn(`回填失败：${e?.message}`);
      return stats.backfill;
    }
  }

  // ── ④ RPC 面（软注入，核心不被它绑架） ───────────────────────
  try {
    ctx.inject(['webServer'], (scoped) => {
      const server = scoped.webServer;
      const handlers = {
        [`${LEDGER_BASE}/stats`]: async (req, res) => jsonOut(res, 200, {
          ...stats, pending: pending.length, dir,
          files: { events: fs.existsSync(P.events) ? fs.statSync(P.events).size : 0, rollup: fs.existsSync(P.rollup) ? fs.statSync(P.rollup).size : 0 },
        }),
        [`${LEDGER_BASE}/recent`]: async (req, res) => {
          const q = urlQuery(req);
          jsonOut(res, 200, await readTail(dir, Number(q.limit) || 50));
        },
        [`${LEDGER_BASE}/facets`]: async (req, res, body) => {
          const q = urlQuery(req);
          const since = Number(q.since) || Number(body?.since) || 0;
          const records = await readAll(dir);
          const r = rollup(records, { since, facets: q.facet ? [q.facet] : undefined, topK: Number(q.topK) || 50 });
          const out = serializeFacets(r);
          jsonOut(res, 200, { total: r.total, byDay: r.byDay, facets: out.facets, sessions: r.sessions.slice(0, 50) });
        },
        [`${LEDGER_BASE}/repair`]: async (req, res) => {
          const q = urlQuery(req);
          const since = Number(q.since) || 0;
          const records = await readAll(dir);
          jsonOut(res, 200, { candidates: selfRepairCandidates(records, { since }) });
        },
        [`${LEDGER_BASE}/flush`]: async (req, res) => jsonOut(res, 200, await flushNow()),
        [`${LEDGER_BASE}/backfill`]: async (req, res, body) => {
          const q = urlQuery(req);
          const opts = {
            force: (q.force ?? body?.force) === 'true' || body?.force === true,
            workspace: q.workspace ?? body?.workspace,
            maxFiles: Number(q.maxFiles ?? body?.maxFiles) || undefined,
          };
          jsonOut(res, 200, await runBackfill(opts));
        },
        [`${LEDGER_BASE}/health`]: async (req, res) => jsonOut(res, 200, health()),
      };
      for (const [p, h] of Object.entries(handlers)) {
        scoped.effect(() => server.register({
          kind: 'exact',
          path: p,
          handler: (req, res) => {
            (async () => {
              try { await h(req, res, await readBody(req)); }
              catch (e) { jsonOut(res, 500, { ok: false, error: String(e?.message || e) }); }
            })();
          },
        }), `${LEDGER_NAME}: route ${p}`);
      }
      log(`RPC 面已挂载 ${Object.keys(handlers).length} 条：${LEDGER_BASE}/*`);
    });
  } catch (e) {
    warn(`webServer 软注入失败：${e?.message}（CLI/工具通路不受影响）`);
  }

  // ── ⑤ Agent 工具面：error_ledger_query ───────────────────────
  // 这是「DSH 跑任务时知不知道错误账本存在」的唯一通道。
  // ⚠ 不把 @deepseek-ai/dsh-tools 写进 peerDependencies：peer 兼容门禁不匹配会
  //   静默禁用整包（本机 web_search-local 前车之鉴）→ 运行时动态 import + 降级。
  try {
    ctx.inject(['tools'], (scoped) => {
      import('@deepseek-ai/dsh-tools')
        .then(({ defineTool }) => {
          const spec = buildLedgerTool({ dir });
          scoped.effect(() => scoped.tools.register(defineTool(spec)), `${LEDGER_NAME}: ${spec.name} tool`);
          log(`Agent 工具已注册：${spec.name}`);
        })
        .catch((e) => warn(`${'error_ledger_query'} 工具注册失败（@deepseek-ai/dsh-tools 不可用）：${e?.message}`));
    });
  } catch (e) {
    warn(`tools 软注入失败：${e?.message}（CLI/RPC 通路不受影响）`);
  }

  // ── ⑥ 常驻指令面（软注入；不改用户任何文件） ────────────────
  // 「装上即被用」的关键：只注册工具不够，实测 agent 不会主动想起它。
  // 这一段把「同一报错反复出现 → 先查账本」写进系统提示词。
  let promptSection = { mounted: false, reason: 'skipped' };
  try {
    promptSection = mountPromptSection(ctx, { version, enabled: cfg.promptSection !== false, log, warn });
  } catch (e) {
    promptSection = { mounted: false, reason: String(e?.message ?? e) };
    warn(`常驻指令面挂载异常：${promptSection.reason}`);
  }

  // ── 健康自检 ────────────────────────────────────────────────
  function health() {
    const now = Date.now();
    const findings = [];
    if (stats.dropped > 0) findings.push({ level: 'warn', code: 'DROPPED_RECORDS', message: `因超出 maxPending(${cfg.maxPending}) 丢弃 ${stats.dropped} 条` });
    if (stats.captured > 0 && stats.lastWriteAt === undefined) findings.push({ level: 'warn', code: 'NEVER_FLUSHED', message: '已捕获记录但从未成功落盘' });
    if (stats.backfillState === 'failed') findings.push({ level: 'warn', code: 'BACKFILL_FAILED', message: stats.backfill?.error });
    if (stats.backfillState === 'idle' && now - stats.startedAt > 300000) findings.push({ level: 'info', code: 'NO_BACKFILL', message: '回填未启动（backfillOnBoot 被关闭？）' });
    if (!promptSection.mounted) findings.push({ level: 'info', code: 'NO_PROMPT_SECTION', message: `常驻指令面未挂载（${promptSection.reason}）：工具仍在，但 agent 不会主动想起账本` });
    return {
      healthy: findings.every((f) => f.level !== 'warn'),
      version,
      dir,
      root,
      uptimeMs: now - stats.startedAt,
      pending: pending.length,
      promptSection,
      stats,
      findings,
    };
  }

  // 返回句柄给宿主半（lib/index.js）与 CLI/测试使用
  return {
    flushNow, runBackfill, stats, health, dir, root, P, cfg,
    promptSection,
    readAll: () => readAll(dir),
    readTail: (n) => readTail(dir, n),
  };
}

async function readAll(dir) {
  const { readRecords } = await import('./store.js');
  return (await readRecords(dir)).records;
}

async function readTail(dir, n) {
  const { readRecords } = await import('./store.js');
  const r = await readRecords(dir, { limit: n });
  return { total: r.total ?? r.records.length, badLines: r.badLines, records: r.records };
}

export { mountLedger, LEDGER_BASE, LEDGER_NAME };
export { readAll, readTail };
