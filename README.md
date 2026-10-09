# dsh-capability-aware · DSH 自我能力感知插件

**定位（v4.2，用户裁决）**：本插件是**快速索引底稿 + 兜底**——凡 DSH 已有对应系统的能力领域，
**权威归已有系统，本插件不重复造轮子**，只提供统一台账、变更审计与本机环境事实；权威系统不可用时才兜底。

| 能力领域 | 权威入口（**用它**） | 本插件角色 |
|---|---|---|
| 技能路由/打分/学习重排 | **skill-use-router**（`skill_index.py query`） | 索引底稿（358 条，含子技能/层级/禁用态） |
| 记忆条目检索 | **dsh-mneme**（`memory_search`） | 只登记 `memory/` 主题文件（文件粒度） |
| MCP 连接器状态/工具清单 | **宿主**（`mcp_connector_status`） | 连接与工具快照底稿 |
| 定时任务增删改查 | **宿主**（`automation_list`） | 名称/调度底稿 |
| 知识页检索 | **Hindsight** | 仅数据目录存在性 |
| **本机硬件/软件/环境事实** | **本插件即权威**（DSH 无等价物） | 唯一来源 |

每条条目都带 `authority`（权威归属：system/how/note）与 `bounds`（适用范围/限制/前置），查询答案里直接透出。
本机环境速查入口见技能 `capability-lookup`。

### 自供给（装上即得）

- **常驻指令面**（v0.7.0，默认开）★ 关键：用宿主公开的 `ctx.systemPrompt.section()` 往**系统提示词**注入一段行为规约——「任务依赖本机环境 / 不确定本机有无该能力 / 怀疑能力已消失时，**起手先调 `capability_query`**」，附权威归属与 CLI 兜底。**完全不改用户任何文件**（不写 `AGENTS.md`），纯运行时贡献，卸载即消失，**任何机器装上就复现**；
- **技能入口**（默认开）：安装后首次启动自动把 `capability-lookup` 技能写入 `~/.dsh/skills/`（幂等带版本戳），harness 的技能目录即出现本能力，无需手工配置；
- **AGENTS.md 指针**（默认关闭）：向 `~/.dsh/AGENTS.md` 注入带管理标记的块——**工具优先**：起手直接调 `capability_query` 工具（不用开终端、不用记路径），CLI 只作兜底/台账/审计。改用户规则文件须显式配置 `provisionAgentsPointer: true`（在宿主 profile 的 cordis.patch.yml 覆盖即可），幂等维护、插件升级自动刷新。
  实测依据：一天运行日志显示后台扫描 103 次/0 错误，但 harness 主动调用 0 次——缺的就是这个必经触发点。

> **v0.7.0（2026-10-10）· 常驻指令面：让「全新安装」达到应有水平**
> **问题**（用户提出）：技能入口会自动出现，但 `~/.dsh/AGENTS.md` 不会被动——意味着**别的机器装了这个插件，
> 达不到本机水平**；而 AGENTS.md 路线**必须改用户文件**，公共仓库不能替安装者默认改，只能靠本机 profile 覆盖，
> **不可移植**。根因：常驻指令面里没有本插件的任何痕迹，技能要先被列出/被 router 命中才可能用上，
> 而「环境类任务起手先查能力」这条**行为规约**根本没进上下文。
> **解法**：改用宿主**官方公开**的提示词注入点 `ctx.systemPrompt.section({name, order, text})`
> （权威写法对照 `@deepseek-ai/dsh-mcp-resources/lib/index.js:118-130`）。
> 位次取 **2950**，经与宿主 `SECTION_ORDERS` 全表交叉核对无碰撞（落在 `TOOL_REPORT:2900` 与 `TOOL_COMPUTER_USE:3000` 空档）。
> 两个坑已避：① 用 `ctx.inject(['systemPrompt'])` **软注入**，硬声明 `export const inject` 会让极简 profile 整体 pending；
> ② 注册用 `scoped.effect(...)` 包裹，否则热重载在同层重复注册会 throw（宿主 `section()` 明确如此规定）。
> **实证**（非纸面）：真实 cordis `Context` + 真实 `SystemPrompt` 服务下 `section()` 接受注册、`renderPrompt()` 输出含本段正文；
> 隔离真空 `DSH_CAP_HOME` 跑真实 `apply()` → `promptSection` 段注册、技能 v0.7.0 落盘、`AGENTS.md` **未**被创建。
> 回归测试 T28–T30，全套 **36/36 绿**。

