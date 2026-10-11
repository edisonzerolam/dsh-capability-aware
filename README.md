# dsh-efficiency · DSH 效率机

> **v0.9.0（2026-10-11）· 扩容为「DSH 效率机」：接口索引 + 资源监控 + 分级诊断**
>
> **改名**：`dsh-capability-aware` → **`dsh-efficiency`**（插件 id、数据目录 `~/.dsh/data/efficiency/`、
> RPC 前缀 `/api/efficiency/*`、三段提示词命名空间 `efficiency:*`、自供给技能 `efficiency-lookup`、
> agent 工具 `efficiency_query`）。旧产物由 provisioner **主动退役**（旧 `AGENTS.md` 管理块与旧技能目录
> `capability-lookup`）——见 `lib/provision.js` 的 `LEGACY_MARK_PAIRS` / `retireLegacySkills()`。
>
> **三条目标**（用户原话）：
>
> **① 索引并快速定位工具/插件/环境/接口，为其他插件高效工作提供支持** —— 新增**接口面**
> （`lib/interfaces.js`）：宿主 Cordis 服务（13 条已知服务 + 运行期 `ctx.get` 探测补 `available` 真值）、
> Typert Remote（从各包 `lib/typert.host.js` 静态提取 id/service/method/params）、客户端 UI 插槽
> （19 个，每个带**语义专属触发词**，否则检索会退化成任意并列）、HTTP 路由前缀。实测 **174 条**接口条目，
> `type: 'interface'`，与能力条目走同一条检索链路。
>
> **② 监控运行中的插件/工具/技能等资源调度，防范卡死崩溃** —— `lib/monitor/`：**进程层**用 koffi FFI
> 直读 Win32（`OpenProcess` / `GetProcessTimes` / `K32GetProcessMemoryInfo` / `GetProcessIoCounters`；
> 这**推翻**了原规划「进程层不可达」的结论——Electron JS API 不可达 ≠ 进程数据不可达）；**会话层**读宿主
> 官方 `sessionStats` 投影算增量；**插件层**读 loader entries 的 Fiber 阶段。单个心跳（默认 3 s，空闲退避到
> 10 s）+ 有界环形落盘（20000 条，块裁剪）+ **自证开销**（`process.cpuUsage` 量自身，实测 0.000%/tick）。
> 六条检出规则 `PLUGIN_FAILED`(P0) / `PROCESS_GONE` / `HOT_PROCESS` / `MEMORY_GROWTH` / `IO_STORM` /
> `SESSION_STALL`，每条带 `evidence.basis`，纪律是**宁可漏报不可误报**（阈值类要求连续 N 次 + 冷却窗抑制）。
>
> **③ 记录报错 → 分级诊断 → 修复提示词** —— `lib/diagnose.js` 把错误账本与监控事件合成**版本化诊断信封**
> （schema `dsh-efficiency/diagnostics/v1`，对齐 dshmarket 诊断范式），按**确定性**（不是严重程度）分档：
> **P0** 宿主/加载器自己报的确定失败｜**P1** 本机可修且证据充分｜**P2** 需推断或影响面小｜
> **P3 不是本机该修的**（供应商限流/配额/断流/网络）。实测全量 13303 条记录 → 151 条 finding
> `{P0:1, P1:21, P2:104, P3:25}`、`fixable=126`；**provider 类占全部错误 40.6%**
> （RATE_LIMIT 2794 + SERVER 1115 + TIMEOUT 402 + TRANSPORT 283 …）——这正是 P3 存在的原因。
> `lib/fixprompt.js` 生成一段**可直接粘贴给新会话**的修复提示词（含「先判断身份」安全前置，防止被粘到
> **另一个** DSH 实例上改错机器），**只生成文本、不自动执行**；P3 单独标「不要修」且**不进可修清单**。
>
> **五面齐备**：三段常驻指令面（`efficiency:capability-index` 2950 / `efficiency:error-index` 2951 /
> `efficiency:resource-index` 2952）+ agent 工具面（`efficiency_query` / `error_ledger_query`）+ RPC 面
> （`/api/efficiency/*`，含 `/diagnose` 与 `/fixprompt` 两条只读路由）+ CLI + 技能面。
>
> **诚实边界（写进提示词正文，不靠人自觉）**：进程层是**测量值**，但一个进程里跑多个插件、
> **无法据此归因到单个插件**；插件层是**相关性排序，不是 CPU 归因**（DSH 不提供插件级资源计量 API）；
> 会话层增量是「本插件上次读取至今」的差值、**非宿主官方计费口径**；错误与资源事件的关联是
> **相关性不是因果**（字段名就叫 `correlatedWith`）。
>
> 测试：capability 44 + ledger 55 + efficiency 100 = **199/199 全绿**。

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
本机环境速查入口见技能 `efficiency-lookup`。

