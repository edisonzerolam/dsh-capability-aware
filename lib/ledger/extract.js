/**
 * 从会话事件抽取错误记录 —— 本插件的核心映射层。
 *
 * ⚠ 事件形状全部来自**实读取证**（不是推断）：
 *   1. `tool/result` 失败态：`data = {error:{name,code}, message, step, turn}`
 *      —— 工具名不在其中！须经 `data.message.toolCallId` ↔
 *      `tool/call.data.callId` 关联（实测 callId 在 `data.callId`）。
 *   2. `llm/retry`：`data = {retryId, provider, retry, maxRetries, failure:{message,code}}`
 *      —— **带 provider**，是供应商切面的权威来源。
 *   3. `turn/end`：`data.reason.kind === 'error'` 时 `reason.error = {message,code}`。
 *   4. `agent/error`：独立事件（非 session 事件），`{turn, step, error}`。
 *
 * @module dsh-capability-aware/lib/ledger/extract
 */
import { classify } from './classify.js';

/** 会话日志事件类型 → 是否可能是错误（快速预筛，避免为每条事件建对象）。 */
export const ERROR_EVENT_TYPES = new Set(['tool/result', 'llm/retry', 'turn/end', 'assistant/message', 'hook/result']);

/** 从路径/URL 文本里抽出「对象」标识，用于对象切面。 */
export function objectOf(meta, message) {
  if (meta && typeof meta === 'object') {
    if (typeof meta.path === 'string' && meta.path) return { kind: 'path', id: meta.path };
    if (typeof meta.url === 'string' && meta.url) return { kind: 'url', id: meta.url };
    if (typeof meta.command === 'string' && meta.command) return { kind: 'command', id: meta.command };
  }
  const t = typeof message === 'string' ? message : '';
  // ⚠ 顺序：**先引号内**。实测教训——裸匹配 `[A-Za-z]:\\[^\s"']+` 会在
  //   `grantWrite(D:\Program Files\DSH Desktop)` 这类含空格的路径上截成
  //   `D:\Program`，把不同对象聚成一个假桶。
  const quoted = t.match(/["'`]([A-Za-z]:\\[^"'`\r\n]+)["'`]/) || t.match(/["'`](\/(?:[\w.-]+\/)+[\w.-]+)["'`]/);
  if (quoted) return { kind: 'path', id: trimPath(quoted[1]) };
  const win = t.match(/[A-Za-z]:\\[^\r\n"'`<>|]+/);
  if (win) return { kind: 'path', id: trimPath(win[0]) };
  // ⚠ Unix 路径必须**至少两级**。实测教训：宽松的 `(\/[\w./-]{3,})` 会把
  //   「present /ui4」「在 /CodeLib 下」这类**片段**抽成假对象，污染对象切面。
  const unix = t.match(/(?:^|\s)(\/(?:[\w.-]+\/)+[\w.-]+)/);
  if (unix) return { kind: 'path', id: trimPath(unix[1]) };
  const url = t.match(/https?:\/\/[^\s"')]+/);
  if (url) return { kind: 'url', id: url[0] };
  return undefined;
}

/** 去掉路径尾部粘上的标点/英文连接词（`D:\a\b).` → `D:\a\b`）。 */
function trimPath(s) {
  let out = String(s).replace(/[\s,;.)\]，。；、:]+$/, '');
  // 未加引号的裸路径会一路吞到句尾；在「空格 + 英文连接词」处截断，
  // 但**不**在 `Program Files` 这类正常段内空格处截断。
  const CONNECTORS = / (?:is|are|was|were|failed|has|have|does|do|did|cannot|can't|not|but|because|while|when|which|that|to|for|of|in|on|with|from|error|Error)\b/;
  const m = out.match(CONNECTORS);
  if (m && m.index > 3) out = out.slice(0, m.index);
  return out.replace(/[\s,;.)\]，。；、:]+$/, '');
}

function safeJson(v) {
  if (typeof v !== 'string') return v && typeof v === 'object' ? v : undefined;
  try { return JSON.parse(v); } catch { return undefined; }
}

/**
 * 会话级状态机：维护 callId→工具名映射，以及「最近加载的技能」用于技能归因。
 * 每个 Session 一个实例；会话销毁即丢弃。
 */
export class SessionAttribution {
  /** @param {() => ({id?:string, header?:object}|undefined)} sessionRef 惰性取会话元数据 */
  constructor(sessionRef) {
    this.sessionRef = sessionRef;
    this.calls = new Map();      // callId → {name, args, seq, time}
    this.lastSkill = undefined;  // {name, seq, time}
    this.lastPlugin = undefined; // {name, seq, time}
    this.seq = 0;
  }

  meta() {
    const s = this.sessionRef?.();
    const h = s?.header ?? {};
    return {
      session: s?.id,
      cwd: h.cwd,
      parent: h.parentSession,
      origin: h.origin,
      depth: h.delegationDepth,
      preset: h.agentPreset,
    };
  }

  /** 观察一条事件；返回 0..n 条错误记录。 */
  observe(event) {
    if (!event || typeof event.type !== 'string') return [];
    this.seq = event.seq ?? this.seq;
    const out = [];

    // ── 记录上下文（非错误，但归因需要） ──────────────────
    if (event.type === 'tool/call') {
      const d = event.data ?? {};
      this.calls.set(d.callId, {
        name: typeof d.name === 'string' ? d.name : undefined,
        args: safeJson(d.arguments),
        seq: event.seq,
      });
      const args = safeJson(d.arguments);
      if (d.name === 'skill' && typeof args?.name === 'string') {
        this.lastSkill = { name: args.name, seq: event.seq };
      }
      // 记忆：callId 表不设上限会随超长会话线性增长 → 软上限
      if (this.calls.size > 4096) {
        const oldest = this.calls.keys().next().value;
        this.calls.delete(oldest);
      }
      return out;
    }

    if (event.type === 'session/end-seed') return out;

    // ── 上下文富化：request/header 带 config.{provider,model} ─────
    // 实测：`llm/retry` 只有 `provider`，**没有 model**（1650 条样本里 592 条
    // provider 有值而 model 为空）→ 模型切面会退化成只有供应商。用同一会话里
    // 最近一次 request/header 的 config 补上。
    if (event.type === 'request/header') {
      const c = event.data?.config;
      if (c && typeof c === 'object') {
        if (typeof c.provider === 'string' || typeof c.model === 'string') {
          this.lastRequest = { provider: c.provider, model: c.model, seq: event.seq };
        }
      }
      return out;
    }

    const d = event.data ?? {};

    // ── ① 工具失败 ────────────────────────────────────────
    if (event.type === 'tool/result') {
      const err = d.error;
      const isError = err !== undefined || d.message?.isError === true;
      if (!isError) return out;
      const callId = d.message?.toolCallId ?? d.message?.source?.callId;
      const call = callId ? this.calls.get(callId) : undefined;
      const raw = err ?? { name: 'ToolError', code: '', message: textOf(d.message) };
      out.push(this.build(raw, {
        kind: 'tool',
        tool: sanitizeToolName(call?.name),
        args: call?.args,
        object: objectOf(d.meta, textOf(d.message)),
        message: textOf(d.message),
        meta: d.meta,
        seq: event.seq,
        time: event.time,
      }));
      return out;
    }

    // ── ② LLM 层失败 ──────────────────────────────────────
    if (event.type === 'llm/retry') {
      const f = d.failure ?? {};
      out.push(this.build({ name: 'LlmError', code: f.code, message: f.message }, {
        kind: 'llm',
        provider: d.provider ?? this.lastRequest?.provider,
        model: d.model ?? this.lastRequest?.model,
        retry: d.retry,
        maxRetries: d.maxRetries,
        seq: event.seq,
        time: event.time,
      }));
      return out;
    }

    // ── ③ 回合级失败 ──────────────────────────────────────
    if (event.type === 'turn/end') {
      const r = d.reason;
      if (r?.kind !== 'error') return out;
      out.push(this.build(r.error ?? { name: 'TurnError', message: '' }, {
        kind: 'turn',
        turn: d.turn,
        seq: event.seq,
        time: event.time,
      }));
      return out;
    }

    // ── ④ 中断 ────────────────────────────────────────────
    if (event.type === 'assistant/message' && d.message?.interrupted === true) {
      out.push(this.build({ name: 'AbortError', code: 'ABORTED', message: 'assistant message interrupted' }, {
        kind: 'abort',
        turn: d.turn,
        step: d.step,
        seq: event.seq,
        time: event.time,
      }));
      return out;
    }

    return out;
  }

  /** 组装一条记录（统一形状）。 */
  build(raw, ctx) {
    const cls = classify(raw, { kind: ctx.kind });
    const meta = this.meta();
    return {
      v: 1,
      time: ctx.time ?? Date.now(),
      session: meta.session,
      cwd: meta.cwd,
      sessionOrigin: meta.origin,
      delegationDepth: meta.depth,
      agentPreset: meta.preset,
      parentSession: meta.parent,
      seq: ctx.seq,
      turn: ctx.turn,
      step: ctx.step,
      kind: ctx.kind,
      // ── 切面 ──
      tool: ctx.tool,
      skill: this.lastSkill?.name,
      plugin: this.lastPlugin?.name,
      provider: ctx.provider,
      model: ctx.model,
      object: ctx.object,
      // ── 分类 ──
      code: cls.code,
      signature: cls.signature || undefined,
      errorName: cls.name,
      category: cls.category,
      owner: cls.owner,
      retryable: cls.retryable,
      label: cls.label,
      fixHint: cls.fixHint,
      // ── 证据 ──
      message: truncate(ctx.message ?? raw?.message ?? '', 1200),
      rawCode: raw?.code,
      meta: ctx.meta,
      retry: ctx.retry,
      maxRetries: ctx.maxRetries,
    };
  }
}

function textOf(message) {
  if (!message || !Array.isArray(message.content)) return '';
  return message.content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

/** 工具名归属校验：实测 `tool/call.name` 偶尔混入参数文本（如 `bash 2>&1 | ...`）。 */
function sanitizeToolName(name) {
  if (typeof name !== 'string' || !name) return undefined;
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) return undefined;
  return name;
}

function truncate(s, n) {
  const t = typeof s === 'string' ? s : String(s ?? '');
  return t.length <= n ? t : `${t.slice(0, n)}…[+${t.length - n}]`;
}

/**
 * 插件装载错误 → 记录（loader 事件面，权威）。
 * 形状实读自 `@deepseek-ai/cordis-plugin-loader/lib/index.js`：
 *   `emit("loader/partial-dispose", entry, legacy, active)` / `emit("loader/entry-init", entry)`
 */
export function recordFromLoader(kind, entry, extra = {}) {
  const name = entryName(entry);
  const raw = { name: 'PluginLoadError', code: extra.code ?? `LOADER_${kind.toUpperCase()}`, message: extra.message ?? '' };
  const cls = classify(raw, { kind: 'plugin' });
  return {
    v: 1,
    time: Date.now(),
    kind: 'plugin',
    plugin: name,
    pluginKind: kind,
    legacy: extra.legacy,
    active: extra.active,
    code: cls.code,
    errorName: cls.name,
    category: 'plugin',
    owner: cls.owner,
    retryable: cls.retryable,
    label: cls.label,
    fixHint: cls.fixHint,
    message: truncate(extra.message ?? '', 1200),
  };
}

/**
 * entry 可读标识。
 *
 * ⚠ 致命坑（实测、由 dsh-my-guardian 的注释与隔离实例复现确证）：
 *   **绝不访问 `entry.id` getter**。loader 在 `Entry` **构造函数内部** emit
 *   `loader/entry-init`，此刻 `entry.parent.tree` 尚未就绪，读 `entry.id` 会抛
 *   `Cannot read properties of undefined (reading 'tree')`。该异常发生在启动阶段，
 *   会让整个 DSH 服务起不来 —— 守护/审计插件自己炸启动。
 *   只读 `entry.options` 上的 id / name。
 */
function entryName(entry) {
  if (entry === null || typeof entry !== 'object') return '(unknown-entry)';
  const o = entry.options;
  if (o !== null && typeof o === 'object') {
    if (o.id !== undefined && o.id !== null) return String(o.id);
    if (typeof o.name === 'string' && o.name !== '') return o.name;
  }
  if (typeof entry.name === 'string' && entry.name !== '') return entry.name;
  return '(unknown-entry)';
}

export { truncate, sanitizeToolName, textOf };