> **v0.6.1（2026-10-09）· 缺陷 #7：监听过宽致写放大（运行体检取证）**
> 反应式监听原本裸听整个 `~/.dsh/storages` 与 `~/.dsh/memory`。实测：`~/.dsh/storages/whale.json`
> （**114 MB**，DeepTrace 插件的 store）被别的插件**每 30 秒重写一次**，`memory.db-wal` 亦持续写入
> → 每 30 秒触发一次全量扫描+落盘：10 分钟精确窗口 **10 次写入**（9 次 whale + 1 次 wal）
> = 1438 次/天、约 **1.66 GB/天**纯写放大，而两次扫描的条目 md5 **完全相同**（根本没变）。
> **修法**：每个监听根加**文件名白名单**——`storages` 只认 `mcp_connector.json` / `dsh_automation.json`
> （`lib/scanner.js:271` 与 `:334` 真正读的两个文件），`memory` 只认 `README.md` 与主题 markdown，
> `plugins` 只认 `.yml/.yaml/.js/.mjs/.json`；拿不到文件名时仍放行（宁可多扫一次，不漏真实变更）。
> 同版把供给文本（AGENTS 块 + `capability-lookup` 技能正文）统一改为**工具优先**。
> 回归测试 T24–T27（含真实 `fs.watch` 行为级验证），全套 **33/33 绿**。


自动扫描并维护 DSH 的能力清单（插件 / 技能 / 记忆 / 连接器 / 自动化 / CLI 工具 / **本机环境** / **硬件** / **软件**），
按任务意图快速匹配能力及调用方式，能力缺失时给出针对性补足引导。