### 自供给（装上即得）

- **常驻指令面**（v0.7.0，默认开）★ 关键：用宿主公开的 `ctx.systemPrompt.section()` 往**系统提示词**注入一段行为规约——「任务依赖本机环境 / 不确定本机有无该能力 / 怀疑能力已消失时，**起手先调 `efficiency_query`**」，附权威归属与 CLI 兜底。**完全不改用户任何文件**（不写 `AGENTS.md`），纯运行时贡献，卸载即消失，**任何机器装上就复现**；v0.8.0 起追加第二段同款规约（位次 2951），指向错误账本工具 `error_ledger_query`；
- **技能入口**（默认开）：安装后首次启动自动把 `efficiency-lookup` 技能写入 `~/.dsh/skills/`（幂等带版本戳），harness 的技能目录即出现本能力，无需手工配置；
- **AGENTS.md 指针**（默认关闭）：向 `~/.dsh/AGENTS.md` 注入带管理标记的块——**工具优先**：起手直接调 `efficiency_query` 工具（不用开终端、不用记路径），CLI 只作兜底/台账/审计。改用户规则文件须显式配置 `provisionAgentsPointer: true`（在宿主 profile 的 cordis.patch.yml 覆盖即可），幂等维护、插件升级自动刷新。
  实测依据：一天运行日志显示后台扫描 103 次/0 错误，但 harness 主动调用 0 次——缺的就是这个必经触发点。

> **v0.8.0（2026-10-11）· 会话错误账本并入（用户裁决：「做进 dsh-efficiency 里面，不是新开一个插件」）**
> **为什么并入**：本插件的定位原则④是「其他系统出问题我兜底」——**「本机有什么能力」与「什么坏了 / 缺什么」
> 是同一问题的两面**。做成独立插件会让「能力清单」与「能力失效史」分家，agent 得记住两个工具、两份清单。
> **能力**：实时订阅 `session/event` 捕获每个会话的报错（工具失败 / LLM 重试 / 回合失败 / 中断 / 插件装载异常），
> 历史 1.2 GB 会话日志**一次性回填**（1821 文件 / 11.7 万条 / 22.7 秒），按
> **错误码 / 插件 / 技能 / 对象 / 责任方 / 工具 / 供应商 / 模型 / 类别 / 工作目录** 十个切面聚合。
> **关键设计（由真机数据驱动）**：`owner` 是**一等切面**——实测本机错误最大来源是模型路由与配额
> （`RATE_LIMIT` 2790 + `SERVER` 1090 + `TIMEOUT` 430 ≈ provider 5352 条），**不是本机代码缺陷**；
> 因此**自修复候选只收 `owner=local`**，供应商类错误一律不列——否则会去「修」不该修的东西。
> 本机真实可修的第一大项是 edit 工具误用（`FS_EDIT_NOT_FOUND` 773 + `old_string/new_string must differ` 308
> + `FS_NOT_OBSERVED` 594 ≈ 700 条），全部围绕「先 read 再 edit」这条纪律。
> **三面齐备**：常驻指令面（`efficiency:error-index`，位次 2951）+ agent 工具面（`error_ledger_query`，五视图）+
> RPC 面（`/api/efficiency/ledger/*` 七条）+ CLI（`node cap.mjs ledger <子命令>`）。
> **只读承诺**：只读会话日志，**不删任何文件**（源码级断言 `T48` 锁死）；只给候选与证据，不做自动改动。
> 测试：capability 40 项 + ledger 55 项 = **95/95 全绿**。

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
> 隔离真空 `DSH_EFF_DSH_HOME` 跑真实 `apply()` → `promptSection` 段注册、技能 v0.7.0 落盘、`AGENTS.md` **未**被创建。
> 回归测试 T28–T30，全套 **36/36 绿**。

