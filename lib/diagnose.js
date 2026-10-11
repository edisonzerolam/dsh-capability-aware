// dsh-efficiency · lib/diagnose.js
//
// 分级诊断 —— 把「错误账本的历史记录」与「监控层的实时事件」合成一份
// **版本化、只读、带证据** 的诊断信封，供 CLI / RPC / 修复提示词消费。
//
// ## 为什么要对齐 dshmarket 的诊断范式
//
// 插件市场「高级 → 诊断」页（`dshmarket/lib/diagnostics.js`）已经定义了一套
// 被客户端消费的信封：
//
//   { schema: 'dsh-market/diagnostics/v1', findings: [{ code, severity, subject, evidence }] }
//
// 它有三条纪律值得照抄，本模块全部遵守：
//
//   1. **版本化 schema**：消费方按 schema 字符串判能否处理，而不是猜字段。
//   2. **evidence 必须带 `basis`**：市场版写 `'manifest-declaration'`，并明确
//      注释「不检查已解析的依赖树」。**看到什么就说什么，不假装看到没看到的。**
//   3. **只读**：诊断不改任何东西；修不修由人决定。
//
// ## 与市场诊断的分工（互补，不重复）
//
//   市场诊断：看**静态 manifest**（装之前）——依赖声明是否合规。
//   本模块：  看**运行期真实报错 + 资源事件**（跑起来之后）——哪里真的在坏。
//
// ## 分级（P0–P3）的判据是「确定性」，不是「严重程度」
//
// 这是本模块最重要的设计立场。一个 P0 未必比 P1 更「严重」，但它**一定**是
// 确定的事实而非推断：
//
//   P0  宿主/加载器自己报出的确定失败（插件装载失败、加载器 dispose 异常）。
//       不需要任何推断——宿主已经说了「它坏了」。
//   P1  本机可修且证据充分的运行期错误（文件系统契约违反、沙箱不可用）。
//       有明确的错误码 + 明确的修法，且责任方是 local。
//   P2  需要推断的或影响面较小的（会话停滞、IO 尖峰、参数类误用）。
//   P3  **不该由本机修**的（供应商配额/限流/断流）。列出来是为了让人看到
//       「你的时间花在哪」，但**绝不进修复提示词**。
//
// 实测依据：全量回填 11744 条里 provider 类占 40.6%（RATE_LIMIT 2790 +
// SERVER 1090 + TIMEOUT 430 + TRANSPORT 283 …）。如果诊断不区分 owner，
// 修复提示词会让 agent 去「修」模型供应商的限流——那是纯浪费，且会掩盖真问题。

import { classify } from './ledger/classify.js';

/** 诊断信封 schema（对齐 dshmarket 的版本化约定）。 */
export const DIAGNOSTIC_SCHEMA = 'dsh-efficiency/diagnostics/v1';

/**
 * 确定性优先级。
 *
 * ⚠ `P3` 的语义是「不是本机该修的」，不是「不严重」。它进报告、不进修复提示词。
 */
export const SEVERITIES = {
  P0: { rank: 0, label: '确定故障', owner: 'local', fixable: true },
  P1: { rank: 1, label: '本机可修', owner: 'local', fixable: true },
  P2: { rank: 2, label: '需推断/低影响', owner: 'local', fixable: true },
  P3: { rank: 3, label: '非本机问题', owner: 'provider', fixable: false },
};

/**
 * 错误码 → 优先级。**未列出的码走 `severityOf()` 的兜底推断**，不在这里穷举。
 *
 * 分档理由写在每条的注释里——「为什么它是这一档」比「它是这一档」重要，
 * 否则后来者会按直觉重新分档。
 */