> **v2（2026-10-05）**：按全网调研修正——新增 `env` 本机环境能力类型与触发词自动提取、
> 检索升级 BM25-lite（IDF 加权）、负触发降权（已归档/勿用技能）、`doctor` 健康报告、
> 每日 06:30 定时巡检（DSH automation）。依据：
> [MCP 官方 Client Best Practices](https://modelcontextprotocol.io/docs/2026-07-28/develop/clients/client-best-practices)（Progressive Tool Discovery：Catalog→Inspect→Execute 三层、关键词 BM25 对描述型名称简单有效、`list_changed` 重索引）、
> [Claude Skills 官方](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)（description 即触发器：须同时说「做什么+何时用」）、
> [SBoM drift 定义](https://nhimg.org/glossary/sbom-drift/)（声明 vs 运行态偏差→doctor 口径）。
>
> **v3（2026-10-05）**：① **MCP 探针实证修正**（路径 → `mcp_connector.json`，工具快照 +
> 连接器市场目录中文 tags 并入触发面）；② 新增 `hardware`/`software` 类型（WMI 单次采集
> 排除虚拟显卡、卸载注册表三视图 + dev 工具链带版本）；③ 检索四修正（**人工别名层**
> `cap.mjs alias` / desc 封顶 3 token / 单字 CJK 边界守卫 / 事实型降权）；④ `ambiguous`
> 补 `top` 字段；⑤ IDF 现算语料含 aliases。依据：[docs/research-2026-10-05.md](docs/research-2026-10-05.md)
> （MCP 官方 registry/server.json/低频拉取 调研蒸馏）。

> **v5 / v0.6.0（2026-10-07）**：**基于真实调用取证**的六缺陷修复——不是纸面推演，全部由
> 36 小时会话日志里挖出的真实失败案例驱动（详见 [docs/research-2026-10-05.md](docs/research-2026-10-05.md)）。
>
> | # | 缺陷 | 真实事故 | 修法 |
> |---|---|---|---|
> | 1 | **人工数据被扫描抹平** | `manual.aliases` 被 `normalizeEntry` 的空默认值覆盖 → 全清单 563 条带人工数据者 **0**；灌入 AKShare 别名后排名 12 → **1** | `mergeManual()` 逐字段「非空者胜」 |
> | 2 | **受限技能被当废弃技能** | `disable-model-invocation`（权限标志）与「已归档/勿用」被合并成同一 `negative` → `wechat-send-file` 连**精确点名都返回 no_match** | 拆成 `disabled` / `negative` 两档语义：前者可检索、点名可用、带告警；后者才强降权 |
> | 3 | **缺失被伪装成有候选** | 单字 CJK 几乎命中每条中文描述 → 「文生图」6 条并列 12.61 的**噪声地板** | desc 命中禁单字；新增 `queryStrength`（cov/exact/aliasHit）判据，弱命中**保留候选 + 附加缺失提示**（不误杀真有能力的查询） |
> | 4 | **agent 走的是退化路径** | `tool.js` 漏传 `idf` → 退化为常数权重，实测「查A股」全候选**并列 16 分**；此前所有 CLI 验证都没覆盖 agent 真实路径 | `match()` 缺省 idf 自愈 + `tool.js` 显式传参（双保险） |
> | A | **同名条目互相覆盖** | 清单存在 18 组同名条目（`bili-daily` 顶层 vs web-intel 子技能、`skill-creator` 3 条）→ `(type,name)` 键致 diff 失真 | `entryKey()` 带上 `source` |
> | B | **路由器覆盖词压过专精技能** | `visual-studio`（4 子技能路由器）靠 `字幕` 触发词压过真正的字幕技能 | 父子竞争让位（父 ×0.7）+ 单字拉丁权重 0.5（治「抓**B**站」里单字 `b` 贡献 +43.47） |
>
> **数据层（新增 `lib/seed.js`）**：预置人工别名**随插件分发**，首次扫描即注入且跨扫描存活——
> 新装机器装上就修好词表鸿沟，无需手工 `cap.mjs alias`。当前覆盖三处已取证缺口：
> `AKShare`（A股/沪深/行情数据…）、`wechat-send-file`（发我微信/发到微信…）、
> `imagegen-frontend-web`（文生图/图像生成…，仅解决可检索性，其边界由条目自身说明）。
> 语义为**并集**：用户自己加的别名永不被覆盖。
>
> 测试 20 → **29 全绿**（新增 T15–T23 逐条锁死上述修复，含源码级断言防回归）。

## 三个核心功能

| 功能 | 实现 | 入口 |
|---|---|---|
| 能力自感知 | 10 类探针扫描能力地形 → fingerprint 级 diff → JSON 快照落盘 | `cap.mjs scan` / boot 自动扫描 / 每日巡检 |
| 能力快速检索 | 中英混排分词 + BM25-lite IDF + 触发词/人工别名直配 + 负触发降权 + 事实型降权 → 置信度排序 | `cap.mjs query "<任务>"` |
| 缺失引导 | no_match / stale 条目 → 按类型给出补足动作 + 验证命令（硬件=替代方案、软件=安装引导） | `cap.mjs stale` / `cap.mjs guide` |

## 能力地形（探针覆盖）

- **skill**：`~/.dsh/skills/*/SKILL.md` + `~/.agents/skills/*/SKILL.md`（junction 按 realpath 去重，`.bak*`/`_snapshot`/`.incoming` 排除）
- **plugin**：`~/.dsh/plugins/*/package.json`（声明 `dsh.bundle.patch` 才算宿主插件）
- **memory**：`~/.dsh/memory/README.md` §1 表格登记的主题文件（索引↔文件一一对应口径）
- **mcp**（v3 实证修正）：`~/.dsh/storages/mcp_connector.json` 的 `tables.connections`；
  触发面三源合并——连接器市场目录（`tables.catalog.remote.connectors` 中文 summary/tags）+
  SKILL 式描述提取 + `tables.tool_catalog` 工具快照（工具名进 triggers、`invoke.example`
  给可直接调用的 `mcp__<server>__<tool>`）；`enabled=false` 标 `disabled`（停用≠缺失）
- **automation**：`~/.dsh/storages/dsh_automation.json` 的 `tables.definitions`（第三方自动化系统口径）
- **knowledge**：Hindsight 数据目录存在性
- **tool**：CLI 白名单（默认 `python/node/git/rg/dsh`，可用 `tools` 配置扩展）
- **env**（v2）：本机环境能力，三类来源——① web-intel `channel-notes.md` 通道边界表逐条
  （「失败特征 → 正确通道 → 验证命令」，抓取/搜索前先走对通道）；② web-intel 自进化状态
  （`.state` 有记录 = 有通道纠偏能力）；③ 本机事实探针（控制台 cp936 编码、本地代理 7897、
  playwright chromium 路径、技能双根——实测存在才登记，事实性条目非规则）
- **hardware**（v3）：WMI 单次采集 CPU/内存/实体 GPU（排除 Todesk/OrayIdd 等虚拟显示适配器）/磁盘/OS，
  指纹日级（硬件不频繁变化）；GPU 加速类任务先核此条目再查官方支持矩阵
- **software**（v3）：dev 工具链（python/node/git/uv/pnpm/gh/docker/ffmpeg/yt-dlp，带精确版本号）
  + 卸载注册表三视图合并的已安装软件清单（过滤 SystemComponent/KB 噪声，默认上限 200 条）

## 安装与启用

```powershell
# 装进 desktop profile（本机 profile 名；装完需重启 DSH——插件在启动时刻判定，不热生效）
dsh plugin --profile desktop add "file:D:/Agent/CodeLib/dsh-capability-aware"
# 然后重启 DSH。启动后 3 秒（scanDelayMs）自动完成首次全量扫描，
# 清单落盘：~/.dsh/data/capability-aware/capabilities.json
```

> 建议先在隔离 profile 验证（不碰主 profile、不占端口）：
> `dsh plugin --profile cap-probe add "file:D:/Agent/CodeLib/dsh-capability-aware"` →
> `dsh --profile cap-probe --no-open --port 0` → 观察数据文件落盘 → 清理 profile。

⚠ 依赖纪律：本插件零运行时依赖（不 import 任何宿主包），无 `peerDependencies`
遮蔽风险；重装/升级不影响其他插件。

## 使用

```powershell
node cap.mjs scan                # 全量扫描 + 落盘 + 打印 diff（新增/消失/变更）
node cap.mjs list [类型]          # 列清单（plugin|skill|memory|mcp|automation|tool|env|hardware|software）
node cap.mjs query "<任务描述>"   # 匹配能力 + 调用方式；默认摘要档，--detail=full 吐全条目
node cap.mjs doctor              # 能力健康报告（扫描年龄/探针错误/陈旧条目/负触发/检索自检/IDF 健康）
node cap.mjs stale               # 与上次快照 diff，报告已消失的能力（不落盘）
node cap.mjs guide "<能力名>" [类型]  # 对指定缺失能力生成补足引导
node cap.mjs alias "<条目名>" <别名…>  # 灌人工别名（检索词表鸿沟的正解，如 A股→AKShare）；clear 清空
```

**定期巡检**（已建 DSH automation `automation_8fa49ea2-…`：每日 06:30 Asia/Shanghai，
全新会话执行 scan + doctor，removed/warn/error 逐条汇报、不自动修复）。
重建同款：`automation_create(kind=daily, time=06:30, prompt=上述巡检流程)`。

环境变量：`DSH_CAP_DSH_HOME` 重定向扫描根（多 profile / 测试）；`DSH_CAP_FILE` 重定向清单文件。

Web/RPC 面（`/capability-aware/query|list|scan|guide`）按最小赌注接入宿主
`ctx.connection.rpc`；若宿主 RPC API 形态变化，CLI 通路不受影响（核心逻辑零依赖宿主）。

## 能力条目数据结构

```jsonc
{
  "v": 1,                       // 条目 schema 版本
  "name": "web-intel",
  "type": "skill",              // plugin|skill|mcp|memory|knowledge|automation|tool|env|hardware|software
  "description": "网络情报超级技能——…（≤500 字符）",
  "triggers": [],               // 触发词（小写规范化；检索主匹配面；MCP 条目含市场目录 tags + 工具名）
  "negative": false,            // 负触发（已归档/勿用）：匹配强降权 + 告警
  "invoke": {                   // 调用方式
    "kind": "auto-route",       // tool|cli|auto-route|mcp|manual
    "how": "skill-use-router query \"web-intel\"",
    "example": "/skill web-intel"
  },
  "guidance": null,             // 缺失时自定义引导（覆盖按类型的缺省）
  "source": "skills:web-intel", // 产出探针
  "fingerprint": "e70a10e74c609c4b:2026-10-04T…", // 变更检测指纹（内容 hash + mtime/版本/日级）
  "disabled": false,            // 仅 mcp：enabled=false 时为 true（停用≠缺失）
  "manual": {                   // 人工字段：scan 永不覆盖
    "aliases": [],              // 人工别名（cap.mjs alias 灌入；触发面并入 + 整词覆盖强加分）
    "notes": "", "hidden": false, "priority": 0
  }
}
```

## 边界情况处理

| 情形 | 行为 |
|---|---|
| 清单为空 / 未初始化 | `query` 返回 `empty_registry` + 引导先跑 scan（exit 2） |
| 用户需求模糊 | 无命中 → 按类型词表猜测（`guessType`）+ 给通用补足口径 |
| 匹配到多个候选 | 置信度并列或 ≥0.75 接近 → `ambiguous` + clarifications + top（最高分仍可直接用） |
| 技能已归档/勿用 | 负触发：匹配强降权 + warnings 告警（v2，防错路由） |
| 能力被移除 | 下次 scan 的 `diff.removed` 捕获 → `guideStale` 按类型给针对性引导；每日巡检兜底 |
| 单探针失败 | 不影响其他探针，失败计入 `meta.lastScanProbeErrors`，doctor 列出 |
| 弱匹配噪声 | `minScore`（默认 4）+ IDF 降权泛化词；`manual.priority` 人工加权；`hidden` 屏蔽 |
| 索引假健康 | doctor 检索自检：样本查询必须命中，防「扫描成功但匹配坏了」 |
| 检索词表鸿沟（v3） | 同义词不字面匹配（A股↔股票）→ `cap.mjs alias` 灌人工别名，整词覆盖强加分 |
| 硬件缺失（v3） | 引导给替代方案（云端/远程/绕开依赖），不瞎建议升级硬件 |
| MCP 连接器停用 | `disabled: true` 登记（停用≠缺失），引导指向连接器重连而非重装 |
| 事实型 vs 能力型竞速 | env/hardware/software 命中 ×0.85：任务意图优先路由到能力型条目 |

## 测试

```powershell
npm test   # node --test test/capability.test.mjs —— 36 项验收测试（隔离 fixture，不碰真实 ~/.dsh）
# 注意：本机 node --test test/ 目录形态会报 MODULE_NOT_FOUND，须指文件。
```

覆盖：探针映射先验（≥1 命中才信整批）、落盘幂等、验收 A（匹配+调用方式）、
验收 B（移除检测+针对性引导）、空清单/空查询/无命中、多候选澄清、类型猜测、schema 校验、
v3 增补（MCP 真实结构探针/虚拟显卡排除/注册表解析噪声过滤/硬件软件检索与引导）、
**v5 六缺陷回归 T15–T23**（`mergeManual` 别名存活 / 端到端灌别名→scan→存活 / disabled≠negative /
`queryStrength` 真命中 vs 噪声榜首 / Bug4 idf 自愈 + 源码断言 / `entryKey` 同名不同源 /
父子竞争让位 / 预置别名幂等且不覆盖用户别名 / 弱命中保留候选）、
**v0.6.1 缺陷 #7 回归 T24–T27**（监听根 accept 白名单源码级断言 + 真实 `fs.watch` 行为级验证
whale.json 被挡而 mcp_connector.json 放行 / 工具优先文案断言 / 版本戳一致）、
**v0.7.0 常驻指令面回归 T28–T30**（`promptSectionText` 含行为规约/工具名/权威归属且工具优先；
`mountPromptSection` 软注入 `['systemPrompt']` + order 有限且落 2900..3000 空档 + `text` 函数形态 +
`effect` 包裹 + 可关闭；`index.js` 接线且 `promptSection` 默认开启、仍**不**硬声明 `inject`、
AGENTS 指针仍默认关闭）。

## 已知边界（未验证 / 待做）

- RPC 路由面未在真实宿主验证过 RPC 签名（boot 扫描 + CLI 已实证）；接 GUI 面板时再验。
- software 注册表探针依赖 PowerShell；非 Windows 环境该探针报错并计入 probeErrors（其余探针不受影响）。
- knowledge 探针只做数据目录存在性，不做内容断言。
- 检索仍是 keyword 层：同义词鸿沟靠**预置别名（`lib/seed.js`）+ `alias` 人工策展**；预置集只收
  有真实取证支撑的缺口，不做无差别铺词。>1000 条或别名维护成本上升时再评估 embedding 路线。
- `queryStrength` 是**附加提示**而非排序信号（设计取舍：宁可多一句提示，也不把真有能力的查询误判为缺失）；
  最坏情况是提示多余，不会丢候选。
- 预置别名按条目 `name`（+可选 `type`）匹配；同名条目（如 `imagegen-frontend-web` 有两条）
  会同时命中，这是刻意的（同名即同能力语义）。
- **v0.6.1 已修缺陷 #7（监听过宽 → 写放大）**：`~/.dsh/storages` 与 `~/.dsh/memory` 改为**文件名白名单**
  监听。实测修复前 `~/.dsh/storages/whale.json`（114 MB，别的插件每 30 秒重写）会触发
  1438 次/天扫描+落盘、约 1.66 GB/天纯写入，而清单条目 md5 根本没变。修复后噪声文件不再触发扫描；
  代价是「拿不到文件名时仍放行」——宁可多扫一次，不可漏掉真实变更。
- **仍未做（有意的权衡）**：`applyScan` 落盘守卫（条目指纹未变则跳过写盘）未实施——完全不写盘会让
  `meta.lastScanAt` 老化并触发 `lib/doctor.js:29-38` 的 `STALE_SCAN`（warn，阈值 24h）误报，
  需要「内容不变但仅刷新扫描时间」的轻量策略。白名单已消掉 90% 噪声，暂不引入这个复杂度。
- **v0.7.0 常驻指令面用的是宿主 `systemPrompt.section()`**，位次 2950（`TOOL_REPORT:2900` 与
  `TOOL_COMPUTER_USE:3000` 之间空档）。该位次若与将来新增的宿主段冲突，宿主会在同层重复注册时
  抛错（可见、不静默）；届时改 `lib/prompt-section.js` 的 `SECTION_ORDER` 即可。
  本段是**常驻**的，会占用每轮少量上下文（正文约 460 字符）；不想要可在 profile 侧设 `promptSection: false`。
- 与本插件无关的顺带发现（未处理）：`~/.dsh/storages` 下有 23 个 `.*.tmp` 共约 722 MB，
  内容为 `{"unit":{"name":"whale",...}}`，疑为 whale 插件原子写残留，**未删除**（删前须核实引用）。