> **v0.6.1（2026-10-09）· 缺陷 #7：监听过宽致写放大（运行体检取证）**
> 反应式监听原本裸听整个 `~/.dsh/storages` 与 `~/.dsh/memory`。实测：`~/.dsh/storages/whale.json`
> （**114 MB**，DeepTrace 插件的 store）被别的插件**每 30 秒重写一次**，`memory.db-wal` 亦持续写入
> → 每 30 秒触发一次全量扫描+落盘：10 分钟精确窗口 **10 次写入**（9 次 whale + 1 次 wal）
> = 1438 次/天、约 **1.66 GB/天**纯写放大，而两次扫描的条目 md5 **完全相同**（根本没变）。
> **修法**：每个监听根加**文件名白名单**——`storages` 只认 `mcp_connector.json` / `dsh_automation.json`
> （`lib/scanner.js:271` 与 `:334` 真正读的两个文件），`memory` 只认 `README.md` 与主题 markdown，
> `plugins` 只认 `.yml/.yaml/.js/.mjs/.json`；拿不到文件名时仍放行（宁可多扫一次，不漏真实变更）。
> 同版把供给文本（AGENTS 块 + `efficiency-lookup` 技能正文）统一改为**工具优先**。
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

## 核心功能

| 功能 | 实现 | 入口 |
|---|---|---|
| 能力自感知 | 10 类探针扫描能力地形 → fingerprint 级 diff → JSON 快照落盘 | `cap.mjs scan` / boot 自动扫描 / 每日巡检 |
| **接口面索引**（v0.9.0） | 宿主 Cordis 服务 + Typert Remote + 19 个客户端插槽 + HTTP 路由前缀 → `type:'interface'` 条目 | `cap.mjs interface` / `efficiency_query` |
| 能力快速检索 | 中英混排分词 + BM25-lite IDF + 触发词/人工别名直配 + 负触发降权 + 事实型降权 → 置信度排序 | `cap.mjs query "<任务>"` |
| 缺失引导 | no_match / stale 条目 → 按类型给出补足动作 + 验证命令（硬件=替代方案、软件=安装引导） | `cap.mjs stale` / `cap.mjs guide` |
| **错误账本**（v0.8.0） | 实时订阅会话事件 + 历史日志回填 → 十切面聚合 → 自修复候选（只收 owner=local） | `error_ledger_query` 工具 / `cap.mjs ledger <子命令>` |
| **资源监控**（v0.9.0） | 进程层 koffi FFI 直读 Win32 + 会话层投影差分 + 插件层 Fiber 阶段 → 3 s 心跳 + 有界环形落盘 + 六条检出规则 | `cap.mjs monitor` / `/api/efficiency/monitor/*` |
| **分级诊断**（v0.9.0） | 账本记录 + 监控事件 → 版本化诊断信封，按**确定性**分 P0–P3 | `cap.mjs diagnose` / `/api/efficiency/diagnose` |
| **修复提示词**（v0.9.0） | 诊断信封 → 可粘贴给新会话的提示词（含身份判定前置；**只生成文本不自动执行**） | `cap.mjs fixprompt` / `/api/efficiency/fixprompt` |

## 效率机（v0.9.0）：监控 / 诊断 / 修复提示词

### 为什么要分档，而不是按「严重程度」

分档的判据是**确定性**——「我凭什么敢说这是真的」：

| 档 | 含义 | 判据来源 | 可修 |
|---|---|---|---|
| **P0** | 确定故障 | 宿主/加载器**自己报出**的失败（插件 Fiber 阶段 failed、加载器 dispose 异常） | ✅ |
| **P1** | 本机可修 | 有明确错误码 + 明确修法，且责任方是 `local`（先 read 再 edit、沙箱后端不可用…） | ✅ |
| **P2** | 需推断 / 低影响 | 会话停滞、IO 尖峰、参数类误用 | ✅ |
| **P3** | **非本机问题** | 模型供应商限流/配额/断流/网络 | ❌ **绝不进修复提示词** |

一个 P0 未必比 P1「更严重」，但它**一定**是确定的事实而非推断。
P3 列出来只是让人看到「时间花在哪」——实测它占全部错误的 **40.6%**，如果诊断不区分责任方，
修复提示词会让 agent 一头扎进供应商限流里改本机代码，纯浪费且会掩盖真问题。

### 监控的诚实边界（这四个「不是」必须一直带着）

1. **进程层**是 koffi 直读 Win32 的**测量值**；但一个进程里跑多个插件，**无法据此归因到单个插件**。
2. **插件层**只报事实（entry id / 模块名 / 是否启用 / Fiber 阶段），是**相关性排序，不是 CPU 归因**
   —— DSH 不提供插件级资源计量 API，任何「插件 X 占 N% CPU」都是伪精度。
3. **会话层**增量是「本插件上次读取至今」的差值，**不是宿主官方计费口径**。
4. 错误与资源事件的关联是**相关性，不是因果**——字段名就叫 `correlatedWith`，且每条带 `deltaMs`。

### CLI 入口

