// dsh-efficiency · lib/fixprompt.js
//
// 修复提示词生成 —— 把诊断信封组装成一段**可直接粘贴给新会话 Agent** 的文本。
//
// ## 形态来源
//
// 照抄插件市场「高级 → 诊断」的 AI-fix 流程（`dshmarket/client/client.js`）：
//
//   aiFixHint:   "将诊断问题交由新对话中的 Agent 修复（内容已复制到剪贴板，由你决定是否发送）"
//   aiFixIntro:  "请帮我修复 DeepSeek Harness 的插件问题（profile：{0}）。诊断发现如下："
//   aiFixDetect: "【第一步·先判断身份】开始前先判断：当前 Agent 所运行的进程，是否就是
//                 这个 profile 对应的 DeepSeek Harness 本机进程…若无法确定，一律按
//                 【是你】处理（更安全）。"
//
// 三条被继承的关键设计：
//
//   1. **「先判断身份」前置**：提示词可能被粘到**另一个** DSH 实例的会话里。若 Agent
//      在不属于该 profile 的进程里照着修，会改错机器。故第一步是自证身份。
//   2. **由用户决定是否发送**：本插件只**生成文本**，不自动投递、不自动修。
//      这是「只读」承诺的延伸——生成提示词是只读操作，执行它才是写操作。
//   3. **不碰不该碰的**：市场版只报 manifest 声明问题；本版必须显式排除
//      `owner=provider` 的项（实测占全量错误 40.6%），否则 Agent 会去「修」供应商限流。
//
// ## 与市场的分工
//
//   市场提示词：修**插件依赖声明**（静态，装之前）。
//   本提示词：修**运行期真实故障**（动态，跑起来之后）。

import { SEVERITIES } from './diagnose.js';

/** 提示词版本——消费方（人或 Agent）可据此判断格式。 */
export const FIXPROMPT_VERSION = 1;

/**
 * 组装修复提示词。
 *
 * @param {object} diagnostics  `diagnose()` 的返回体
 * @param {object} opts
 * @param {string} opts.profile   profile 名（默认 `desktop`）
 * @param {string} opts.home      DSH home 绝对路径（用于让 Agent 自证身份）
 * @param {string} opts.ledgerDir 账本数据目录（Agent 复现时要用）
 * @param {string} opts.monitorDir 监控数据目录
 * @param {string} opts.repoDir   本插件源码目录（若 Agent 要改插件本身）
 * @param {number} opts.maxItems  每档最多列几条（默认 8）
 * @param {boolean} opts.includeP3 是否附上 P3（默认 true，但标为「不要修」）
 * @param {string} opts.extra     追加的自定义说明
 */
