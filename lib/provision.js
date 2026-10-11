// dsh-efficiency · provision.js（v4.5）
// 自供给（self-provisioning）：让**任何安装者**装完插件后自动获得完整发现能力，
// 不要求用户手工改任何配置文件（可移植性关键）。
//
// ① provisionSkill —— 幂等写入 <dshHome>/skills/efficiency-lookup/SKILL.md（带管理标记），
//    使本技能出现在每次会话的技能目录里 → harness 自然"知道有这个能力"。
// ② AGENTS.md 指针（可选，**默认关闭**）——除非显式开启 provisionAgentsPointer，
//    否则绝不改动用户的规则文件（未经许可改用户文件是底线）。
// 全部幂等：内容一致则不写盘；插件升级时自动刷新（带 version 标记）。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SKILL_NAME = 'efficiency-lookup';
const MARK_BEGIN = '<!-- dsh-efficiency:managed:begin';
const MARK_END = '<!-- dsh-efficiency:managed:end -->';

// ── 旧品牌退役（v0.9.0 改名收尾）─────────────────────────────────────
// 改名后**必须主动清掉旧品牌的产物**，否则它们会以「孤儿」形态留在用户机器上：
//   · AGENTS.md 里的旧管理块：标记名不同 ⇒ 本函数找不到、替换不了 ⇒ 会**再追加**
//     一块新的，旧块原样留着，且里面的路径已失效（指向不存在的目录）。
//   · ~/.dsh/skills/capability-lookup/：技能目录里同时出现新旧两个技能，
//     路由时互相抢命中，且旧的那个指向死路径。
// 两条都只在**确认是自己写的**前提下才动（标记/内容校验），绝不误删别人的东西。
const LEGACY_MARK_PAIRS = [
  { begin: '<!-- dsh-capability-aware:managed:begin', end: '<!-- dsh-capability-aware:managed:end -->' },
];
const LEGACY_SKILLS = [
  { dir: 'capability-lookup', proof: 'dsh-capability-aware' },
];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function dshHome() {
  return process.env.DSH_EFF_DSH_HOME || path.join(os.homedir(), '.dsh');
}

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch { /* 已存在或权限不足 */ }
}