```powershell
node cap.mjs monitor --live          # 现采全机进程树（不依赖插件进程；查卡顿/热点）
node cap.mjs monitor stats           # 心跳统计 + 自证开销（selfMsAvg / selfCpuPctApprox）
node cap.mjs monitor procs           # 当前进程排行（CPU/内存/IO）
node cap.mjs monitor sessions        # 三层中的会话层（增量，非官方计费）
node cap.mjs monitor events          # 检出事件（HOT_PROCESS / MEMORY_GROWTH / …）
node cap.mjs monitor selfcheck       # 采集器自检（自耗是否超过心跳的 0.5%）

node cap.mjs diagnose [--min=N] [--severity=P0]   # 分级诊断
node cap.mjs fixprompt [--out=f.md] [--no-ticket] # 生成修复提示词（默认同时开修复工单）
node cap.mjs fixes [list]                         # 修复台账：待修清单 + 复发核验
node cap.mjs fixes show <id>                      # 单张工单的核验详情
node cap.mjs fixes close <id> [--note="..."]      # 人工声明已修（声明，不是测量）
node cap.mjs fixes adopt --code=X --kind=tool --name=edit --at="2026-10-11T17:00Z"
                                                  # 为「上线前已经修过」的条目补一张工单
node cap.mjs interface                            # 接口面清册（服务/Remote/插槽/路由）
```

**数据布局**：`~/.dsh/data/efficiency/monitor/`（`monitor.v1.jsonl` 样本环形 + `events.v1.jsonl`
检出事件 + `meta.v1.json`）。与账本同级——一个插件一个数据目录。

**配置**（profile 侧 `cordis.patch.yml` 覆盖）：`monitor: false` 整体关闭，或传对象细调
`intervalMs` / `idleMs` / `sampleIntervalMs` / `maxSamples` / `keepRaw` / `detect.{hotCpuPct,hotStreak,
memGrowthMbPerMin,memStreak,ioStormMbPerTick,stallTicks,cooldownMs}` / `dir`；
`diagnose: false` 关掉两条诊断 RPC（**CLI 不受影响**——它直读落盘数据，不经宿主）。

## 修复台账（v0.11.0）

**解决什么**：诊断告诉你「什么坏了」，修复提示词告诉你「怎么修」，但**没有东西记得你修过**——
于是同一条 finding 修完之后还在清单里，你无法回答「这条我到底修了没有、修了之后还复发吗」。

**工单（ticket）**：每次生成修复提示词时，为入选的每条 finding 自动开一张工单，记录
finding 键、当时的次数与会话数、提示词 sha1、开单时刻。**开单时刻就是复发核验的分界线。**

**复发核验**：取「开单时刻之后」的账本记录，**重跑同一个 `diagnose()`**（`minCount:1`、
`topK` 不截断），按同一套分组键找回原 finding。这里刻意**不复用另一套计数逻辑**——
否则迟早出现「诊断说还在、台账说修好了」的分歧，而这种分歧比没有台账更糟。

**待修清单怎么收敛**：

| 状态 | 含义 | 是否留在待修 |
| --- | --- | --- |
| `recurring` | 开单后又出现 ≥1 次 | **留在待修并置顶**——「以为修好了结果没好」最值钱 |
| `watching` | 刚开单，观察窗口不足 | **留在待修**并单独标注 |
| `resolved` | 窗口已满且 0 次复发 | 移出，单列「未再复发」 |
| `declared` | 人工点了「标记为已修」 | 移出，单列——**这是声明，不是测量** |
| `superseded` | 同一 finding 又开了新工单，旧单程序性关闭 | 不占待修位，单列 |
| `unticketed` | 从未生成过修复提示词 | 留在待修 |
| `notFixable` | 档位判为「不是本机该修的」（P3） | **不在待修里**，单列 |

三条诚实纪律写在 `lib/fixes.js` 文件头，也体现在上表：

1. **「未再复发」≠「根因已消除」**——触发路径没被走到时同样显示 0 次。所以用词是
   「未再复发」而不是「已修复」，且**观察窗口长度必须与结论同屏**。
2. **人工关闭是声明不是测量**，单列 `declared`，不混进 `resolved`。
3. **无工单的条目不得凭弱证据移出**：久未见只加 `stale` 标注，仍留在待修清单里。
   同理，`watching`（窗口不足）**不移出**——把「还没看够」当「已经好了」是这个功能
   最容易做成的假看板。

**为什么 P3 不进待修清单**：P3 是本插件自己判定 `fixable:false` 的条目（供应商限流 /
配额 / 断流 / 网络），修复提示词里专门列在「不要修」一节。把 2797 次 `RATE_LIMIT`
这类条目摆进「待修」是**按类别说谎**：它既修不了，又会把真正该修的 P1 挤到列表后面
（实测 219 条待修里前几条全是 P3）。它们单列 `notFixable`，仍如实计数、仍可查。