export const SEVERITY_RULES = {
  // ── P0：宿主自己报的确定失败 ──────────────────────────────
  // 加载器/宿主契约层面的失败。不是「用错了工具」，是「东西真的坏了」。
  LOADER_DISPOSE: { severity: 'P0', note: '插件卸载/装载期加载器报错，宿主已判定失败' },
  PLUGIN_FAILED: { severity: 'P0', note: '插件 Fiber 阶段为 failed，宿主已判定加载失败' },
  HOST_CONTRACT: { severity: 'P0', note: '宿主契约违反（如 no live agent / stale goal ref），需宿主侧修复' },

  // ── P1：本机可修、证据充分 ────────────────────────────────
  // 全部围绕「先 read 再 edit」与「沙箱后端不可用」两类确定性契约。
  // 实测这组是本机最大的真可修项（约 700 条/全量）。
  FS_EDIT_NOT_FOUND: { severity: 'P1', note: 'edit 锚点未命中：需先 read 取精确原文' },
  FS_NOT_OBSERVED: { severity: 'P1', note: '未先读就写：DSH 文件契约要求先观察' },
  FS_STALE_VERSION: { severity: 'P1', note: '文件已被改动：需重新 read 后 rebase 再改' },
  FS_AMBIGUOUS_EDIT: { severity: 'P1', note: '锚点不唯一：需扩大上下文使锚点唯一' },
  FS_NOT_FOUND: { severity: 'P1', note: '目标不存在：路径或名字有误' },
  FS_NOT_TEXT: { severity: 'P1', note: '目标不是文本文件，不能按文本编辑' },
  FS_SANDBOX_DENIED: { severity: 'P1', note: '沙箱策略拒绝：这是策略判定，不是命令 bug' },
  SANDBOX_UNAVAILABLE: { severity: 'P1', note: '本机无可用沙箱后端：应改用不带 sandbox 参数的工具' },
  UNKNOWN_TOOL: { severity: 'P1', note: '工具名不存在：可能是名字写错或插件未加载' },
  EDIT_NO_CHANGE: { severity: 'P1', note: 'old_string 与 new_string 相同：调用方逻辑问题' },
  COMPRESS_RANGE: { severity: 'P1', note: '压缩范围无法锚定：区间引用失效' },
  IMAGE_UNREADABLE: { severity: 'P1', note: '文件不是可读图像：格式或路径问题' },

  // ── P2：需推断或影响面小 ──────────────────────────────────
  TOOL_OUTCOME_UNKNOWN: { severity: 'P2', note: '执行结果未知：需先核验副作用，勿盲目重试' },
  TOOL_TIMEOUT: { severity: 'P2', note: '工具超时：可能只是任务过大' },
  INVALID_ARGS: { severity: 'P2', note: '参数不合法：调用方拼装问题' },
  UNKNOWN_JOB: { severity: 'P2', note: '后台任务引用失效' },
  SUBAGENT_BUDGET: { severity: 'P2', note: '子代理预算耗尽' },
  REASONING_LOOP: { severity: 'P2', note: '推理陷入重复：需换策略而非重试' },
  SEARCH_FAILED: { severity: 'P2', note: '搜索失败：可能是查询或服务问题' },
  SEARCH_RAW_OUTPUT_OVERFLOW: { severity: 'P2', note: '搜索原始输出过大被截断' },

  // ── P3：不是本机该修的 ────────────────────────────────────
  // 供应商配额/限流/断流/网络。**这些占了实测错误的四成**，
  // 列出来是为了让「时间花在哪」可见，但绝不进修复提示词。
  RATE_LIMIT: { severity: 'P3', note: '模型供应商限流：改本机代码无用' },
  QUOTA_EXCEEDED: { severity: 'P3', note: '配额耗尽：需充值/换模型，非代码问题' },
  QUOTA: { severity: 'P3', note: '配额类失败' },
  AUTH: { severity: 'P3', note: '鉴权失败：凭据问题' },
  INVALID_REQUEST: { severity: 'P3', note: '上游拒绝请求：需核对模型/参数兼容性' },
  SERVER: { severity: 'P3', note: '上游 5xx：供应商侧故障' },
  SERVER_ERROR: { severity: 'P3', note: '上游 5xx：供应商侧故障' },
  TRANSPORT: { severity: 'P3', note: '传输层失败：网络或上游连接' },
  TIMEOUT: { severity: 'P3', note: '模型请求超时：路由/供应商侧' },
  EMPTY_RESPONSE: { severity: 'P3', note: '上游返回空内容：供应商侧' },
  HTTP_402: { severity: 'P3', note: '上游 402：计费问题' },
  WEB_PROVIDER_CONFIGURED_MISSING: { severity: 'P2', note: '网页抓取供应商未配置：配置问题' },
  WEB_PROVIDER_ERROR: { severity: 'P3', note: '网页抓取供应商报错' },
  WEB_REDIRECT_BLOCKED: { severity: 'P2', note: '重定向被策略拦截' },
  WEB_BLOCKED_URL: { severity: 'P2', note: '目标 URL 被策略拦截' },
  WEB_UNSUPPORTED_CONTENT_TYPE: { severity: 'P2', note: '内容类型不支持' },
};

