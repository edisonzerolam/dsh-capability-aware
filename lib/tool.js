// dsh-capability-aware · tool.js
// `capability_query` 的**纯逻辑**（零宿主依赖 → 可单测）。
// index.js 用 @deepseek-ai/dsh-tools 的 defineTool 包装后经 ctx.tools.register 注册。
// 设计依据：Claude Skills「description 须同时说做什么 + 何时用」；工具面只放 1 个（防首轮裁剪）。

import { load } from './registry.js';
import { match, idfFor } from './matcher.js';
import { guide } from './guidance.js';
import { briefLines } from './brief.js';
import { checkAuthorities } from './authority-health.js';

export const TOOL_NAME = 'capability_query';

export const TOOL_DESCRIPTION =
  '查询本机 DSH 能力清单与运行环境，返回匹配到的能力及其调用方式。'
  + '当你不确定本机是否具备某项能力／工具／硬件，或要为任务定位正确的调用入口'
  + '（技能、插件、MCP 连接器、自动化任务、记忆库、CLI、硬件、已装软件）时使用；'
  + '无命中时会返回缺失项与补足引导。清单由插件自动维护（启动扫描 + 变更监听 + 每日巡检）。';

export const TOOL_PARAMETERS = {
  query: { type: 'string', required: true, description: '任务意图或能力关键词，例如「抓 B 站字幕」「显卡加速转写」' },
  // ⚠ 可选参数**不得写 required: false**——DSH 的 JsonSchema 编译器规定
  //   「required must be true when present」，写了就抛 JsonSchemaError（实测）。
  topK: { type: 'number', description: '返回候选数，默认 5' },
};

/**
 * 构造 capability_query 工具规格（未包装 defineTool 的裸对象）。
 * @param {{file?: string, maxCandidates?: number}} opts
 */
export function buildCapabilityTool(opts = {}) {
  const file = opts.file;
  const maxCandidates = Number.isFinite(opts.maxCandidates) ? opts.maxCandidates : 5;
  return {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: TOOL_PARAMETERS,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const q = String(args?.query ?? '').trim();
      const reg = load(file);
      if (reg.state !== 'ok') {
        return `能力清单未就绪（state=${reg.state}）。请先执行 scan：CLI \`node cap.mjs scan\`，或调用 /api/capability-aware/scan。`;
      }
      // v5 Bug4：**必须显式传 idf**。旧实现漏传 → match() 退化为常数权重，
      // 「查A股历史行情数据」全候选并列 16 分（agent 真实调用路径，实测确证）。
      // match() 现已内建自愈（缺省即现算），此处显式传是双保险 + 复用缓存。
      const m = match(q, reg.entries, { topK: args?.topK || maxCandidates, idf: idfFor(reg.entries) });
      if (m.kind === 'no_match') {
        const g = guide({ query: q });
        return `未匹配到能力：${g.message}\n补足建议：${g.actions.join(' | ')}\n验证：${g.verify}`;
      }
      if (m.kind === 'empty_registry' || m.kind === 'no_query') {
        return `查询无效（${m.kind}）：请给出具体任务意图关键词。`;
      }
      // v4.4：返回体改为与 CLI `cap.mjs brief` 同款一行式（共享 lib/brief.js，口径单一事实源）
      const cands = (m.candidates || []).slice(0, args?.topK || maxCandidates);
      const head = m.kind === 'ambiguous'
        ? `命中 ${m.candidates.length} 个接近候选（需澄清，按置信度排序）：`
        : '匹配到：';
      const lines = briefLines(cands, head);
      // v5 Bug3：全部候选都不是强命中 → 很可能是**本机能力缺失**，而不是「有一堆弱候选」。
      // 关键：**保留候选**（仍有参考价值），只**追加**缺失引导——附加式修复，
      // 不会把真有能力的查询误判成缺失（最坏是多一句提示）。
      let missHint = '';
      if (m.anyStrong === false) {
        try {
          const g = guide({ query: q });
          missHint = `\n\n⚠ 上述候选命中质量均偏低（可能只是词面相近，并非本机真具备该能力）。`
            + `若确认本机缺少该能力：${g.message}\n补足建议：${g.actions.join(' | ')}\n验证：${g.verify}`;
        } catch { /* 引导失败不影响主结果 */ }
      }
      // 原则④：某域权威不可达时给出统一兜底口径
      let fb = '';
      try {
        const note = checkAuthorities();
        if (note.degraded?.length) {
          fb = `\n⚠ 兜底提示：${note.degraded.join(', ')} 域权威系统不可达，这些域的结论来自本插件索引底稿（非实时）。`;
        }
      } catch { /* 探测失败不影响查询 */ }
      return `${lines.join('\n')}${missHint}${fb}`;
    },
  };
}