**「上线前已经修过」的条目**：用 `fixes adopt --at=<时间>` 补一张工单，`basis` 标
`adopted-by-user`——**分界线是你给的时间，不是系统猜的**。

**RPC**：`GET /api/efficiency/fixes`（台账 + 核验 + 待修清单）、`POST /fixes/close`、
`POST /fixes/adopt`。设置页有对应的「修复台账」卡片。

## 错误账本（v0.8.0）

**解决什么**：同一类报错在几十个会话里反复出现，却没人知道它出现过多少次、在哪台机器、哪个工具上——
于是每次都从零排查。账本把「报错」变成可聚合、可追溯、可优先排序的**证据**。

**记录哪些**（错误事件面，全部经源码取证）：

| 事件 | 形状 | 说明 |
|---|---|---|
| `tool/result` | `data.error = {name, code}` | 工具失败；工具名靠 `callId` ↔ `tool/call` 关联 |
| `llm/retry` | `data.failure = {message, code}` + `provider` | 模型层失败（限流/断流/超时）；`model` 靠 `request/header` 富化 |
| `turn/end` | `data.reason.kind === 'error'` | 回合级失败 |
| `assistant/message` | `interrupted === true` | 用户中断（可关） |
| `loader/partial-dispose` | entry 异常卸载 | 插件装载期错误（插件切面） |
| `agent/error` | `{turn, step, error}` | 回合内抛错（罕见但最权威） |

**十个切面**：`code` / `plugin` / `skill` / `object` / `owner` / `tool` / `provider` / `model` / `category` / `cwd`。
其中 `object` 是从错误正文里抽出的**来源对象**（文件路径 / URL / 命令），`owner` 是**责任方**：
`local`（本机可修）/ `provider`（供应商侧）/ `external`（网络）/ `user`（用户中断）/ `unknown`。

**五视图工具** `error_ledger_query({ view, key, since, limit })`：

| view | 用途 |
|---|---|
| `recent`（默认） | 最近错误明细 |
| `facets` | 十切面聚合；`key` 下钻单切面 |
| `repair` | **自修复候选**（只收 `owner=local`，按 次数×会话数 排序，附样本与建议） |
| `search` | 按关键词检索原文 |
| `report` | 概览（时间跨度 / 责任方分布 / Top 码 / Top 对象 / Top 插件技能 / 按天分布） |

**CLI 等价入口**（人的通道；agent 走工具）：

```powershell
node cap.mjs ledger backfill [--force] [--workspace=] [--max-files=N] [--concurrency=N]
node cap.mjs ledger stats                 # 总量 / 时间跨度 / 责任方分布 / 按天
node cap.mjs ledger recent [N]            # 最近 N 条明细
node cap.mjs ledger facets [切面] [--top=K] [--since=7d]
node cap.mjs ledger repair [--min=5]      # 自修复候选（默认 ≥3 次）
node cap.mjs ledger search "<词>" [N]
node cap.mjs ledger report                # 人类可读概览
node cap.mjs ledger export [--out=f.json]
```

**数据布局**：`~/.dsh/data/efficiency/ledger/`（`events.v1.jsonl` 追加式 + `meta.v1.json` 回填水位线）。
与能力清单同属一个插件数据目录——一个插件一个数据目录（`topic-trail` 先例），清单在 `../capabilities.json`。