/**
 * 监控层事件码 → 优先级。
 *
 * 与错误码分开是因为**判据不同**：错误码的确定性来自「宿主报了什么错」，
 * 监控事件的确定性来自「这是测量值还是推断值」（见 `lib/monitor/detect.js`
 * 的分档注释）。两者不能混用同一张表。
 */
export const MONITOR_SEVERITY = {
  PLUGIN_FAILED: 'P0',   // 宿主自己报的 Fiber 阶段，确定
  PROCESS_GONE: 'P1',    // 进程真的不在了，确定
  HOT_PROCESS: 'P1',     // 测量值（GetProcessTimes 差分）
  MEMORY_GROWTH: 'P1',   // 测量值
  IO_STORM: 'P2',        // 测量值，但影响不确定
  SESSION_STALL: 'P2',   // **推断**，最弱
};

/**
 * 兜底分档：规则表没命中时按 `classify()` 的责任方推断。
 *
 * 宁可归到 P2（可修但需人看）也不要归 P0 —— 把不确定的东西说成「确定故障」
 * 是诊断系统最容易犯的错。
 */
function severityOf(rec) {
  const code = rec.code || rec.signature || rec.errorName || '';
  const rule = SEVERITY_RULES[code];
  if (rule) return { severity: rule.severity, note: rule.note };

  const cls = rec.category ? rec : classify(null, { message: rec.message, code: rec.code });
  if (cls.owner === 'provider') return { severity: 'P3', note: '责任方为模型供应商' };
  if (cls.owner === 'user') return { severity: 'P2', note: '用户主动中断' };
  if (cls.owner === 'external') return { severity: 'P2', note: '外部服务问题' };
  return { severity: 'P2', note: '未归类：需人工判断' };
}

/**
 * 生成诊断信封。
 *
 * @param {object[]} records  账本记录（`lib/ledger/extract.js` 的形状）
 * @param {object}   opts
 * @param {number}   opts.since        只诊断此时间之后的记录（epoch ms）
 * @param {number}   opts.minCount     单条 finding 的最少出现次数（默认 3）
 * @param {object}   opts.monitor      监控层上下文 `{ events, procs, sessions, plugins }`
 * @param {number}   opts.topK         每档最多返回几条（默认 20）
 * @param {number}   opts.correlateMs  错误与资源事件的时间相关窗口（默认 5 分钟）
 */