/** 技能正文（管理块；含版本戳以便升级时自动刷新） */
export function skillBody(version, pluginDir) {
  return `---
name: ${SKILL_NAME}
description: 本机能力与环境速查（dsh-efficiency 插件自动供给）。当需要确认「本机有没有某项能力/装没装某个软件/是什么硬件」、或任务开工前要盘点可用工具与技能、或怀疑某个能力已消失时使用。覆盖：技能路由底稿（权威入口仍是 skill-use-router）、插件、MCP 连接器、定时任务、记忆主题文件、本机硬件（CPU/GPU/内存/磁盘）、已安装软件与 dev 工具链版本、通道边界事实。触发词：有没有能力、本机能不能做、装没装、什么显卡、环境速查、能力清单、能力消失、开工前盘点。
---

# ${SKILL_NAME} · 本机能力与环境速查

> 由 \`dsh-efficiency\` 插件**自动供给**（v${version}）——安装插件即获得，无需手工配置。
> **定位**：快速索引底稿 + 兜底；有对应系统的领域，权威归已有系统，本技能不抢它的活。

## 用法

**首选（agent 入口，推荐）**：直接调用 \`efficiency_query\` 工具 —— 不用开终端、不用记路径，与 CLI **同分同源**。

\`\`\`
efficiency_query({ query: "发送文件到微信" })     # → 匹配能力 + 类型 + 调用方式 + 权威归属
\`\`\`

弱命中时工具会自动追加「⚠ 命中质量均偏低 → 补足建议 + 验证命令」；真缺失照它引导，别硬编调用方式。

**同一插件还提供错误账本**（v0.8.0）：\`error_ledger_query\` 工具查「什么坏了 / 缺什么」——
同一报错反复出现、或要决定「先修哪个」时用它（\`view:"repair"\` 取自修复候选，
只含**本机可修**项；供应商限流/配额类不进候选）。

**v0.9.0 新增「效率机」面**（资源监控 + 分级诊断 + 修复提示词）：

- 怀疑**变慢 / 卡顿 / 疑似卡死 / 内存持续增长**，或想知道「谁在烧时间」：
  \`node cap.mjs monitor --live\` 现采全机进程树（不依赖插件进程）；
  \`node cap.mjs monitor stats|procs|sessions|events\` 读心跳落盘的历史采样。
- 要决定**先修哪个**：\`node cap.mjs diagnose\` 按 P0–P3 分档列出反复出现的故障；
  \`node cap.mjs fixprompt\` 生成一段可直接粘贴给新会话的修复提示词（**只生成文本，不自动修**）。
- ⚠ **P3 一律不要动**：P3 = 不是本机该修的（模型供应商限流/配额/断流/网络），
  实测占全部错误的近一半，改本机代码对它们无效。\`diagnose\` 已把它们隔离在 \`notFixable\`。
- 分档看的是**确定性**不是严重程度：P0 宿主自己报的确定失败｜P1 本机可修且证据充分｜
  P2 需推断或影响面小｜P3 非本机问题。

**兜底（终端可用时；完整台账/审计/健康检查）**：

\`\`\`powershell
Set-Location '${pluginDir}'
node cap.mjs brief "<意图>"     # 一眼读：类型 | 做什么 | 怎么调 | 谁主 | 边界
node cap.mjs query "<意图>"     # 匹配能力 + 调用方式 + 权威归属
node cap.mjs list hardware      # 或 list software / skill / mcp / automation …
node cap.mjs doctor             # 各权威域可达性 + 清单健康
node cap.mjs ledger report      # 错误账本概览（recent / facets / repair / search）
node cap.mjs monitor --live     # 现采全机进程树（查卡顿/热点）
node cap.mjs diagnose           # P0–P3 分级诊断
node cap.mjs fixprompt          # 生成修复提示词（只生成，不自动执行）
\`\`\`

## 权威归属（先看这里再动手）

| 你要做的事 | 权威入口（用它） | 本插件角色 |
|---|---|---|
| 该用哪个技能 | \`skill_index.py query "<意图>"\`（skill-use-router） | 索引底稿 |
| 记忆检索 | \`memory_search\`（dsh-mneme） | 只登记 memory/ 主题文件 |
| MCP 状态/工具 | \`mcp_connector_status\` | 连接快照 |
| 定时任务 | \`automation_list\` | 名称/调度底稿 |
| 知识页 | \`hindsight_search_knowledge_pages\` | 仅目录存在性 |
| **本机硬件/软件/环境** | **本插件即权威** | 唯一来源 |

## 兜底

权威系统不可用时用本插件清单应急，结论须标注「来自索引底稿，非实时」。\`node cap.mjs doctor\` 会探测各权威域可达性。
`;
}

/**
 * ③ 退役旧品牌技能目录（改名收尾）。
 *
 * **只在证据充分时删除**：目录里必须有 SKILL.md，且其内容带旧品牌串
 * （`dsh-capability-aware`）——那证明它是本插件旧版本写的。任何不符（无文件、
 * 内容不含旧品牌）都原样保留并返回 `kept-foreign`，绝不误删用户自建技能。
 *
 * @returns {{action:'removed'|'absent'|'kept-foreign', path:string}}
 */
export function retireLegacySkills(opts = {}) {
  const home = opts.dshHome || dshHome();
  const out = [];
  for (const { dir, proof } of LEGACY_SKILLS) {
    const p = path.join(home, 'skills', dir);
    const f = path.join(p, 'SKILL.md');
    let src = null;
    try { src = fs.readFileSync(f, 'utf8'); } catch { src = null; }
    if (src == null) { out.push({ action: 'absent', path: p }); continue; }
    if (!src.includes(proof)) { out.push({ action: 'kept-foreign', path: p }); continue; }
    try {
      fs.rmSync(p, { recursive: true, force: true });
      out.push({ action: 'removed', path: p });
    } catch (e) {
      out.push({ action: 'kept-foreign', path: p, error: String(e?.message ?? e) });
    }
  }
  return out;
}

/**
 * ① 幂等自供给技能入口。
 * @returns {{action:'created'|'updated'|'unchanged'|'skipped', path:string}}
 */
export function provisionSkill(opts = {}) {
  const version = opts.version || '0.0.0';
  const pluginDir = opts.pluginDir || '';
  const home = opts.dshHome || dshHome();
  // 先退役旧品牌技能目录（幂等；默认开启，`retireLegacy:false` 可关）
  if (opts.retireLegacy !== false) {
    try { retireLegacySkills({ dshHome: home }); } catch { /* 退役失败不影响供给 */ }
  }
  const dir = path.join(home, 'skills', SKILL_NAME);
  const file = path.join(dir, 'SKILL.md');
  const body = skillBody(version, pluginDir);
  let cur = null;
  try { cur = fs.readFileSync(file, 'utf8'); } catch { cur = null; }
  if (cur === body) return { action: 'unchanged', path: file };
  ensureDir(dir);
  try {
    fs.writeFileSync(file, body, 'utf8');
    return { action: cur == null ? 'created' : 'updated', path: file };
  } catch {
    return { action: 'skipped', path: file };
  }
}