**诚实边界**：① 只读，绝不删除或修改任何会话日志；② 只给候选与证据，**不做自动改动**（自修复是人的决定）；
③ 供应商/配额类错误**不进**自修复候选——那是换路由/退避的事，不是「修代码」；④ 正文截断 1200 字符
（账本不是上下文仓库，只存定位所需的证据）；⑤ `capture:false` 时完全不订阅运行期事件（不留钩子）。

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
# 装进 desktop profile（本机 profile 名）
dsh plugin --profile desktop add "file:D:/Agent/CodeLib/dsh-efficiency"
# 首次安装即刻生效（宿主监听 profile 变更并立即重新 apply，实测装完 4 秒 apply() 已运行），
# 不必重启。启动后 3 秒（scanDelayMs）自动完成首次全量扫描，
# 清单落盘：~/.dsh/data/efficiency/capabilities.json
```

> **⚠ 生效时机（2026-10-11 实测修正，此前 README 的「必须重启」说法有误）**
>
> - **首次安装**：宿主监听 profile 变更后**立即重新 apply**，无需重启。
> - **更新已装插件的代码**：`remove` + `add` 只刷新磁盘副本并重新 apply，**跑不了新代码**。模块走 `import()`，Node 的 ESM 缓存按解析后的 URL 键控，**同一路径在进程内只求值一次**。
> - 实测（MARKER 实验）：把版本改成 `0.7.1-MARKER` 并重装，安装副本磁盘上确为 MARKER、`uptimeMs` 归零证明重新 apply 了，但活体仍报旧版本号 —— 跑的是首次加载时缓存的模块。
> - 所以**换新代码必须重启 DSH Desktop**（托盘菜单「重启」，或 `POST /api/desktop/restart`）。
> - 判断活体到底在跑哪一版：看 `~/.dsh/skills/efficiency-lookup/SKILL.md` 的版本戳（幂等写，内容变才刷新），或 `GET /api/efficiency/doctor`。

> 建议先在隔离 profile 验证（不碰主 profile、不占端口）：
> `dsh plugin --profile cap-probe add "file:D:/Agent/CodeLib/dsh-efficiency"` →
> `dsh --profile cap-probe --no-open --port 0` → 观察数据文件落盘 → 清理 profile。

⚠ 依赖纪律：本插件零运行时依赖（不 import 任何宿主包），无 `peerDependencies`
遮蔽风险；重装/升级不影响其他插件。

## 使用

```powershell
node cap.mjs scan                # 全量扫描 + 落盘 + 打印 diff（新增/消失/变更）
node cap.mjs list [类型]          # 列清单（plugin|skill|memory|mcp|automation|tool|env|hardware|software|interface）
node cap.mjs query "<任务描述>"   # 匹配能力 + 调用方式；默认摘要档，--detail=full 吐全条目
node cap.mjs doctor              # 能力健康报告（扫描年龄/探针错误/陈旧条目/负触发/检索自检/IDF 健康）
node cap.mjs stale               # 与上次快照 diff，报告已消失的能力（不落盘）
node cap.mjs guide "<能力名>" [类型]  # 对指定缺失能力生成补足引导
node cap.mjs alias "<条目名>" <别名…>  # 灌人工别名（检索词表鸿沟的正解，如 A股→AKShare）；clear 清空
node cap.mjs interface           # 接口面：宿主服务 / Typert Remote / 客户端插槽 / 路由前缀
node cap.mjs monitor --live      # 资源监控：现采全机进程树
node cap.mjs diagnose            # 分级诊断：P0–P3 按确定性分档
node cap.mjs fixprompt           # 生成修复提示词（只生成文本，不自动执行）
```

**定期巡检**（已建 DSH automation `automation_8fa49ea2-…`：每日 06:30 Asia/Shanghai，
全新会话执行 scan + doctor，removed/warn/error 逐条汇报、不自动修复）。
重建同款：`automation_create(kind=daily, time=06:30, prompt=上述巡检流程)`。

环境变量：`DSH_EFF_DSH_HOME` 重定向扫描根（多 profile / 测试）；`DSH_EFF_FILE` 重定向清单文件。

Web/RPC 面（`/efficiency/query|list|scan|guide`）按最小赌注接入宿主
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
npm test   # node --test test/capability.test.mjs test/ledger.test.mjs test/efficiency.test.mjs
           # —— 199 项（44 + 55 + 100），全绿
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
AGENTS 指针仍默认关闭）、
**v0.8.0 账本并入回归 T31–T34**（源码级接线 + 装配级真挂载 + `ledger:false` 完全关断 +
`lib/ledger/index.js` 只导出 `mountLedger` 不导出 `apply`，防双份 RPC 路由）、
**v0.9.0 旧品牌退役 T35–T38**（`provisionAgentsPointer` **退役**旧品牌管理块而不是再追加一块、
标记外内容一字不动、新块有且仅有一个且幂等；`retireLegacySkills` 只在**证据充分**时删旧技能目录、
同名非本插件所写一律 `kept-foreign` 保留、`retireLegacy:false` 可关）。

`test/ledger.test.mjs`（55 项）另覆盖：多帧 zstd 解码与 torn 帧、分类学与责任方判定、
对象抽取边界（含空格路径 / Unix 路径至少两级 / 英文连接词截断）、归因状态机（callId 关联、
污染工具名拒绝、技能归因、provider/model 富化、callId 表软上限）、存储与原子写、
切面聚合与自修复候选（含「桶键不被 `record.code` 覆写」的回归）、工具五视图、
历史回填与实时水位线、常驻指令面、源码级只读断言、`mountLedger` 端到端含真实 RPC handler 调用。

`test/efficiency.test.mjs`（100 项）覆盖 v0.9.0 三条目标：

- **诊断（目标 3）**：schema 版本化常量、四档语义与 `fixable` 标志、**每条规则都带 note**、
  文件系统类→P1、加载器/宿主契约→P0、供应商类→P3、`minCount`/`since` 阈值、未归类兜底归 **P2 而非 P0**、
  无码错误经 `classify` 兜底、**档位与 owner 自洽**（可修项 owner 必须是 local，原始归因留 `ownerRaw`）、
  **全量不变量「fixable 里绝不出现 P3 或 owner=provider」**、监控事件并入且带 `evidence.basis`、
  未知事件码直接丢弃、同码同主体跨源合并取更确定档位、`correlatedWith` 带 `deltaMs`、相关窗口、`topK`。
- **修复提示词**：「先判断身份」必须排在复现之前、第二步禁止照文档直接改代码、
  P3 只出现在「不要修」段落、`includeP3:false` 时彻底不出现、无可修项如实写「无」、
  第四步六条硬约束（含「不得删账本记录」「不得改 provider 项」）、结尾声明只生成不执行、`extra` 追加。
- **监控（目标 2）**：六条规则各自的命中与**不命中**（连续 N 次、streak 中断归零、自身进程不算热点、
  冷却窗抑制与过期后重报、内存非单调不报、斜率不足不报、IO 首周期无基线不报、负增量不报、
  会话停摆需有未完成 step）、`reset()` 清空状态；存储的环形**块裁剪**（超过 `max*1.25` 才裁到 `max*0.75`）、
  坏行跳过计数、事件文件独立不裁、写失败不抛、`DSH_MONITOR_HOME` 覆盖；`classify` 全部分支、
  `cpuPercent` 边界返回 `null` 而非 NaN；**源码级**断言 `procs.js` 绝不用 `execFileSync`（阻塞事件循环）
  且复用 `scratch` 缓冲；插件层 group 跳过与 `self` 标注、`rankPluginCandidates` 失败置顶；
  会话层增量语义与投影缺失时的 note 不覆盖第一手原因。
- **接口面（目标 1）**：`hostNodeModules` 显式覆盖与无效路径兜底、`scanTypertRemotes` 正则解析、
  `scanBundleRows` 解析、`nm=null` 返回空数组、19 个插槽都有语义专属触发词、`slotTriggers` 去重、
  `scanSlots` 反推消费者、`KNOWN_SERVICES` 每条带可粘贴 `how`、无 ctx 时 `available=null`+`origin=static`
  （**不假装知道可用性**）、有 ctx 时补真值、`ctx.get` 抛错被吞、`interfacesToEntries` 每条带
  `invoke.how` 且**指纹唯一**、路由条目不含旧品牌。
- **效率段与接线**：段名 `efficiency:resource-index` / 位次 2952、正文含三段问题与 CLI 入口、
  **显式警告「P3 一律不要动」**、四条诚实边界、`mountEfficiencySection` 从中央常量推导 order、
  无 `systemPrompt` 时优雅降级、`enabled=false`/无 ctx 不挂载、`section()` 抛错被捕获、
  源码级三坑防护（软注入 / `effect` 包裹 / 原地改属性不乐观谎报）、
  **全仓无旧品牌残留**（`docs/` 历史记录、`test/` 夹具与 `provision.js` 的「为删除而引用」三处显式豁免并写明理由）、
  三段位次连续 2950/2951/2952、`diagnose` 配置键**有真实消费者**（防死配置）、
  诊断 RPC 段落**源码级只读断言**（不得出现写操作）、`diagnose:false` 只关两条 RPC 不影响核心面。

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
- **v0.9.0 改名迁移（2026-10-11 已完成，留档以备复核）**：源码目录 → `D:\Agent\CodeLib\dsh-efficiency`；
  profile 依赖键与 `dsh.profile.bundles` 条目、本机覆盖块的 id/name 均已同步；安装副本刷新为
  `node_modules\dsh-efficiency`；数据由旧目录迁到 `~/.dsh/data/efficiency/`——
  `capabilities.json` + `ledger/events.v1.jsonl`（8.5 MB / 13303 条）+ `ledger/meta.v1.json`，
  **逐文件字节数核对一致**，旧目录保留作备份。
  ⚠ 迁移踩到并记下的坑：**数据目录名取自 `lib/index.js` 的 `const name`（`efficiency`），
  不是包名（`dsh-efficiency`）**——两者混用会把数据搬到错地方；dry-run 抓到了它。
  旧品牌产物由 provisioner **主动退役**：旧 AGENTS.md 管理块与旧技能目录 `capability-lookup`
  （退役前校验内容确属本插件旧版所写，证据不足则保留不删）。
- **监控数据是推断与测量的混合体**，README 与提示词里已逐条标注四个「不是」（见上文「监控的诚实边界」）。
  其中**插件层无法归因**是架构性限制，不是实现缺陷：宿主不暴露插件级资源计量。
- **进程层只在 Windows 可用**：koffi 直读 Win32 API 是主要路径；非 Windows 或 koffi 缺失时
  `sampleAll()` 退化为 `source:'self-only'`，只报 Host 自己并附 `note`（**不假装拿到全机数据**）。
- **`SESSION_STALL` 是六条规则里最弱的一条**（唯一基于推断而非测量），阈值刻意保守（默认连续 5 个周期），
  宁可漏报。若实测发现误报，先调 `detect.stallTicks` 而不是删规则。

### 2026-10-11 设置页实测后收紧的六项（D1–D6）

老板在设置页看到「中间一大片空白」「CPU 209.4%」并追问后逐项取证，结论与改动：

| # | 现象 | 根因（行号级） | 改动 |
|---|---|---|---|
| D1 | 标题与「概览」之间约 500px 空白 | `lib/client.js` 的 `S.intro` 带 `flex: '1 1 320px'`，而 intro 是 `S.wrap`（`flexDirection:'column'`）的**直接子元素** —— 纵向 flex 里 `flex-basis` 量的是**高度**，`grow:1` 再吃光剩余纵向空间 | 删掉 `flex`；测试锁死「intro 不得带 flex」+「全树不得再有 320px 基高写法」 |
| D2 | 表头写 `CPU%` 却出现 `209.4%` | 数是对的、标签骗人：`cpuPct` 口径是「100% = 占满 **1 个逻辑核**」，12 核机上 209% = 2.09 核 ≈ 整机 17.4%。独立复测（.NET `Process.TotalProcessorTime`，不走 koffi 路径）得 140.7%，同刻插件报 139.62%，差 0.8pp | `/monitor/procs` 响应新增 `cpuBasis` 字段，由页面原样上屏 |
| D3 | 「错误账本·记录」「坏行」长期显示 `—` | 客户端读的是 `/ledger/stats`，该路由只回**本次运行**的计数器（`captured/written/pending/dedup…`），**没有 `total`、没有 `badLines`**；累计真值在 `/ledger/recent`（`readTail` → `{total, badLines, records}`） | 取数改走 `/ledger/recent?limit=1` |
| D4 | 设置页自己就是负载 | `/monitor/procs` 每次请求都 `await sampleAll()` **重采一遍全机**，而采集器本已每 3s 采一次。实测一轮完整刷新 1313ms Host CPU / 806ms 墙钟 = **单核 162.9%**；5 秒间隔 ⇒ 常驻单核 26.3% | 采集器缓存最近一次采样（`lastSample()`），路由默认返回缓存（`?fresh=1` 强制重采），页面间隔 5s→15s |
| D5 | `PROCESS_GONE` 占全部事件 49.2% | 注释一直写「只报曾经稳定存在的」，代码却只做「上轮在、本轮不在」—— Windows 短命工具子进程的正常退出被当异常，平均每 12 秒一条 | 加 `goneMinTicks`（默认 3）连续存在门限；**severity 由 P1 降为 P2**（退出码无从读取 ⇒ 不能判定崩溃） |
| D6 | `SESSION_STALL` 占 45.6% | 原判据 `steps>0 && 无增量` 把**已结束/空闲**会话当停摆，9 个会话各被反复报约 70 次 | 只认「事件仍在流（`asOfSeq` 推进）但 `llmMs/toolMs` 零增长」；冻结的会话天然跳过 |

> ⚠ D6 的关键限制是**源码级事实**，不是实现偷懒：`lib/monitor/sessions.js` 的行投影
> **没有「已结束/活跃」标志**，已结束会话与停摆会话在投影里都是「`asOfSeq` 冻结 + 时间不增」，
> **无法区分**。所以只能退到「事件是否还在流」这一个可观测信号——这是判据的上限。

> 噪声实测基线（收紧前，2.67 小时 / 1631 条）：`PROCESS_GONE` 803（49.2%）、
> `SESSION_STALL` 744（45.6%）、`IO_STORM` 57、`MEMORY_GROWTH` 19、`HOT_PROCESS` 8
> —— **九成四是噪声**，且都是「恒亮的假告警」：按「宁可漏报不可误报」的纪律，
> 训练人忽略告警比没有告警更糟，故两条都收紧。
