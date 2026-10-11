/**
 * 错误分类学 —— 把宿主抛出的 `{name, code, message}` 归到**切面**上。
 *
 * 设计依据（实测取证，400 个会话日志抽样）：
 *   - 工具层错误码共 20 种，形状恒为 `tool/result.data.error = {name, code}`；
 *   - LLM 层错误码集中在 `llm/retry.data.failure = {message, code}`，且
 *     `RATE_LIMIT` 占绝对多数（上游配额/并发），**不是本机代码缺陷**；
 *   - 因此「归谁负责」必须成为一等维度，否则自修复会去修不该修的东西。
 *
 * @module dsh-efficiency/lib/ledger/classify
 */

/** 分类 → 责任方 + 是否值得自动重试。 */
export const CATEGORIES = {
  fs: { owner: 'local', retryable: false, label: '文件系统' },
  sandbox: { owner: 'local', retryable: false, label: '沙箱/权限' },
  tool_args: { owner: 'local', retryable: false, label: '工具参数' },
  tool_missing: { owner: 'local', retryable: false, label: '工具不可用' },
  timeout: { owner: 'local', retryable: true, label: '超时/结果未知' },
  plugin: { owner: 'local', retryable: false, label: '插件装载' },
  web: { owner: 'external', retryable: true, label: '外部网络' },
  llm_quota: { owner: 'provider', retryable: true, label: '模型配额/限流' },
  llm_server: { owner: 'provider', retryable: true, label: '模型服务端' },
  llm_transport: { owner: 'provider', retryable: true, label: '模型链路' },
  llm_timeout: { owner: 'provider', retryable: true, label: '模型超时' },
  llm_empty: { owner: 'provider', retryable: true, label: '模型空响应' },
  abort: { owner: 'user', retryable: false, label: '中断' },
  unknown: { owner: 'unknown', retryable: false, label: '未分类' },
};

