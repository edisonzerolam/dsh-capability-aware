/**
 * 会话层采集（L2）—— 读 `sessionStats` 投影，算**增量**。
 *
 * ## 为什么用投影而不是自己折事件
 *
 * 宿主已有官方投影 `@deepseek-ai/dsh-session-stats`（`dsh-base` bundle 里的
 * `- id: session-stats` 行），`key: 'sessionStats'`，字段：
 *
 * ```
 * turns / steps / llmMs / toolMs / ttftMs / ttftSteps / decodeMs / decodeTokens
 * ```
 *
 * 它由宿主在 `step/start`、`assistant/attempt`、`assistant/message`、
 * `tool/call`、`tool/result`、`step/end`、`turn/end` 上增量维护。
 * 自己重折一遍既是重复劳动，也会与宿主版本漂移。
 *
 * ## 关键契约（`dsh-session-projection/README.zh.md`）
 *
 * - `snapshot(session)` → `{asOfSeq, values}`；`stateOf(session, key)`
 * - **单元表是进程级的**：`key` 是否存在不能当作「逐会话能力信号」——
 *   某个会话从没跑过 turn 时 `sessionStats` 可能就是 undefined，这是正常的，
 *   **不能据此判定宿主不支持该投影**。
 * - 投影快照是**累计值**，故这里一律做差分，落盘只存增量。
 *
 * 本模块**只读**，不注册任何投影、不订阅事件。
 *
 * @module dsh-efficiency/lib/monitor/sessions
 */
import { safeService } from '../svc.js';

/** 上一次快照：sessionId → {asOfSeq, values}。 */
const prev = new Map();

/**
 * 从宿主读当前所有会话的 `sessionStats`。
 *
 * 三层兜底，任何一层不可用都返回 `{source, sessions: [], note}`，
 * **不抛**（监控不能因为宿主 API 缺失就把插件带崩）。
 */
export function readSessions(ctx, { limit = 50 } = {}) {
  const out = [];
  let source = 'none';
  let note = '';

  // ⚠ 必须走 `safeService`，不能写 `ctx?.sessionProjections`。
  //   真机实测（2026-10-11）：真实 Cordis Context 对未 inject 的服务做**属性访问**会抛
  //   `cannot get property "sessionProjections" without inject`，而 `?.` 对会抛的
  //   getter 无效 —— 该异常曾让监控心跳 ticks:0 / errors:45 全部报废。
  const svc = safeService(ctx, 'sessionProjections');
  let list = [];
  try {
    list = safeService(ctx, 'sessions')?.list?.() ?? [];
  } catch (e) {
    note = `sessions.list 失败：${e?.message ?? e}`;
  }
  if (!Array.isArray(list)) list = [];
  if (list.length > limit) list = list.slice(-limit);

  if (svc && typeof svc.stateOf === 'function') {
    source = 'projection';
    for (const s of list) {
      try {
        const st = svc.stateOf(s, 'sessionStats');
        if (!st || typeof st !== 'object') continue;
        out.push({ session: s, stats: st, asOfSeq: typeof svc.snapshot === 'function' ? svc.snapshot(s)?.asOfSeq : undefined });
      } catch { /* 单会话失败不影响其他会话 */ }
    }
  } else if (svc && typeof svc.snapshot === 'function') {
    source = 'projection';
    for (const s of list) {
      try {
        const snap = svc.snapshot(s);
        const st = snap?.values?.sessionStats;
        if (!st || typeof st !== 'object') continue;
        out.push({ session: s, stats: st, asOfSeq: snap.asOfSeq });
      } catch { /* 同上 */ }
    }
  } else {
    // ⚠ 不得直接覆盖 note：`sessions.list` 若已抛错，那条信息才是第一手原因，
    // 用「投影服务不可用」盖掉它会把真正的问题藏起来。两者并存。
    const projNote = 'sessionProjections 服务不可用（该 profile 未装 dsh-session-stats？）';
    note = note ? `${note}；${projNote}` : projNote;
  }

  const rows = out.map(({ session, stats, asOfSeq }) => {
    const id = sessionIdOf(session);
    const p = prev.get(id);
    const d = (k) => {
      const cur = num(stats?.[k]);
      if (cur === null) return null;
      const old = num(p?.values?.[k]);
      return old === null ? cur : Math.max(0, cur - old);
    };
    const row = {
      id,
      title: titleOf(session),
      cwd: cwdOf(session),
      parent: session?.header?.parentSession ?? null,
      origin: session?.header?.origin ?? null,
      asOfSeq: asOfSeq ?? null,
      turns: num(stats?.turns),
      steps: num(stats?.steps),
      // 增量：本周期新消耗的时间（这才是「谁在烧时间」的答案）
      dLlmMs: d('llmMs'),
      dToolMs: d('toolMs'),
      dSteps: d('steps'),
      dTurns: d('turns'),
      llmMs: num(stats?.llmMs),
      toolMs: num(stats?.toolMs),
      decodeTokens: num(stats?.decodeTokens),
    };
    prev.set(id, { values: stats, at: Date.now() });
    return row;
  });

  // 清掉已消失会话的历史，防长跑进程内存单调增长。
  if (prev.size > 200) {
    const alive = new Set(rows.map((r) => r.id));
    for (const k of [...prev.keys()]) if (!alive.has(k)) prev.delete(k);
  }
  return { source, sessions: rows, note: note || undefined };
}

export function resetSessionBaselines() { prev.clear(); }

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
function sessionIdOf(s) {
  try { return String(s?.id ?? s?.header?.id ?? 'unknown'); } catch { return 'unknown'; }
}
function cwdOf(s) {
  try { return s?.header?.cwd ?? null; } catch { return null; }
}
function titleOf(s) {
  try {
    const t = s?.title;
    if (typeof t === 'string' && t) return t;
    if (t && typeof t === 'object' && typeof t.title === 'string') return t.title;
  } catch { /* 忽略 */ }
  return null;
}