export function buildFixPrompt(diagnostics, opts = {}) {
  const profile = opts.profile ?? 'desktop';
  const home = opts.home ?? '~/.dsh';
  const maxItems = Number.isFinite(opts.maxItems) ? opts.maxItems : 8;
  const includeP3 = opts.includeP3 !== false;
  const t = (x) => (x ? new Date(x).toISOString().replace('T', ' ').slice(0, 19) : '-');

  const L = [];
  L.push(`请帮我修复 DSH（DeepSeek Harness）运行期反复出现的故障（profile：${profile}）。`);
  L.push('');

  // ── 第一步：身份判定（照抄市场版的安全前置） ──────────────────
  L.push('【第一步·先判断身份】');
  L.push('开始前先判断：当前 Agent 所运行的进程，是否就是这个 profile 对应的 DSH 本机进程。');
  L.push('判断方法（任一即可）：');
  L.push(`  · 本机 DSH home 是否为 \`${home}\`（可用 \`echo $env:USERPROFILE\` 或读环境变量确认）；`);
  L.push(`  · 是否能读到账本数据目录 \`${opts.ledgerDir ?? `${home}/data/efficiency/ledger`}\`；`);
  L.push(`  · 运行 \`node cap.mjs ledger stats\` 能否成功返回数据。`);
  L.push('**若无法确定，一律按【是你】处理（更安全）**，但在动手前先向用户复述你要改什么。');
  L.push('若确认【不是你】，请停下来告诉用户：这段提示词应发给另一个 DSH 实例。');
  L.push('');

  // ── 第二步：复现与取证 ────────────────────────────────────────
  L.push('【第二步·先复现，再动手】');
  L.push('不要凭本文档的描述直接改代码。先取证：');
  L.push('  · `node cap.mjs ledger recent 30` —— 看最近 30 条原始记录（含完整报错正文）；');
  L.push('  · `node cap.mjs ledger search "<关键词>"` —— 按错误码/工具/对象检索历史；');
  L.push(`  · 账本原始数据：\`${opts.ledgerDir ?? `${home}/data/efficiency/ledger`}/events.v1.jsonl\`（JSONL，可直接 grep）；`);
  L.push(`  · 监控采样：\`${opts.monitorDir ?? `${home}/data/efficiency/monitor`}/monitor.v1.jsonl\`；`);
  L.push('  · `node cap.mjs monitor procs` / `monitor sessions` / `monitor events` —— 看当前资源现场。');
  L.push('若某一项在当前环境**无法复现**，请如实说明并跳过，不要「推测着修」。');
  L.push('');

  // ── 第三步：诊断清单 ──────────────────────────────────────────
  L.push(`【第三步·诊断清单】（schema：${diagnostics.schema}，生成于 ${t(diagnostics.generatedAt)}，`);
  L.push(`窗口起点 ${t(diagnostics.since)}，最少出现 ${diagnostics.minCount} 次）`);
  L.push('');

  const fixable = (diagnostics.fixable ?? []).slice(0, maxItems);
  if (fixable.length) {
    L.push('■ 本机该修的（按确定性优先级排序）：');
    for (const f of fixable) {
      L.push(...renderFinding(f, t));
    }
    L.push('');
  } else {
    L.push('■ 本机该修的：**无**（当前窗口内没有达到阈值的本机故障）。');
    L.push('');
  }

  const notFixable = (diagnostics.notFixable ?? []).slice(0, maxItems);
  if (includeP3 && notFixable.length) {
    L.push('■ 【不要修】以下项不是本机该修的（供应商/外部服务，或已确认为非缺陷）：');
    L.push('  列在这里只是让你知道「时间花在哪」，**改本机代码对它们无效**。');
    for (const f of notFixable) {
      // 档位理由必须跟着条目走：P3 里既有「供应商限流」，也有「历史误报」，
      // 不给理由读者无法分辨（前者该换路由，后者什么都不该做）。
      const why = f.evidence?.severityNote ? `　${f.evidence.severityNote}` : '';
      L.push(`  · ${f.code}　${f.count} 次 / ${f.sessionCount} 会话${why}　${String(f.message ?? '').slice(0, 100)}`);
    }
    L.push('');
  }

  // ── 第四步：改动纪律 ──────────────────────────────────────────
  L.push('【第四步·改动纪律】');
  L.push('1. **一次只改一项**，改完立即验证该项是否消失（重跑 `node cap.mjs ledger recent 20` 对照）。');
  L.push('2. **改前先备份**被改文件；改后必须跑测试：');
  L.push(`   \`cd ${opts.repoDir ?? '<插件源码目录>'} ; npm test\`（本插件 95+ 项测试）。`);
  L.push('3. **不要为了让诊断数字变好看而删除账本记录**——那是在销毁证据。');
  L.push('4. **不要修改 `owner=provider` 的项**：那些是模型供应商的限流/配额/断流，');
  L.push('   本机无法修，改代码只会引入新 bug。若确实需要缓解，应调整模型路由或配额策略，');
  L.push('   并把结论告诉用户由他决定。');
  L.push('5. 若发现某项的 `evidence.basis` 不足以支撑结论，**先补取证再改**，不要猜。');
  L.push('6. 修完后向用户报告：改了哪个文件、依据哪条 finding、验证方式、以及是否仍有残留。');
  L.push('');

  if (opts.extra) {
    L.push('【补充说明】');
    L.push(String(opts.extra));
    L.push('');
  }

  L.push('---');
  L.push(`（本提示词由 dsh-efficiency 自动生成，版本 ${FIXPROMPT_VERSION}；`);
  L.push('  插件只生成文本、不自动执行修复。是否发送、是否采纳由你决定。）');

  return L.join('\n');
}

function renderFinding(f, t) {
  const out = [];
  const meta = SEVERITIES[f.severity] ?? {};
  out.push('');
  out.push(`▸ [${f.severity} ${meta.label ?? ''}] ${f.code}　${f.count} 次 / ${f.sessionCount} 会话`);
  out.push(`  主体：${f.subject.kind}:${f.subject.name}`);
  if (f.firstTime || f.lastTime) out.push(`  时间：${t(f.firstTime)} → ${t(f.lastTime)}`);
  if (f.textSignature) out.push(`  文本签名：${String(f.textSignature).slice(0, 160)}`);
  if (f.message) out.push(`  最近报错：${String(f.message).slice(0, 240)}`);
  if (f.fixHint) out.push(`  已知修法：${f.fixHint}`);
  if (f.evidence?.severityNote) out.push(`  分档依据：${f.evidence.severityNote}`);
  const samples = f.evidence?.samples ?? [];
  if (samples.length) out.push(`  涉及对象：${samples.slice(0, 3).join(' | ')}`);
  if (f.evidence?.correlatedWith?.length) {
    out.push(`  ⚠ 时间相关（非因果）：${f.evidence.correlatedWith.map((c) => `${c.code}(${c.deltaMs > 0 ? '+' : ''}${Math.round(c.deltaMs / 1000)}s)`).join(' ')}`);
  }
  if (f.evidence?.hostCpuHot) out.push('  ⚠ 同期 Host 进程处于 CPU 热点（≥80%）');
  return out;
}

/**
 * 轻量版提示词 —— 只给单条 finding，用于「用户点某一条 → 立刻要一段话」的场景。
 */
export function buildSingleFixPrompt(finding, opts = {}) {
  const d = {
    schema: 'dsh-efficiency/diagnostics/v1',
    generatedAt: Date.now(),
    minCount: 1,
    fixable: [finding],
    notFixable: [],
  };
  return buildFixPrompt(d, { ...opts, includeP3: false, maxItems: 1 });
}
