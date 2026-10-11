// dsh-efficiency · lib/efficiency-section.js（v0.9.0）
//
// 第三段常驻指令面 —— 「效率机」面：资源监控 + 分级诊断 + 修复提示词。
//
// ## 为什么要有第三段（而不是把内容塞进前两段）
//
// 三段各自回答一个**不同时机**的问题，混在一起会让 agent 在不需要时被无关信息
// 占用注意力，而需要时又找不到：
//
//   efficiency:capability-index  order 2950  「**有什么能力**」——动手前
//   efficiency:error-index       order 2951  「**什么坏了**」——出错后查史
//   efficiency:resource-index    order 2952  「**现在跑得怎么样 / 卡不卡**」——怀疑变慢时
//
// 三段同命名空间（`efficiency:*`），位次连续 2950/2951/2952，落在
// `TOOL_REPORT:2900` 与 `TOOL_COMPUTER_USE:3000` 之间的空档里，不抢任何既有槽位。
//
// ## 本段最需要防的一件事：别让 agent 去"修"不该修的东西
//
// 实测全量回填 13303 条记录里，provider（模型供应商）类占 45.6%
// （RATE_LIMIT 2794 + SERVER 1115 + TIMEOUT 402 + TRANSPORT 283 …）。
// 如果本段只说「有错误就去修」，agent 会一头扎进供应商限流里改本机代码——
// 纯浪费，且会掩盖真问题。故正文里**显式写了"不要修 provider 类"**，
// 并且诊断工具本身就把它们隔离在 `notFixable` 里。
//
// ## 实测坑（与 prompt-section.js 同款，勿改）
//
// 1. 必须 `ctx.inject(['systemPrompt'], ...)` 软注入，不得硬声明 `inject`。
// 2. `section()` 必须用 `scoped.effect(...)` 包住，否则热重载同层重复注册会抛。
// 3. `ctx.inject` 回调**不是同步触发**的 → 返回值必须先建对象、回调内原地改属性，
//    不能同步 `return {mounted:true}`（那是乐观谎报）。

const SECTION_NAME = 'efficiency:resource-index';
const SECTION_ORDER = 2952;

/** 注入正文（纯净函数，便于单测与外部审查）。 */
export function efficiencySectionText(version) {
  return `## 本机效率与资源健康（dsh-efficiency v${version} 自动注入）

**怀疑变慢、卡顿、疑似卡死、内存持续增长，或想知道"谁在烧时间"时，起手查这里** ——
本插件在宿主内以 3 秒心跳采样进程/会话/插件三层，并把异常按确定性分档记进监控事件。

查当前现场（终端）：
\`node cap.mjs monitor --live\`（不依赖插件，直接现采全机进程树）
\`node cap.mjs monitor stats|procs|sessions|events\`（读心跳落盘的历史采样）

查历史故障并拿修复方案：
\`node cap.mjs diagnose\`（按 P0–P3 分档列出所有反复出现的问题）
\`node cap.mjs fixprompt\`（生成一段可直接粘贴给新会话的修复提示词）

**分档看的是"确定性"，不是"严重程度"**：
P0 = 宿主自己报的确定失败｜P1 = 本机可修且证据充分｜P2 = 需推断/低影响｜
P3 = **不是本机该修的**（模型供应商限流/配额/断流/网络）。

⚠ **P3 一律不要动**：实测这类占全部错误的近一半，改本机代码对它们无效，
只会引入新 bug。真要缓解应调模型路由或配额策略，并把结论告诉用户。
\`diagnose\` 已把 P3 隔离在 \`notFixable\` 字段，\`fixprompt\` 也只在正文里把它们标为"不要修"。

**监控数据的诚实边界**（不要把推断当事实）：
· 进程层是 koffi 直读 Win32 的**测量值**；但一个进程内跑多个插件，**无法据此归因到单个插件**。
· 插件层是**相关性排序，不是 CPU 归因** —— DSH 不提供插件级资源计量 API。
· 会话层增量是"本插件上次读取至今"的差值，**非宿主官方计费口径**。
· 错误与资源事件的关联是**相关性，不是因果**（字段名就叫 \`correlatedWith\`）。`;
}

/**
 * 挂载第三段（软注入 + effect 包裹，幂等、可撤销）。
 * @param {object} ctx 宿主插件上下文
 * @param {{version?:string, enabled?:boolean, log?:(m:string)=>void, warn?:(m:string)=>void}} opts
 * @returns {{mounted:boolean, reason?:string, diag?:object}}
 */
export function mountEfficiencySection(ctx, opts = {}) {
  const enabled = opts.enabled !== false;
  const log = opts.log || (() => {});
  const warn = opts.warn || (() => {});
  if (!enabled) return { mounted: false, reason: 'disabled' };
  if (!ctx || typeof ctx.inject !== 'function') return { mounted: false, reason: 'no-ctx' };

  const result = { mounted: false, reason: 'pending' };
  result.diag = { injectCalled: 0, sawService: false, nowHas: false };
  try {
    result.diag.nowHas = typeof ctx.get?.('systemPrompt') === 'object' && ctx.get('systemPrompt') !== null;
  } catch { /* ctx.get 不可用时忽略 */ }

  try {
    ctx.inject(['systemPrompt'], (scoped) => {
      result.diag.injectCalled++;
      const sp = scoped.systemPrompt;
      result.diag.sawService = typeof sp?.section === 'function';
      if (!sp || typeof sp.section !== 'function') {
        result.reason = 'no-systemPrompt';
        warn('systemPrompt 服务无 section()，跳过效率段注入（其余功能不受影响）');
        return;
      }
      let order = SECTION_ORDER;
      try {
        const central = sp.getSectionOrder?.('TOOL_COMPUTER_USE');
        if (Number.isFinite(central)) order = central - 48; // 3000 - 48 = 2952
      } catch { /* 保留本地常量 */ }
      try {
        scoped.effect(
          () => sp.section({
            name: SECTION_NAME,
            order,
            interpolate: false,
            text: () => efficiencySectionText(opts.version || '0.0.0'),
          }),
          'efficiency: efficiency prompt section',
        );
      } catch (e) {
        result.reason = String(e?.message || e);
        warn(`效率段注册失败（不影响监控/诊断/CLI）：${result.reason}`);
        return;
      }
      result.mounted = true;
      result.order = order;
      delete result.reason;
      log(`效率段已注入（order=${order}）—— 与能力段/错误段同命名空间`);
    });
  } catch (e) {
    warn(`效率段注入失败（不影响监控/诊断/CLI）：${e?.message}`);
    result.reason = String(e?.message || e);
    return result;
  }
  return result;
}

export { SECTION_NAME, SECTION_ORDER };
