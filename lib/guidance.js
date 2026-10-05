// dsh-capability-aware · guidance.js
// 缺失引导：把 matcher 的 no_match / registry 的 stale 条目转成用户可执行的补足建议。
// 原则：明确告知「缺什么」+「去哪补」+「补完怎么验证」；不瞎建议（未核验的安装源不写具体 URL）。

import { GUIDANCE_BY_TYPE, CAP_TYPES } from './schema.js';

/**
 * 从查询文本猜测最可能的能力类型（用于 no_match 时给针对性口径）。
 * 规则词表可随需求增补，v1 只做保守映射。
 */
const TYPE_HINT_WORDS = {
  skill: ['技能', 'skill', '自动化流程', '路由'],
  plugin: ['插件', 'plugin', '面板', '悬浮'],
  mcp: ['连接器', 'mcp', 'server', '外部工具', '工具目录'],
  memory: ['记忆', 'memory', '备忘'],
  knowledge: ['知识库', '知识', 'hindsight'],
  automation: ['定时', '自动', '每天', '每周', '计划任务', 'cron'],
  tool: ['命令行', 'cli', '工具链'],
  // v3：硬件/软件类型猜测（MCP 官方 registry 语义：name/description 即发现面）
  hardware: ['显卡', 'gpu', '显存', 'cpu', '内存', '硬盘', '磁盘', '算力', '加速', '硬件', '转写快不快'],
  software: ['软件', '安装', '装了', '没装', '程序', '工具链', 'ffmpeg', 'docker', 'python', 'node'],
};

export function guessType(query) {
  const q = String(query || '').toLowerCase();
  let best = null;
  let bestHits = 0;
  for (const [type, words] of Object.entries(TYPE_HINT_WORDS)) {
    const hits = words.filter((w) => q.includes(w.toLowerCase())).length;
    if (hits > bestHits) { best = type; bestHits = hits; }
  }
  return best; // null = 猜不出
}

/**
 * 生成缺失报告。
 * @param {{query?: string, missingName?: string, missingType?: string, stale?: object[]}} input
 * @returns {kind:'missing'|'stale', message, actions[], verify}
 */
export function guide(input = {}) {
  const { query, missingName, missingType, stale } = input;

  // 情形 A：检索无命中 → 按查询猜类型；猜不出给通用口径
  if (query && !missingName) {
    const t = guessType(query);
    const g = (t && GUIDANCE_BY_TYPE[t]) || {
      hint: '未识别到具体能力类型。请描述更具体（例如「需要一个抓 B 站字幕的技能」「需要 token 用量面板插件」），或先跑 cap list 看现有能力。',
      command: 'node cap.mjs list   # 查看当前能力清单',
    };
    return {
      kind: 'missing',
      missing: { query, guessedType: t },
      message: `当前能力清单中没有匹配「${query}」的能力${t ? `（按描述猜测最接近的能力类型：${t}）` : ''}。`,
      actions: [g.hint, g.command ? `补足方式：${g.command}` : null].filter(Boolean),
      verify: '补足后重跑 `node cap.mjs scan`，再 `node cap.mjs query "<原查询>"` 应能命中。',
    };
  }

  // 情形 B：明确缺某个已知能力（stale / 用户点名）
  const type = missingType && CAP_TYPES.includes(missingType) ? missingType : guessType(missingName || query || '') || 'skill';
  const g = GUIDANCE_BY_TYPE[type] || GUIDANCE_BY_TYPE.skill;
  // v3：硬件/软件是「环境事实」不是「可安装到 DSH 的能力」，缺失口径不同——
  // 硬件缺失给替代方案引导；软件缺失给安装引导。措辞按类型区分（事实归 AI，决策归人）。
  const message =
    type === 'hardware'
      ? `本机缺少该硬件能力：${missingName || query || '（未命名）'}。`
      : type === 'software'
        ? `本机未安装该软件：${missingName || query || '（未命名）'}。`
        : `缺少${type}能力：${missingName || query || '（未命名）'}。`;
  return {
    kind: 'missing',
    missing: { name: missingName, type },
    message,
    actions: [g.hint, g.command ? `补足方式：${g.command}` : null].filter(Boolean),
    verify: '补足后重跑 `node cap.mjs scan`，该能力应出现在清单中（状态 ok）。',
  };
}

/**
 * registry diff 的 removed/stale 列表 → 批量缺失引导（验收标准 2 的主路径）。
 */
export function guideStale(removedEntries) {
  if (!removedEntries || !removedEntries.length) return null;
  return {
    kind: 'stale',
    count: removedEntries.length,
    items: removedEntries.map((e) => ({
      name: e.name,
      type: e.type,
      message: `能力「${e.name}」（${e.type}）已从 DSH 消失（扫描不到），清单中已标记 stale。`,
      actions: guide({ missingName: e.name, missingType: e.type }).actions,
    })),
  };
}
