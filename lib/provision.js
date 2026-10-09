// dsh-capability-aware · provision.js（v4.5）
// 自供给（self-provisioning）：让**任何安装者**装完插件后自动获得完整发现能力，
// 不要求用户手工改任何配置文件（可移植性关键）。
//
// ① provisionSkill —— 幂等写入 <dshHome>/skills/capability-lookup/SKILL.md（带管理标记），
//    使本技能出现在每次会话的技能目录里 → harness 自然"知道有这个能力"。
// ② AGENTS.md 指针（可选，**默认关闭**）——除非显式开启 provisionAgentsPointer，
//    否则绝不改动用户的规则文件（未经许可改用户文件是底线）。
// 全部幂等：内容一致则不写盘；插件升级时自动刷新（带 version 标记）。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SKILL_NAME = 'capability-lookup';
const MARK_BEGIN = '<!-- dsh-capability-aware:managed:begin';
const MARK_END = '<!-- dsh-capability-aware:managed:end -->';

export function dshHome() {
  return process.env.DSH_CAP_DSH_HOME || path.join(os.homedir(), '.dsh');
}

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch { /* 已存在或权限不足 */ }
}

/** 技能正文（管理块；含版本戳以便升级时自动刷新） */
export function skillBody(version, pluginDir) {
  return `---
name: ${SKILL_NAME}
description: 本机能力与环境速查（dsh-capability-aware 插件自动供给）。当需要确认「本机有没有某项能力/装没装某个软件/是什么硬件」、或任务开工前要盘点可用工具与技能、或怀疑某个能力已消失时使用。覆盖：技能路由底稿（权威入口仍是 skill-use-router）、插件、MCP 连接器、定时任务、记忆主题文件、本机硬件（CPU/GPU/内存/磁盘）、已安装软件与 dev 工具链版本、通道边界事实。触发词：有没有能力、本机能不能做、装没装、什么显卡、环境速查、能力清单、能力消失、开工前盘点。
---

# ${SKILL_NAME} · 本机能力与环境速查

> 由 \`dsh-capability-aware\` 插件**自动供给**（v${version}）——安装插件即获得，无需手工配置。
> **定位**：快速索引底稿 + 兜底；有对应系统的领域，权威归已有系统，本技能不抢它的活。

## 用法

**首选（agent 入口，推荐）**：直接调用 \`capability_query\` 工具 —— 不用开终端、不用记路径，与 CLI **同分同源**。

\`\`\`
capability_query({ query: "发送文件到微信" })     # → 匹配能力 + 类型 + 调用方式 + 权威归属
\`\`\`

弱命中时工具会自动追加「⚠ 命中质量均偏低 → 补足建议 + 验证命令」；真缺失照它引导，别硬编调用方式。

**兜底（终端可用时；完整台账/审计/健康检查）**：

\`\`\`powershell
Set-Location '${pluginDir}'
node cap.mjs brief "<意图>"     # 一眼读：类型 | 做什么 | 怎么调 | 谁主 | 边界
node cap.mjs query "<意图>"     # 匹配能力 + 调用方式 + 权威归属
node cap.mjs list hardware      # 或 list software / skill / mcp / automation …
node cap.mjs doctor             # 各权威域可达性 + 清单健康
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
 * ① 幂等自供给技能入口。
 * @returns {{action:'created'|'updated'|'unchanged'|'skipped', path:string}}
 */
export function provisionSkill(opts = {}) {
  const version = opts.version || '0.0.0';
  const pluginDir = opts.pluginDir || '';
  const home = opts.dshHome || dshHome();
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
  const block = `${MARK_BEGIN} v${version} — 由 dsh-capability-aware 插件维护，删除本块即停用） -->
## 能力与环境速查（自动注入）

**首选：直接调 \`capability_query\` 工具**（无需开终端、无需记路径；agent 入口，与 CLI 同分同源）：

- 任务依赖**本机环境**（硬件/软件/工具链），或**不确定本机是否具备某项能力**，或**怀疑某能力已消失**时，
  起手先调一次 \`capability_query({ query: "<任务意图>" })\`；返回里带类型、能做什么、怎么调用、权威归属。
- 弱命中时工具会追加「命中质量均偏低 → 补足建议 + 验证命令」；真缺失按该提示引导，不要硬编造调用方式。

**兜底 / 想看完整台账或做审计**（终端可用时）：

\`\`\`powershell
Set-Location "${pluginDir}"
node cap.mjs brief "<任务意图>"   # 一眼读：类型 | 做什么 | 怎么调 | 谁主 | 边界
node cap.mjs query "<意图>"       # 完整候选台账
node cap.mjs doctor               # 各权威域可达性 + 清单健康
\`\`\`

- 权威归属：技能路由→skill-use-router、记忆→memory_search、MCP/定时→宿主；**本机硬件/软件/环境事实→本插件**。
${MARK_END}\n`;
  let cur = '';
  try { cur = fs.readFileSync(file, 'utf8'); } catch { cur = ''; }
  const re = new RegExp(`${MARK_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${MARK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`);
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
