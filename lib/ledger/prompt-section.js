// dsh-capability-aware · lib/ledger/prompt-section.js
//
// 常驻指令面（账本那一段）：把「本机有一份错误账本、排查反复报错时该查它」写进系统提示词。
//
// 为什么需要（与 capability-aware 主段 v0.7.0 同源的经验）：
//   只注册工具是不够的 —— 实测 capability-aware 上线一天 harness 0 次主动调用，
//   因为没有任何**必经触发点**。工具在清单里躺着，agent 不会想到去用它。
//   这里的触发点更明确：「同一报错反复出现」是 agent 自己就能识别的信号。
//
// 取证链（全部实读源码，路径见 README「宿主契约」）：
//   · 注入点：`ctx.systemPrompt.section({name, order, interpolate, text})`
//     —— `@deepseek-ai/dsh-system-prompt/lib/index.js:240-243`，
//        `order` 必须有限数否则抛 TypeError；同层重名会抛（可见不静默）。
//   · 权威用法对照：`@deepseek-ai/dsh-mcp-resources/lib/index.js:108-131`
//     —— `ctx.inject(['systemPrompt'], inner => inner.systemPrompt.section({...}))`，
//        `text` 支持函数形态（随 scope 动态求值）。
//   · 位次：本段取 **2951**，紧邻能力清单段（2950），落在宿主
//     `SECTION_ORDERS` 的 TOOL_REPORT:2900 与 TOOL_COMPUTER_USE:3000 空档内。
//     同属 capability-aware 命名空间，两段相邻、语义互补（有什么能力 / 什么坏了）。
//
// ⚠ 绝不写 `export const inject = ['systemPrompt']` 硬声明 —— 无该服务的 profile
//   里 apply() 会整体 pending，连核心捕获/回填都不跑。指令面是加分面。

/** 段名（同层唯一；与能力清单段 `capability-aware:capability-index` 不冲突）。 */
export const SECTION_NAME = 'capability-aware:error-index';

/** 注入位次：2900 < 2951 < 3000，见文件头说明。 */
export const SECTION_ORDER = 2951;

/**
 * 段正文（纯净函数，便于单测）。
 * @param {string} version 插件版本，用于让「重启后是否换过代码」一眼可见
 */
export function promptSectionText(version = '?') {
  return [
    `## 本机错误账本（dsh-capability-aware v${version} 自动记录）`,
    '',
    '本机所有 DSH 会话的报错都被自动记入账本，按**插件／技能／对象／错误码／责任方**切面聚合。',
    '**当同一报错反复出现、怀疑某个插件或技能有系统性问题、或要决定「先修哪个」时**，',
    '用 `error_ledger_query({ view: "repair" })` 取自修复候选（只含本机可修项，按「次数×影响会话数」排序），',
    '`view: "facets", key: "<切面>"` 下钻某个切面，`view: "search", key: "<词>"` 检索原文。',
    '',
    '判读要点：账本给每条错误标了**责任方**——`local` 才是本机该修的；`provider`（模型限流/配额/超时）',
    '和 `external`（网络）不该去「修」，应换路由或退避。别把供应商抖动当成自己的缺陷。',
    '账本**只读**：它不改任何文件、不自动修任何东西，只给候选与证据。',
  ].join('\n');
}

/**
 * 挂载常驻指令面。
 *
 * ⚠ **返回值是异步填充的**（实证坑，v0.2.1 修）：
 *   `ctx.inject(['systemPrompt'], cb)` 的回调**不是同步触发**的（实测 `syncFired === false`），
 *   而本函数是同步返回。所以必须**原地改属性**、绝不能 `result = {...}` 重新赋值 ——
 *   重新赋值只会换掉局部变量指向的对象，调用方手里的引用永远停在 `{mounted:false, reason:'pending'}`。
 *   v0.2.0 就踩了这个：段其实**挂成功了**（再注册同名段会抛
 *   `prompt section "capability-aware:error-index" is already registered`），
 *   但 health() 一直报 `NO_PROMPT_SECTION: pending`，把「已生效」误报成「没生效」。
 *   调用方若要即时确认，读 `mounted` 前先 `await Promise.resolve()` 让 microtask 跑完。
 *
 * @param {any} ctx 宿主 Context
 * @param {{version?:string, enabled?:boolean, log?:(m:string)=>void, warn?:(m:string)=>void}} [opts]
 * @returns {{mounted:boolean, reason?:string, order?:number}} 同一对象引用，稍后被异步填充
 */
export function mountPromptSection(ctx, opts = {}) {
  const { version = '?', log, warn } = opts;
  if (opts.enabled === false) return { mounted: false, reason: 'disabled' };
  if (!ctx || typeof ctx.inject !== 'function') return { mounted: false, reason: 'no-ctx' };

  const result = { mounted: false, reason: 'pending' };
  // 诊断字段：区分「inject 回调从未触发」与「触发了但挂载失败」——线上排障靠它。
  result.diag = { injectCalled: 0, sawService: false, nowHas: false };
  try {
    result.diag.nowHas = typeof ctx.get?.('systemPrompt') === 'object' && ctx.get('systemPrompt') !== null;
  } catch { /* ctx.get 不可用时忽略 */ }
  try {
    ctx.inject(['systemPrompt'], (scoped) => {
      result.diag.injectCalled++;
      const sp = scoped?.systemPrompt;
      result.diag.sawService = typeof sp?.section === 'function';
      if (!sp || typeof sp.section !== 'function') {
        result.reason = 'no-systemPrompt';
        return;
      }
      // 位次优先从宿主集中登记的常量推导，拿不到再退回本地常量
      // （宿主调整 TOOL_COMPUTER_USE 位次时自动跟随，不会撞车）。
      let order = SECTION_ORDER;
      try {
        const base = sp.getSectionOrder?.('TOOL_COMPUTER_USE');
        if (Number.isFinite(base)) order = base - 49;
      } catch { /* 宿主无 getSectionOrder，用本地常量 */ }

      const spec = {
        name: SECTION_NAME,
        order,
        interpolate: false,
        text: () => promptSectionText(version),
      };
      // ⚠ 必须挂 effect：热重载时不挂会 duplicate section → 同层重名抛错，
      //   打掉整棵插件树（同 capability-aware 的 register 坑）。
      scoped.effect(() => sp.section(spec), 'capability-aware: ledger prompt section');
      // ⚠ 原地改属性（见上方返回值说明）
      result.mounted = true;
      result.order = order;
      delete result.reason;
      try { log?.(`常驻指令面已挂载（order=${order}）`); } catch {}
    });
  } catch (e) {
    result.reason = String(e?.message ?? e);
    try { warn?.(`常驻指令面挂载失败：${result.reason}`); } catch {}
  }
  return result;
}
