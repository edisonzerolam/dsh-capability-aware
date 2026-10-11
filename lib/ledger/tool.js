// dsh-capability-aware · lib/ledger/tool.js
// `error_ledger_query` 的**纯逻辑**（零宿主依赖 → 可单测）。
// index.js 用 @deepseek-ai/dsh-tools 的 defineTool 包装后经 ctx.tools.register 注册。
//
// 设计立场（与 capability-aware 同源）：
//   · 工具面只放 1 个（实测：同轮工具 ≥5 个会触发首轮裁剪）；视图用 `view` 参数区分。
//   · 返回值是**给人/agent 直接读的文本**，不是 JSON 转储——JSON 走 RPC/CLI。
//   · 任何视图都必须带「证据」：时间、会话、原始 message 片段。没有证据的结论
//     在自修复场景里比没有结论更危险。

import { readRecords } from './store.js';
import { rollup, selfRepairCandidates, serializeFacets, dayOf } from './rollup.js';

export const TOOL_NAME = 'error_ledger_query';

export const TOOL_DESCRIPTION =
  '查询本机 DSH 会话错误账本（按插件／技能／对象／错误码／责任方等切面聚合的报错历史）。'
  + '当你要排查反复出现的报错、怀疑是某个插件的系统性问题、或需要为「自修复」定位高优先级缺陷时使用。'
  + '支持：recent（最近明细）、facets（切面聚合）、repair（自修复候选，只含本机可修项）、'
  + 'search（按关键词检索）、report（概览）。账本由插件在运行期自动记录并回填历史会话，只读不改任何文件。';

export const TOOL_PARAMETERS = {
  // ⚠ 可选参数**不得写 required: false**——DSH 的 JsonSchema 编译器规定
  //   「required must be true when present」，写了就抛 JsonSchemaError（实测）。
  view: { type: 'string', description: '视图：recent（默认）| facets | repair | search | report' },
  key: { type: 'string', description: 'facets 视图的切面名（code/plugin/skill/object/owner/tool/provider/cwd）或 search 的查询词' },
  since: { type: 'string', description: '起始时间：ISO 日期（2026-10-09）或相对时长（7d/24h/90m）' },
  limit: { type: 'number', description: '返回条数上限，默认 20' },
};

/** 解析 `since`：ISO 日期或相对时长。无法解析返回 0（=全部）。 */
export function parseSince(s, now = Date.now()) {
  if (s === undefined || s === null || s === '') return 0;
  const str = String(s).trim();
  const rel = str.match(/^(\d+(?:\.\d+)?)\s*(m|h|d|w)$/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = { m: 60000, h: 3600000, d: 86400000, w: 604800000 }[rel[2].toLowerCase()];
    return now - n * unit;
  }
  const t = Date.parse(str.length === 10 ? `${str}T00:00:00` : str);
  return Number.isFinite(t) ? t : 0;
}

const ICON = { local: '🔧', provider: '☁', external: '🌐', user: '⏹', unknown: '❓' };

/**
 * 构造 error_ledger_query 工具规格（未包装 defineTool 的裸对象）。
 * @param {{dir?: string}} opts
 */
export function buildLedgerTool(opts = {}) {
  const dir = opts.dir;
  return {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: TOOL_PARAMETERS,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const view = String(args?.view ?? 'recent').toLowerCase();
      const limit = Number.isFinite(args?.limit) && args.limit > 0 ? Math.min(args.limit, 200) : 20;
      const since = parseSince(args?.since);
      const read = await readRecords(dir);
      if (!read.existed) {
        return '错误账本为空或尚未初始化：账本随插件运行自动积累（历史会话由启动回填补齐）。'
          + '可执行 CLI `node cap.mjs ledger backfill` 立即回填，或等待 boot 回填。';
      }
      const records = read.records;
      if (!records.length) return `错误账本暂无记录（明细文件已存在，共 0 行；坏行 ${read.badLines}）。`;

      if (view === 'facets') return renderFacets(records, args?.key, since, limit);
      if (view === 'repair') return renderRepair(records, since, limit);
      if (view === 'search') return renderSearch(records, args?.key, since, limit);
      if (view === 'report') return renderReport(records, since);
      return renderRecent(records, since, limit);
    },
  };
}

