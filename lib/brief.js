// dsh-capability-aware · brief.js（v4.4）
// 「一眼读」一行式格式化器 —— **单一事实源**：CLI `cap.mjs brief` 与 agent 工具 `capability_query` 共用，
// 保证 harness 在两条入口看到同一套「什么能做什么 / 怎么调 / 谁主 / 边界」口径。
// 设计依据（用户四条定位原则）：① 一看就知道 ② 友好协作 ③ 我强我上/让位/辅助 ④ 它挂了我兜底。

export const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

/** 谁主导：primary=我主上；assist=它主上我辅助；无 authority=未分级 */
export function roleOf(a) {
  if (!a) return '—';
  if (a.strength === 'primary') return `我主上（${a.system}）`;
  if (a.strength === 'assist') return `它主上·我辅助（${a.system}）`;
  return a.system || '—';
}

/** 单条能力 → 一行式 */
export function briefLine(e, i) {
  const a = e.authority || {};
  const b = e.bounds || {};
  const idx = Number.isFinite(i) ? `${i + 1}. ` : '';
  return `${idx}[${e.type}] ${e.name} — ${clip(e.description, 60)} ｜ 调: ${clip(e.invoke?.how, 60)} ｜ 主: ${roleOf(a)} ｜ 边界: ${clip(b.limits, 70)}`;
}

/** 多条能力 → 行数组（可选前置说明行，如"匹配到："/"命中 N 个接近候选"） */
export function briefLines(entries, head) {
  const body = (entries || []).map((e, i) => briefLine(e, i));
  return head ? [head, ...body] : body;
}

/** 兜底提示：某域权威不可达时统一口径（原则④） */
export function fallbackNote(authorityHealth) {
  if (!authorityHealth) return '';
  return authorityHealth.degraded?.length
    ? `⚠ 兜底提示：${authorityHealth.degraded.join(', ')} 域权威系统不可达，这些域的结论来自本插件索引底稿（非实时）。`
    : '';
}