/** 错误码 → {category, fixHint}。fixHint 是**可执行**的自修复动作。 */
export const CODE_RULES = {
  // ── 文件系统 ─────────────────────────────────────────────
  FS_NOT_OBSERVED: { category: 'fs', fixHint: '先 read 目标文件再 write/edit（工具要求先观察当前内容）' },
  FS_EDIT_NOT_FOUND: { category: 'fs', fixHint: 'edit 的锚点未命中：先 read 取精确原文（含缩进与换行）' },
  FS_AMBIGUOUS_EDIT: { category: 'fs', fixHint: 'old_string 多处匹配：加长上下文使其唯一' },
  FS_STALE_VERSION: { category: 'fs', fixHint: '文件已被外部修改：重新 read 后在最新内容上重做改动' },
  FS_NOT_FOUND: { category: 'fs', fixHint: '路径不存在：用 glob 定位真实路径，或确认工作目录' },
  FS_NOT_TEXT: { category: 'fs', fixHint: '目标不是文本文件：改用二进制/专用工具' },
  // ── 沙箱 ────────────────────────────────────────────────
  FS_SANDBOX_DENIED: { category: 'sandbox', fixHint: '沙箱策略拒绝：该路径不在可写范围，改路径或提升该次操作范围' },
  SANDBOX_UNAVAILABLE: { category: 'sandbox', fixHint: '本机无可用沙箱后端：改用**不带 sandbox 参数**的工具（如 pwsh 而非 pwsh_safe）' },
  // ── 工具契约 ────────────────────────────────────────────
  UNKNOWN_TOOL: { category: 'tool_missing', fixHint: '工具名不在当前 agent 可见清单：核对拼写，或该工具被 profile/裁剪移除' },
  TOOL_NOT_STARTED: { category: 'tool_missing', fixHint: '工具未启动：多为前置门禁拦截，检查参数与权限' },
  INVALID_ARGS: { category: 'tool_args', fixHint: '参数不合 schema：核对必填项与类型（可选参数不得写 required:false）' },
  // ── 超时 ────────────────────────────────────────────────
  TOOL_TIMEOUT: { category: 'timeout', fixHint: '工具超时：拆分任务、转后台作业或提高超时预算' },
  TOOL_OUTCOME_UNKNOWN: { category: 'timeout', fixHint: '执行结果未知：**先核验副作用**再重试，避免重复写入' },
  // ── 网络 ────────────────────────────────────────────────
  WEB_PROVIDER_CONFIGURED_MISSING: { category: 'web', fixHint: 'web provider 未配置：配置 provider，或改用本地抓取/API 兜底' },
  WEB_PROVIDER_ERROR: { category: 'web', fixHint: 'web provider 报错：换 provider 或退避重试' },
  WEB_REDIRECT_BLOCKED: { category: 'web', fixHint: '重定向被拦：直接请求最终 URL' },
  WEB_BLOCKED_URL: { category: 'web', fixHint: '该 URL 被策略拦截：换可信来源' },
  WEB_UNSUPPORTED_CONTENT_TYPE: { category: 'web', fixHint: '内容类型不支持：改用可解析的来源或先落地为文件' },
  SEARCH_FAILED: { category: 'web', fixHint: '搜索失败：换查询词或换搜索引擎' },
  SEARCH_RAW_OUTPUT_OVERFLOW: { category: 'web', fixHint: '搜索结果过大溢出：收窄查询范围' },
  // ── 模型 ────────────────────────────────────────────────
  RATE_LIMIT: { category: 'llm_quota', fixHint: '上游限流/配额：换模型路由、降并发或等窗口恢复' },
  QUOTA_EXCEEDED: { category: 'llm_quota', fixHint: '配额用尽：切换 provider/model 或补充额度' },
  SERVER: { category: 'llm_server', fixHint: '模型服务端故障：退避重试或切换路由' },
  PI_AI_ERROR: { category: 'llm_server', fixHint: '模型服务端故障：退避重试或切换路由' },
  TRANSPORT: { category: 'llm_transport', fixHint: '链路失败（fetch failed）：检查代理/网络，退避重试' },
  TIMEOUT: { category: 'llm_timeout', fixHint: '模型超时：缩短上下文或提高超时' },
  EMPTY_RESPONSE: { category: 'llm_empty', fixHint: '模型返回空内容：重试；持续出现则换路由' },
  // ── 中断 ────────────────────────────────────────────────
  ABORTED: { category: 'abort', fixHint: '用户/系统中断，不是缺陷' },
  ABORTED_BEFORE_DISPATCH: { category: 'abort', fixHint: '派发前被中断，无副作用' },
  // ── 以下为**真机回填取证后**补充（1650 条样本实测命中频次在注释里） ──
  // edit 工具最高频误用：old_string === new_string（实测 246 条，全账本第一大 unknown）
  EDIT_NO_CHANGE: { category: 'tool_args', fixHint: 'edit 的新旧内容相同 → 说明该改动已存在或写错了锚点；先 read 确认再改' },
  UNKNOWN_JOB: { category: 'tool_args', fixHint: '引用了不存在的后台作业 id：先 job_list 取当前有效 id' },
  SUBAGENT_BUDGET: { category: 'tool_args', fixHint: '子代理耗尽 token 预算未完成：缩小任务范围或提高预算' },
  HOST_CONTRACT: { category: 'plugin', fixHint: '宿主内部契约不匹配（如 ctx.shell.run 不存在）：多为插件与宿主版本不兼容' },
  // 模型侧（turn 层实测：WorkBuddy 积分/loomy 402/内容审查/思考死循环）
  HTTP_402: { category: 'llm_quota', fixHint: '上游余额/积分不足：补充额度或换路由' },
  QUOTA: { category: 'llm_quota', fixHint: '配额用尽：切换 provider/model 或补充额度' },
  AUTH: { category: 'llm_quota', fixHint: '凭据失效/未授权：检查该 provider 的 key 或登录态' },
  INVALID_REQUEST: { category: 'llm_server', fixHint: '上游拒绝请求：常见于内容审查（DataInspectionFailed）或参数越界，改写输入后重试' },
  REASONING_LOOP: { category: 'llm_server', fixHint: '模型思考陷入病态重复被中止：换路由，或降低该任务的开放度' },
  SERVER_ERROR: { category: 'llm_server', fixHint: '服务端故障：退避重试或切换路由' },
  // 工具参数（compress / read_image）
  COMPRESS_RANGE: { category: 'tool_args', fixHint: 'compress 的区间不可用（已压缩/在保护区内/ref 失效）：先用 acp_status 看当前可压区间，别复用旧 ref' },
  IMAGE_UNREADABLE: { category: 'tool_args', fixHint: '图片无法解码或当前模型不支持图片输入：换视觉模型，或先转码为 PNG/JPEG' },
};