function fmtTime(t) {
  if (!Number.isFinite(t)) return '?';
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function where(r) {
  const parts = [];
  if (r.tool) parts.push(`tool=${r.tool}`);
  if (r.skill) parts.push(`skill=${r.skill}`);
  if (r.plugin) parts.push(`plugin=${r.plugin}`);
  if (r.provider) parts.push(`provider=${r.provider}${r.model ? `/${r.model}` : ''}`);
  if (r.object?.id) parts.push(`${r.object.kind}=${r.object.id}`);
  return parts.join(' ') || '—';
}

function renderRecent(records, since, limit) {
  const list = records.filter((r) => (r.time ?? 0) >= since).slice(-limit).reverse();
  if (!list.length) return '该时间窗口内无错误记录。';
  const lines = [`最近 ${list.length} 条错误（共 ${records.length} 条明细）：`];
  for (const r of list) {
    lines.push(`· ${fmtTime(r.time)} [${r.code || r.errorName || 'UNKNOWN'}] ${ICON[r.owner] ?? ''}${r.category} ${where(r)}`);
    if (r.message) lines.push(`    ${oneLine(r.message, 200)}`);
  }
  return lines.join('\n');
}

function renderFacets(records, key, since, limit) {
  const r = rollup(records, { since, topK: limit });
  if (!key) {
    const lines = [`错误账本概览：${r.total} 条`];
    for (const f of ['owner', 'category', 'code', 'tool', 'plugin', 'skill', 'object', 'provider', 'cwd']) {
      const rows = r.facets[f] ?? [];
      if (!rows.length) continue;
      lines.push(`\n【${f}】${rows.length} 项`);
      for (const b of rows) lines.push(`  ${b.count}× ${b.key}${b.fixHint ? `  → ${b.fixHint}` : ''}`);
    }
    lines.push('\n用 key=<切面名> 下钻单一维度。');
    return lines.join('\n');
  }
  const rows = r.facets[key];
  if (!rows) {
    return `未知切面「${key}」。可用：owner / category / code / tool / plugin / skill / object / provider / model / cwd。`;
  }
  if (!rows.length) return `切面「${key}」在该时间窗口内无记录。`;
  const lines = [`切面「${key}」：${rows.length} 个键（总 ${r.total} 条）`];
  for (const b of rows) {
    const owner = Object.entries(b.owners).sort((a, c) => c[1] - a[1])[0];
    lines.push(`· ${b.count}× [${owner?.[0] ?? '?'}] ${b.key}  (会话 ${b.sessions.size})`);
    if (b.lastMessage) lines.push(`    最近：${oneLine(b.lastMessage, 180)}`);
    if (b.fixHint) lines.push(`    建议：${b.fixHint}`);
  }
  return lines.join('\n');
}

function renderRepair(records, since, limit) {
  const cands = selfRepairCandidates(records, { since });
  if (!cands.length) return '暂无自修复候选（阈值：同一签名 ≥3 次且责任方为本机）。';
  const lines = [
    `自修复候选 ${Math.min(cands.length, limit)} / ${cands.length} 项`,
    '（只含 owner=local 的签名；provider/external 类错误一律不列——那不是本机能修的）',
  ];
  for (const c of cands.slice(0, limit)) {
    lines.push(`\n▸ ${c.code || c.errorName}  出现 ${c.count} 次 / ${c.sessionCount} 个会话  优先级 ${c.priority}`);
    if (c.textSignature && c.textSignature !== c.code) lines.push(`  文本签名：${oneLine(c.textSignature, 160)}`);
    lines.push(`  类别：${c.category}${c.tool ? `  工具：${c.tool}` : ''}${c.objectKind ? `  对象类型：${c.objectKind}` : ''}`);
    if (c.sampleObjects?.length) lines.push(`  样本对象：${c.sampleObjects.slice(0, 3).join(' | ')}`);
    if (c.fixHint) lines.push(`  建议修法：${c.fixHint}`);
    if (c.lastMessage) lines.push(`  最近证据：${oneLine(c.lastMessage, 220)}`);
  }
  return lines.join('\n');
}

function renderSearch(records, q, since, limit) {
  const needle = String(q ?? '').trim().toLowerCase();
  if (!needle) return '请给出 key=<查询词>（在错误码、正文、工具、技能、对象路径中检索）。';
  const hits = records.filter((r) => {
    if ((r.time ?? 0) < since) return false;
    const hay = [r.code, r.errorName, r.message, r.tool, r.skill, r.plugin, r.object?.id, r.cwd]
      .filter(Boolean).join(' ').toLowerCase();
    return hay.includes(needle);
  });
  if (!hits.length) return `未检索到包含「${q}」的错误。`;
  const lines = [`检索「${q}」：${hits.length} 条`];
  for (const r of hits.slice(-limit).reverse()) {
    lines.push(`· ${fmtTime(r.time)} [${r.code || r.errorName}] ${where(r)}`);
    if (r.message) lines.push(`    ${oneLine(r.message, 200)}`);
  }
  return lines.join('\n');
}

function renderReport(records, since) {
  const r = rollup(records, { since, facets: ['owner', 'category', 'code', 'plugin', 'skill', 'object', 'provider'] });
  const cands = selfRepairCandidates(records, { since });
  const byOwner = Object.fromEntries((r.facets.owner ?? []).map((b) => [b.key, b.count]));
  const lines = [
    `错误账本报告：${r.total} 条`,
    r.firstTime ? `时间跨度：${fmtTime(r.firstTime)} → ${fmtTime(r.lastTime)}` : '',
    '',
    '责任方分布（决定「该不该修」）：',
    `  本机可修 local=${byOwner.local ?? 0}   模型路由 provider=${byOwner.provider ?? 0}   外部网络 external=${byOwner.external ?? 0}   中断 user=${byOwner.user ?? 0}   未分类 unknown=${byOwner.unknown ?? 0}`,
    '',
    'Top 错误码：',
    ...(r.facets.code ?? []).slice(0, 12).map((b) => `  ${b.count}× ${b.key}  (${Object.keys(b.categories)[0] ?? '?'})`),
    '',
    'Top 来源对象：',
    ...(r.facets.object ?? []).slice(0, 8).map((b) => `  ${b.count}× ${b.key}`),
    '',
    'Top 插件 / 技能：',
    ...(r.facets.plugin ?? []).slice(0, 5).map((b) => `  插件 ${b.count}× ${b.key}`),
    ...(r.facets.skill ?? []).slice(0, 5).map((b) => `  技能 ${b.count}× ${b.key}`),
    '',
    `自修复候选：${cands.length} 项（用 view=repair 查看详情）`,
    '按天分布：',
    ...Object.entries(r.byDay).slice(-14).map(([d, n]) => `  ${d}  ${n}`),
  ];
  return lines.filter((l) => l !== '').join('\n');
}

function oneLine(s, n) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}

export { rollup, selfRepairCandidates, serializeFacets, dayOf };