/**
 * ② 可选：向 ~/.dsh/AGENTS.md 注入**带标记的管理块**（默认关闭；仅在显式开启时调用）。
 * 幂等（标记内整体替换）；不触碰标记外的任何内容。
 * @returns {{action:'created'|'updated'|'unchanged'|'skipped', path:string}}
 */
export function provisionAgentsPointer(opts = {}) {
  const home = opts.dshHome || dshHome();
  const pluginDir = opts.pluginDir || '';
  const version = opts.version || '0.0.0';
  const file = path.join(home, 'AGENTS.md');
  const block = `${MARK_BEGIN} v${version} — 由 dsh-efficiency 插件维护，删除本块即停用） -->
## 能力与环境速查（自动注入）

**首选：直接调 \`efficiency_query\` 工具**（无需开终端、无需记路径；agent 入口，与 CLI 同分同源）：

- 任务依赖**本机环境**（硬件/软件/工具链），或**不确定本机是否具备某项能力**，或**怀疑某能力已消失**时，
  起手先调一次 \`efficiency_query({ query: "<任务意图>" })\`；返回里带类型、能做什么、怎么调用、权威归属。
- 弱命中时工具会追加「命中质量均偏低 → 补足建议 + 验证命令」；真缺失按该提示引导，不要硬编造调用方式。
- **错误账本**（同一插件，v0.8.0）：同一报错反复出现、或要决定「先修哪个」时调
  \`error_ledger_query({ view: "repair" })\` —— 只给**本机可修**候选与证据（供应商限流/配额类不列），
  按「次数×影响会话数」排序。只读、不自动改动。
- **效率机面**（v0.9.0）：**变慢 / 卡顿 / 疑似卡死 / 内存持续增长**时，先跑
  \`node cap.mjs monitor --live\` 看谁在烧时间；要修复方案跑 \`node cap.mjs diagnose\`（P0–P3 分档）
  与 \`node cap.mjs fixprompt\`（生成可粘贴的修复提示词；只生成文本，不自动执行）。
  ⚠ **P3 一律不要动**——那是模型供应商限流/配额/断流，实测占全部错误近一半，改本机代码无效。

**兜底 / 想看完整台账或做审计**（终端可用时）：

\`\`\`powershell
Set-Location "${pluginDir}"
node cap.mjs brief "<任务意图>"   # 一眼读：类型 | 做什么 | 怎么调 | 谁主 | 边界
node cap.mjs query "<意图>"       # 完整候选台账
node cap.mjs doctor               # 各权威域可达性 + 清单健康
node cap.mjs ledger report        # 错误账本概览（recent / facets / repair / search）
node cap.mjs monitor --live       # 现采全机进程树（查卡顿/热点）
node cap.mjs diagnose             # P0–P3 分级诊断
node cap.mjs fixprompt            # 生成修复提示词（只生成，不自动执行）
\`\`\`

- 权威归属：技能路由→skill-use-router、记忆→memory_search、MCP/定时→宿主；**本机硬件/软件/环境事实→本插件**。
${MARK_END}\n`;
  let cur = '';
  try { cur = fs.readFileSync(file, 'utf8'); } catch { cur = ''; }
  // 先退役旧品牌块（幂等：没有则不动）。**必须在计算新块正则之前做**——
  // 否则旧块既不被替换也不被删除，只会在文件里越堆越多。
  for (const m of LEGACY_MARK_PAIRS) {
    const lre = new RegExp(`${esc(m.begin)}[\\s\\S]*?${esc(m.end)}\\n?`, 'g');
    cur = cur.replace(lre, '');
  }
  cur = cur.replace(/\n{3,}/g, '\n\n');   // 清掉退役后留下的连续空行
  const re = new RegExp(`${esc(MARK_BEGIN)}[\\s\\S]*?${esc(MARK_END)}\\n?`);
  const next = re.test(cur)
    ? cur.replace(re, block)
    : (cur ? cur.replace(/\s*$/, '\n\n') + block : block);
  if (next === cur) return { action: 'unchanged', path: file };
  try {
    ensureDir(home);
    fs.writeFileSync(file, next, 'utf8');
    return { action: cur ? 'updated' : 'created', path: file };
  } catch {
    return { action: 'skipped', path: file };
  }
}