export function diagnose(records, opts = {}) {
  const since = Number.isFinite(opts.since) ? opts.since : 0;
  const minCount = Number.isFinite(opts.minCount) ? opts.minCount : 3;
  const topK = Number.isFinite(opts.topK) ? opts.topK : 20;
  const correlateMs = Number.isFinite(opts.correlateMs) ? opts.correlateMs : 5 * 60 * 1000;

  const monitor = opts.monitor ?? {};
  const monitorEvents = Array.isArray(monitor.events) ? monitor.events : [];
  const procs = Array.isArray(monitor.procs) ? monitor.procs : [];

  const findings = [];

  // ── 一、错误账本聚合 ────────────────────────────────────────
  const bySig = new Map();
  for (const r of records) {
    if (!r || (r.time ?? 0) < since) continue;
    const code = r.code || r.signature || r.errorName || 'UNKNOWN';
    const sig = `${r.kind}:${code}:${r.tool ?? r.object?.kind ?? ''}`;
    let e = bySig.get(sig);
    if (!e) {
      e = {
        code, signature: sig, textSignature: r.signature, errorName: r.errorName,
        kind: r.kind, tool: r.tool, skill: r.skill, category: r.category,
        owner: r.owner, count: 0, sessions: new Set(), objects: new Set(),
        firstTime: Infinity, lastTime: 0, lastMessage: '', fixHint: r.fixHint,
      };
      bySig.set(sig, e);
    }
    e.count += 1;
    if (r.session) e.sessions.add(r.session);
    if (r.object?.id) e.objects.add(r.object.id);
    e.firstTime = Math.min(e.firstTime, r.time ?? Infinity);
    if ((r.time ?? 0) >= e.lastTime) {
      e.lastTime = r.time ?? 0;
      if (r.message) e.lastMessage = r.message;
      if (r.fixHint) e.fixHint = r.fixHint;
    }
    // 保留最确定的 owner（local 优先于 provider）——同一码被不同路径归因时，
    // 取「更可能该本机修」的那个，避免把真问题降级成 P3 藏起来。
    if (r.owner === 'local') e.owner = 'local';
    else if (!e.owner) e.owner = r.owner;
  }

  for (const e of bySig.values()) {
    if (e.count < minCount) continue;
    const { severity, note } = severityOf(e);
    const meta = SEVERITIES[severity];
    // 一致性收口：档位与 owner 必须自洽 —— 档位说「本机该修」（fixable），
    // owner 就不能写 provider。二者不一致时**以档位为准**（规则表是按码人工
    // 分档的，比 classify 的文本启发式更可信），但把原始归因留在 `ownerRaw`，
    // 不隐瞒分歧（对齐「看到什么就说什么」）。
    const owner = meta.fixable ? 'local' : (e.owner ?? meta.owner);
    const ownerRaw = e.owner;
    const hostHot = hostCpuHot(procs);
    const correlated = correlate(e, monitorEvents, correlateMs);
    findings.push({
      code: e.code,
      severity,
      subject: {
        kind: e.tool ? 'tool' : e.skill ? 'skill' : e.objects.size ? 'object' : 'error',
        name: e.tool || e.skill || [...e.objects][0] || e.code,
      },
      count: e.count,
      sessionCount: e.sessions.size,
      firstTime: Number.isFinite(e.firstTime) ? e.firstTime : undefined,
      lastTime: e.lastTime || undefined,
      message: e.lastMessage,
      fixHint: e.fixHint,
      textSignature: e.textSignature !== e.code ? e.textSignature : undefined,
      evidence: {
        basis: 'error-ledger-records',
        severityNote: note,
        owner,
        ownerRaw: ownerRaw && ownerRaw !== owner ? ownerRaw : undefined,
        category: e.category,
        kind: e.kind,
        samples: [...e.objects].slice(0, 5),
        correlatedWith: correlated.length ? correlated : undefined,
        hostCpuHot: hostHot ? true : undefined,
      },
    });
  }

  // ── 二、监控层事件 ──────────────────────────────────────────
  for (const ev of monitorEvents) {
    if (!ev || (ev.time ?? 0) < since) continue;
    const sev = MONITOR_SEVERITY[ev.code];
    if (!sev) continue;
    findings.push({
      code: ev.code,
      severity: sev,
      subject: ev.subject
        ? { kind: String(ev.subject).includes(':') ? String(ev.subject).split(':')[0] : 'resource',
            name: String(ev.subject).includes(':') ? String(ev.subject).split(':').slice(1).join(':') : ev.subject }
        : { kind: 'resource', name: ev.code },
      count: ev.count ?? 1,
      sessionCount: 0,
      lastTime: ev.time,
      message: ev.message ?? ev.evidence?.reason ?? '',
      evidence: {
        basis: ev.evidence?.basis ?? 'monitor-detector',
        severityNote: sev === 'P0' ? '宿主已判定失败' : '监控层测量/推断',
        ...(ev.evidence ? { detail: ev.evidence } : {}),
      },
    });
  }

  // ── 三、合并同码 finding（账本与监控可能报同一件事） ────────
  const merged = new Map();
  for (const f of findings) {
    const key = `${f.code}|${f.subject.kind}:${f.subject.name}`;
    const prev = merged.get(key);
    if (!prev) { merged.set(key, f); continue; }
    // 取更确定的档位（rank 小者）
    const keep = SEVERITIES[f.severity].rank < SEVERITIES[prev.severity].rank ? f : prev;
    const other = keep === f ? prev : f;
    keep.count += other.count;
    keep.sessionCount += other.sessionCount;
    keep.lastTime = Math.max(keep.lastTime ?? 0, other.lastTime ?? 0) || undefined;
    keep.evidence = { ...other.evidence, ...keep.evidence };
    merged.set(key, keep);
  }

  const all = [...merged.values()].sort((a, b) => {
    const d = SEVERITIES[a.severity].rank - SEVERITIES[b.severity].rank;
    if (d !== 0) return d;
    return (b.count * Math.max(1, b.sessionCount)) - (a.count * Math.max(1, a.sessionCount));
  });

  const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const f of all) counts[f.severity] += 1;

  const bySeverity = {};
  for (const sev of ['P0', 'P1', 'P2', 'P3']) {
    bySeverity[sev] = all.filter((f) => f.severity === sev).slice(0, topK);
  }

  return {
    schema: DIAGNOSTIC_SCHEMA,
    generatedAt: Date.now(),
    since: since || undefined,
    minCount,
    totalFindings: all.length,
    counts,
    /** 可修（P0/P1/P2）——这些进修复提示词。 */
    fixable: all.filter((f) => SEVERITIES[f.severity].fixable),
    /** 不可修（P3）——**绝不进修复提示词**，只用于让人看到时间花在哪。 */
    notFixable: all.filter((f) => !SEVERITIES[f.severity].fixable),
    bySeverity,
  };
}