/**
 * 无错误码时，用**正文签名**反查专属修法。
 *
 * 为什么必须有：实测无码错误占相当比例，若只按 category 走 FALLBACK_HINTS，
 * 第一大项「old_string and new_string must differ」(248 条) 会退化成泛泛的
 * 「工具参数不合规」——自修复场景里等于没给建议。
 */
const SIGNATURE_RULES = [
  [/old_string and new_string must differ/i, 'EDIT_NO_CHANGE'],
  [/unknown job|no such job/i, 'UNKNOWN_JOB'],
  [/hit its token limit|token budget/i, 'SUBAGENT_BUDGET'],
  [/^\[Compression FAILED/i, 'COMPRESS_RANGE'],
  [/is not a function|is not a constructor/i, 'HOST_CONTRACT'],
  [/as an image|malformed image|unsupported.*image/i, 'IMAGE_UNREADABLE'],
];

/** 兜底：靠错误类名/正文关键词归类。 */
const NAME_RULES = [
  [/^FsError$/, 'fs'],
  [/^Sandbox/, 'sandbox'],
  [/^ToolArgs/, 'tool_args'],
  [/^ToolNotFound/, 'tool_missing'],
  [/^ToolTimeout|^ToolNotStarted/, 'timeout'],
  [/^WebError/, 'web'],
  [/^SearchError/, 'web'],
  [/^AbortError/, 'abort'],
  [/^LlmError|^PiAi/, 'llm_server'],
];

/**
 * 无错误码时从正文派生一个**稳定签名**，作为「同一类错误」的聚合把手。
 *
 * 为什么必须做：实测 1650 条样本里 308 条 `tool/result` 只有 `{name:'ToolError'}`
 * 没有 code，且第一大来源是 edit 的「old_string and new_string must differ」(246 条)。
 * 若不给签名，这些记录在 code 切面里全落空、自修复候选也无法按类聚合。
 *
 * 归一化：去掉 `Error:` 前缀、数字→`<n>`、长 hex/uuid→`<id>`、引号内容保留（路径是证据）。
 */
export function signatureOf(message) {
  let s = typeof message === 'string' ? message : '';
  if (!s) return '';
  s = s.replace(/^Error:\s*/i, '');
  s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>');
  s = s.replace(/\b[0-9a-f]{12,}\b/gi, '<id>');
  s = s.replace(/\d+/g, '<n>');
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

const TEXT_RULES = [
  // ⚠ 顺序即优先级：**具体规则必须排在宽泛规则之前**。实测教训——把
  //   `/rate limit|429|quota/i` 放前面会把「余额不足」和「思考死循环」都吞掉。
  [/old_string and new_string must differ|新旧内容相同/i, 'tool_args'],
  [/unknown job|no such job/i, 'tool_args'],
  [/hit its token limit|token budget|budget exhausted/i, 'tool_args'],
  [/Compression FAILED|no valid ranges parsed|protected zone|already compressed/i, 'tool_args'],
  [/ctx\.\w+\.\w+ is not a function|is not a constructor/i, 'plugin'],
  [/reasoning loop|病态重复|degenerate repetition/i, 'llm_server'],
  [/DataInspectionFailed|inappropriate content|content policy/i, 'llm_server'],
  [/insufficient balance|积分余额不足|没有可用账号|余额查询失败|insufficient_quota|Insufficient Balance/i, 'llm_quota'],
  [/no live agent|must be live|not allowed for this Session/i, 'plugin'],
  [/aborted|terminated/i, 'abort'],
  [/rate limit|too many requests|429|quota|exhausted|concurrency limit|in-?flight request cap/i, 'llm_quota'],
  [/upstream stream ended|internal network failure|50[234]|server error|temporarily unavailable|status code \(no body\)/i, 'llm_server'],
  [/fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|连接失败/i, 'llm_transport'],
  [/idle timeout|stream timeout|timed out/i, 'llm_timeout'],
  [/no content|empty response/i, 'llm_empty'],
  [/sandbox|permission denied|access denied|EACCES|EPERM/i, 'sandbox'],
  [/ENOENT|no such file|cannot find the path/i, 'fs'],
  // 图片/内容类型不匹配（实测「cannot read ... as an image: model 不支持图片」）
  [/as an image|unsupported.*image|malformed image/i, 'tool_args'],
];

/**
 * 归类一个错误。
 * @param {{name?:string, code?:string, message?:string}} error 宿主原始错误对象
 * @param {{kind?:string}} [hint] kind = 'tool' | 'llm' | 'turn' | 'plugin'
 * @returns {{code:string, name:string, category:string, owner:string, retryable:boolean, label:string, fixHint:string}}
 */
export function classify(error, hint = {}) {
  const name = typeof error?.name === 'string' ? error.name : '';
  // ⚠ 宿主在 `turn/end` 里会把无码错误的 code 字面写成 `"UNKNOWN"`（实测 71 条），
  //   若当成真码，code 切面会被这个假桶吞掉全部无码 turn 错误 → 统一视作无码。
  const rawCode = typeof error?.code === 'string' ? error.code : '';
  const code = rawCode && rawCode !== 'UNKNOWN' ? rawCode : '';
  const message = typeof error?.message === 'string' ? error.message : '';

  let rule = code && CODE_RULES[code] ? CODE_RULES[code] : null;
  let category = rule?.category;
  const signature = code ? '' : signatureOf(message);
  // 无码时用签名反查专属规则（既补 category，也补 fixHint）
  let sigRule = null;
  if (!rule && signature) {
    for (const [re, key] of SIGNATURE_RULES) {
      // ⚠ 对 **signature** 匹配，不对 message —— message 带 `Error: ` 前缀，
      //   锚定 `^\[Compression FAILED` 的规则会失配（实测踩过）。
      if (re.test(signature)) { sigRule = CODE_RULES[key]; break; }
    }
  }
  if (!category) category = sigRule?.category;

  if (!category) {
    for (const [re, cat] of NAME_RULES) {
      if (re.test(name)) { category = cat; break; }
    }
  }
  if (!category) {
    for (const [re, cat] of TEXT_RULES) {
      if (re.test(message)) { category = cat; break; }
    }
  }
  if (!category) category = hint.kind === 'plugin' ? 'plugin' : 'unknown';

  const meta = CATEGORIES[category] ?? CATEGORIES.unknown;
  const fixHint = rule?.fixHint
    ?? sigRule?.fixHint
    ?? FALLBACK_HINTS[category]
    ?? '未收录的错误：先看 raw.message 与同签名的历史出现频次';

  return {
    code: code || '',
    signature,
    name: name || '',
    category,
    owner: meta.owner,
    retryable: meta.retryable,
    label: meta.label,
    fixHint,
  };
}

/** 未在 CODE_RULES 里但已有类别的兜底建议。 */
const FALLBACK_HINTS = {
  fs: '文件操作失败：先 read 确认现状再改',
  sandbox: '沙箱/权限拒绝：确认目标路径在允许范围内',
  tool_args: '工具参数不合规：对照 schema 修正',
  tool_missing: '工具不可用：确认它是否在当前 agent 的可见清单里',
  timeout: '超时：拆分或转后台',
  plugin: '插件装载失败：检查该插件的依赖与 peer 兼容性',
  web: '网络层失败：换来源或退避重试',
  llm_quota: '配额/限流：换路由或等窗口',
  llm_server: '服务端故障：退避重试',
  llm_transport: '链路故障：检查网络/代理',
  llm_timeout: '模型超时：缩短上下文',
  llm_empty: '空响应：重试或换路由',
  abort: '中断，非缺陷',
  unknown: '未分类错误：保留原始 message 待人工判定',
};

/** 该类别是否应进入「自修复候选」清单（local + 可执行 hint）。 */
export function isSelfRepairable(cls) {
  return cls.owner === 'local' && cls.category !== 'abort' && cls.category !== 'unknown';
}

export { FALLBACK_HINTS };
