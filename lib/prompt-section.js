// dsh-capability-aware · prompt-section.js（v0.7.0）
//
// 目标（用户 m03764）：**安装插件即达到应有水平**，不要求安装者改任何文件。
//
// 背景取证：
//   · v0.6.1 的自供给只做两件事——写 <dshHome>/skills/capability-lookup/SKILL.md
//     （技能入口，安装即有）与可选的 ~/.dsh/AGENTS.md 指针块（公共默认 **false**）。
//   · 因此全新安装的机器上，agent 的**常驻指令面**里没有本插件的任何痕迹：
//     技能要被"发现"得先被列出/被 router 命中，而「任务依赖本机环境时起手先查能力」
//     这条**行为规约**根本没进上下文。→ 装了等于没装到位。
//   · 而 AGENTS.md 路线违反公共仓库底线（不得替安装者默认改用户文件），
//     只能靠本机 profile 覆盖开启，不可移植。
//
// 解法：改用宿主**官方公开**的提示词注入点——`ctx.systemPrompt.section({name, order, text})`。
//   · 权威写法对照（本机在跑的真实插件）：
//       - `@deepseek-ai/dsh-mcp-resources/lib/index.js:118-130`：
//           ctx.inject(["systemPrompt"], (inner) => {
//             inner.systemPrompt.section({
//               name: "mcp-resource-servers",
//               order: inner.systemPrompt.getSectionOrder("MCP_SERVERS"),
//               interpolate: false,
//               text: ({ scope }) => ... ,   // 支持函数形态（随 scope 动态求值）
//             })
//           })
//       - `@deepseek-ai/dsh-system-prompt/lib/index.js:240-243` 的 `section()`：
//           必须有有限 order，否则抛 TypeError；返回 Cordis effect disposer。
//       - `SECTION_ORDERS`（同文件 :10-43）是集中登记的位次常量，含
//         TOOL_BASH:1000 / TOOL_READ:1100 / MCP_SERVERS:3100 / TOOLS_SDK:5000 等。
//   · 这是**不改用户任何文件**的注入：纯运行时贡献，卸载插件即消失，
//     不写 AGENTS.md、不写用户技能目录以外的地方。
//
// ⚠ 两个实测坑：
//   1) 必须 `ctx.inject(['systemPrompt'], ...)` **软注入**，不得用
//      `export const inject = ['systemPrompt']` 硬声明——硬声明会让没有该 service 的
//      极简 profile 里 apply() 整体 pending（对照本插件 index.js 头部注释记录的
//      webServer 同款事故：`pending (waiting for service: webServer)`）。
//   2) `section()` 不带 `ctx.effect` 包裹的话，热重载会导致同层重复注册：
//      `@deepseek-ai/dsh-system-prompt/lib/index.js:242` 明确记载
//      「duplicates within one layer … throw」。故用 scoped.effect(...) 包住。
//
// 位次选择：order 必须避开所有既有槽位（见 SECTION_ORDERS）以免抢位。
//   取 2950 —— 在 TOOL_REPORT:2900 与 TOOL_COMPUTER_USE:3000 之间的空档，
//   属于"工具面之后、MCP_SERVERS:3100 之前"，语义上正好是「本机能力盘点」的位置。

const SECTION_NAME = 'capability-aware:capability-index';
const SECTION_ORDER = 2950;

/** 注入正文（纯净函数，便于单测与外部审查） */
export function promptSectionText(version) {
  return `## 本机能力与环境速查（dsh-capability-aware v${version} 自动注入）

**任务依赖本机环境（硬件 / 软件 / 工具链），或不确定本机是否具备某项能力，或怀疑某能力已消失时，起手先调一次
\`capability_query({ query: "<任务意图>" })\`** —— 返回类型、能做什么、怎么调用、以及该问哪个权威系统。
弱命中会自动附加「命中质量均偏低 → 补足建议 + 验证命令」；确认本机缺失时按该引导补足，不要硬编调用方式。

权威归属（先看这里再动手）：技能路由 → \`skill_index.py\`（skill-use-router）；记忆 → \`memory_search\`；
MCP / 定时任务 → 宿主工具；**本机硬件 / 软件 / 环境事实 → 本插件即权威**。

兜底（终端可用时；完整台账与健康检查）：
\`node cap.mjs brief "<意图>"\`｜\`node cap.mjs query "<意图>"\`｜\`node cap.mjs doctor\``;
}

/**
 * 挂载系统提示词段（软注入 + effect 包裹，幂等、可撤销）。
 * @param {object} ctx 宿主插件上下文
 * @param {{version?:string, enabled?:boolean, log?:(m:string)=>void, warn?:(m:string)=>void}} opts
 * @returns {{mounted:boolean, reason?:string}}
 */
export function mountPromptSection(ctx, opts = {}) {
  const enabled = opts.enabled !== false;
  const log = opts.log || (() => {});
  const warn = opts.warn || (() => {});
  if (!enabled) return { mounted: false, reason: 'disabled' };
  try {
    ctx.inject(['systemPrompt'], (scoped) => {
      const sp = scoped.systemPrompt;
      if (!sp || typeof sp.section !== 'function') {
        warn('systemPrompt 服务无 section()，跳过注入（其余功能不受影响）');
        return;
      }
      // order 取值优先走宿主集中登记表；无该常量时退回本模块自选的空档位次。
      let order = SECTION_ORDER;
      try {
        const central = sp.getSectionOrder?.('TOOL_COMPUTER_USE');
        if (Number.isFinite(central)) order = central - 50; // 3000 - 50 = 2950
      } catch { /* 保留本地常量 */ }
      scoped.effect(
        () => sp.section({
          name: SECTION_NAME,
          order,
          interpolate: false,
          text: () => promptSectionText(opts.version || '0.0.0'),
        }),
        'capability-aware: system prompt section',
      );
      log(`系统提示词段已注入（order=${order}）—— 免改任何用户文件`);
    });
  } catch (e) {
    warn(`系统提示词注入失败（不影响扫描/检索/CLI）：${e?.message}`);
    return { mounted: false, reason: String(e?.message || e) };
  }
  return { mounted: true };
}

export { SECTION_NAME, SECTION_ORDER };