/** Host 进程当前是否在热点区间（供 `correlatedWith` 的 CPU 维度）。 */
function hostCpuHot(procs) {
  const host = procs.find((p) => p.kind === 'host');
  if (!host || host.cpuPct == null) return null;
  return host.cpuPct >= 80 ? host : null;
}

/**
 * 把一条错误与时间窗内的监控事件关联起来。
 *
 * **这是相关性，不是因果。** 输出字段名就叫 `correlatedWith`，且每条都带
 * `deltaMs` 让人自己判断。绝不写成「因为」。
 */
function correlate(entry, events, windowMs) {
  if (!events.length || !entry.lastTime) return [];
  const out = [];
  for (const ev of events) {
    if (!ev || !ev.time) continue;
    const delta = Math.abs(ev.time - entry.lastTime);
    if (delta > windowMs) continue;
    out.push({ code: ev.code, subject: ev.subject, deltaMs: ev.time - entry.lastTime, severity: MONITOR_SEVERITY[ev.code] });
  }
  return out.sort((a, b) => Math.abs(a.deltaMs) - Math.abs(b.deltaMs)).slice(0, 5);
}

/** 人类可读渲染（CLI 用）。 */
export function renderDiagnostics(d, opts = {}) {
  const lines = [];
  const t = (x) => (x ? new Date(x).toISOString().replace('T', ' ').slice(0, 19) : '-');
  lines.push(`诊断信封：${d.schema}`);
  lines.push(`生成于 ${t(d.generatedAt)}　窗口起点 ${t(d.since)}　最少出现 ${d.minCount} 次`);
  lines.push(`共 ${d.totalFindings} 条 finding：P0=${d.counts.P0} P1=${d.counts.P1} P2=${d.counts.P2} P3=${d.counts.P3}`);
  lines.push(`　可修（进修复提示词）：${d.fixable.length}　不可修（供应商/外部，仅展示）：${d.notFixable.length}`);
  lines.push('');

  for (const sev of ['P0', 'P1', 'P2', 'P3']) {
    const list = d.bySeverity[sev] ?? [];
    if (!list.length) continue;
    const meta = SEVERITIES[sev];
    lines.push(`── ${sev} ${meta.label}（${list.length} 条${meta.fixable ? '' : ' · 不进修复提示词'}）`);
    for (const f of list) {
      const hot = f.evidence?.hostCpuHot ? ' · Host CPU 热点' : '';
      const corr = f.evidence?.correlatedWith?.length ? ` · 关联 ${f.evidence.correlatedWith.map((c) => c.code).join('/')}` : '';
      lines.push(`  ▸ ${f.code}　${f.count} 次 / ${f.sessionCount} 会话${hot}${corr}`);
      lines.push(`     主体：${f.subject.kind}:${f.subject.name}`);
      if (f.textSignature) lines.push(`     文本签名：${String(f.textSignature).slice(0, 140)}`);
      if (f.fixHint) lines.push(`     建议：${f.fixHint}`);
      if (f.evidence?.severityNote) lines.push(`     分档依据：${f.evidence.severityNote}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
