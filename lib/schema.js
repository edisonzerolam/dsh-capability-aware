// dsh-capability-aware · 能力条目 schema 与版本
// 插件名空间（settings / data 目录）：capability-aware
// ⚠ 本文件是能力条目的单一事实源：改字段先过测试（test/schema.test.mjs）

/** 能力类型（与 DSH 真实能力地形一一对应，见 README「能力地形」） */
export const CAP_TYPES = [
  'plugin',    // ~/.dsh/plugins/* + profile node_modules（有 package.json 的宿主插件）
  'skill',     // ~/.dsh/skills/*/SKILL.md + ~/.agents/skills/*（junction 实体）
  'mcp',       // ~/.dsh/storages/mcp_connector.json tables.connections（v3 实证路径）
  'memory',    // ~/.dsh/memory/README.md §1 表格登记的主题文件
  'knowledge', // Hindsight 知识库（backend 数据目录存在性）
  'automation',// ~/.dsh/storages/dsh_automation.json definitions（定时能力）
  'tool',      // cli 预登记（v1 手动白名单）
  'env',       // v2：本机环境能力（通道边界知识/自进化状态/本机事实）
  'hardware',  // v3：本机硬件（CPU/GPU/内存/磁盘/OS，WMI 单次采集）
  'software',  // v3：本机软件（卸载注册表三视图 + dev 工具链带版本）
] ;

/** 条目 schema 版本：字段变更时递增，registry 兼容旧快照 */
export const ENTRY_VERSION = 1;

/**
 * v4.2 权威归属表：**已有对应系统的能力类型，权威归已有系统，本插件只做快速索引底稿 + 兜底**。
 * 原则（用户裁决 2026-10-05）：不重复造轮子——invoke 一律指向权威入口；
 * 本插件自身检索仅在权威系统不可用（宿主服务缺失/离线/脚本缺失）时兜底。
 * 无对应系统的类型（env/hardware/software/plugin）本插件即权威。
 */
export const AUTHORITY = {
  skill: {
    system: 'skill-use-router',
    strength: 'assist', // 「我」在技能路由打分上不如专用路由器 → 它上，我辅助
    how: 'python ~/.dsh/skills/skill-use-router/scripts/skill_index.py query "<意图>"',
    note: '技能路由/打分/学习重排的权威入口；本插件条目为其索引底稿，仅供快速浏览与变更审计',
    onFailure: '路由器脚本/索引不可用时，用本插件清单作应急查询，结果须标注「来自索引底稿，非实时路由」',
  },
  memory: {
    system: 'dsh-mneme (memory_search)',
    strength: 'assist',
    how: 'memory_search "<关键词>"',
    note: '记忆条目级检索归 dsh-mneme；本插件只登记 memory/ 主题文件（文件粒度）',
    onFailure: '记忆服务不可用时，本插件只能给「有哪些主题文件」这一层，读文件正文兜底',
  },
  mcp: {
    system: 'DSH 连接器（mcp_connector_status）',
    strength: 'assist',
    how: 'mcp_connector_status / mcp_connector_tools_list（或 DSH 设置 → 连接器）',
    note: '连接器实时状态与工具清单归宿主；本插件登记连接与工具快照作索引底稿',
    onFailure: '宿主连接器服务异常时，本插件快照可回答「配过哪些连接器/有哪些工具」，但健康状态不可信',
  },
  automation: {
    system: 'DSH automation（automation_list）',
    strength: 'assist',
    how: 'automation_list（或侧边栏「任务|定时」→ 定时）',
    note: '定时任务的增删改查归宿主工具；本插件登记其名称/调度作索引底稿',
    onFailure: '宿主工具不可用时，读 dsh_automation.json 快照兜底（可能滞后）',
  },
  knowledge: {
    system: 'Hindsight（hindsight_search_knowledge_pages）',
    strength: 'assist',
    how: 'hindsight_search_knowledge_pages / hindsight_read_knowledge_page',
    note: '知识页检索归 Hindsight；本插件只做数据目录存在性探测',
    onFailure: 'Hindsight 后端不可用时，本插件只能报「后端数据目录是否存在」',
  },
};

/** v4.3：本插件为**主权威**的领域（DSH 无等价系统）——「我能力强，我上」 */
export const PRIMARY_DOMAINS = {
  env: '本机环境事实与抓取通道边界知识',
  hardware: '本机硬件事实（CPU/GPU/内存/磁盘）——加速类任务的决策依据',
  software: '本机已安装软件/dev 工具链事实（PATH + 卸载注册表口径）',
  tool: 'PATH 可达的 CLI 工具清单',
  plugin: 'DSH 宿主插件台账（含安装形态与重启要求）',
};

/** 每类能力的缺省补足引导（guidance.js 用；按优先级排列） */
export const GUIDANCE_BY_TYPE = {
  plugin: {
    hint: '安装对应插件后重启 DSH（插件在启动时刻判定，不热生效）。',
    command: 'dsh plugin --profile desktop add <tgz|npm 包名>',
  },
  skill: {
    hint: '把技能目录放入 ~/.dsh/skills/ 并重建索引（DSH 当轮热加载）。',
    command: 'python ~/.dsh/skills/skill-use-router/scripts/skill_index.py build',
  },
  mcp: {
    hint: '重新连接对应连接器（OAuth 型需浏览器授权，凭据型需填 API Key）。',
    command: 'DSH 设置 → 连接器 → 连接 <name>',
  },
  memory: {
    hint: '在 ~/.dsh/memory/ 建主题文件并在 README.md §1 登记一行（索引与文件一一对应，check_memory.py 会校验）。',
    command: '见 ~/.dsh/memory/README.md 写入纪律',
  },
  knowledge: {
    hint: '确认 Hindsight 后端已启动且数据目录存在（bank 初始化后才有知识页）。',
    command: 'DSH 设置 → Hindsight 插件',
  },
  automation: {
    hint: '用 automation_create 重建该定时能力（注意与官方 schedule_create 是两套互不相通的系统）。',
    command: 'automation_create(...)',
  },
  tool: {
    hint: '安装对应 CLI 工具并确认 PATH 可达。',
    command: '按工具自身安装说明',
  },
  env: {
    hint: '本机环境知识由技能 references（如 web-intel channel-notes.md）或探针登记自动产出；条目消失说明源技能被移动/删除，请检查技能目录。',
    command: '检查对应源技能是否还在（cap list skill）',
  },
  hardware: {
    hint: '本机硬件是物理事实，缺失时考虑：云端算力 / 远程机器 / 调整方案避开该硬件依赖（如转写改用 CPU 量化方案）。',
    command: 'cap list hardware 查看现有硬件能力',
  },
  software: {
    hint: '安装对应软件后重跑扫描即自动登记；dev 工具链须确认 PATH 可达（where <cmd> 验证）。',
    command: '按软件官方安装说明安装',
  },
};

/**
 * 规范化并校验一条能力条目。
 * @returns {{ok: true, entry: object} | {ok: false, errors: string[]}}
 */
export function normalizeEntry(raw) {
  const errors = [];
  const e = raw && typeof raw === 'object' ? raw : {};
  const name = typeof e.name === 'string' ? e.name.trim() : '';
  if (!name) errors.push('name 必填（非空字符串）');
  if (!CAP_TYPES.includes(e.type)) errors.push(`type 必须是 ${CAP_TYPES.join('/')}`);

  const out = {
    v: ENTRY_VERSION,
    name,
    type: e.type,
    // 描述：一句话，用于检索与展示
    description: typeof e.description === 'string' ? e.description.slice(0, 500) : '',
    // 触发条件：关键词/短语数组，检索主要匹配面
    triggers: Array.isArray(e.triggers)
      ? e.triggers.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().toLowerCase())
      : [],
    // v2 负触发：**仅**「已归档/勿用/deprecated」——真废弃，匹配强降权并告警。
    // v5 修正：不得与 disabled 混为一谈（旧实现 `negative: isDisabled || ex.negative` 把
    // 「只允许用户点名的敏感技能」当成废弃技能压到不可见——wechat-send-file 真实事故）。
    negative: e.negative === true,
    // 权限标志：disable-model-invocation（用户点名可用，agent 不得自动路由）/ mcp enabled=false。
    // 语义 = 「可被检索到，但需用户显式确认」，与 negative（勿用）完全不同档。
    disabled: e.disabled === true,
    // v5：路由层级（来自 skill-use-router index.json）——父/伞技能在子技能同时命中时降权，
    // 防「覆盖词型路由器」靠 trigger 全等压过具体子技能（真实回归：visual-studio 的「字幕」
    // 压过 web-intel/bili-daily）。super=父技能名，tier=层级。
    super: typeof e.super === 'string' && e.super ? e.super : undefined,
    tier: Number.isFinite(e.tier) ? e.tier : undefined,
    // v4.2：权威归属（已有对应系统时 = {system, how, note}；本插件仅索引底稿+兜底）
    authority: e.authority && typeof e.authority === 'object' ? e.authority : undefined,
    // v4.2：适用范围/边界（结构化，回答"这条能力能干什么、不能干什么、前置条件"）
    bounds: e.bounds && typeof e.bounds === 'object' ? e.bounds : undefined,
    // 调用方式：结构化，多种调用形态并存
    invoke: {
      // 'tool' | 'cli' | 'auto-route' | 'mcp' | 'manual'
      kind: typeof e.invoke?.kind === 'string' ? e.invoke.kind : 'manual',
      // 直接调用串（工具名 / CLI 命令 / 技能点名）
      how: typeof e.invoke?.how === 'string' ? e.invoke.how : '',
      // 示例
      example: typeof e.invoke?.example === 'string' ? e.invoke.example : '',
    },
    // 缺失时的补足引导（覆盖 GUIDANCE_BY_TYPE 的缺省）
    guidance: e.guidance && typeof e.guidance === 'object' ? e.guidance : undefined,
    // 来源探针（该条目由哪个 source 产出，diff 判定用）
    source: typeof e.source === 'string' ? e.source : '',
    // 来源侧的稳定指纹（如 dir mtime、SKILL.md sha、连接 id）
    fingerprint: typeof e.fingerprint === 'string' ? e.fingerprint : '',
    // 人工覆盖：auto 不改写这五个字段（scanner merge 时尊重）
    manual: {
      aliases: Array.isArray(e.manual?.aliases) ? e.manual.aliases.map(String) : [],
      notes: typeof e.manual?.notes === 'string' ? e.manual.notes : '',
      hidden: e.manual?.hidden === true,
      priority: Number.isFinite(e.manual?.priority) ? e.manual.priority : 0,
    },
  };
  // manual 覆盖 description（人工写的优先于扫描产出）
  if (out.manual && typeof out.manual.notes === 'string' && out.manual.notes && !out.description) {
    // description 为空时 notes 兜底
    out.description = out.manual.notes;
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, entry: out };
}

/** 判断一条 raw 记录是否为可识别的旧版/损坏条目（merge 时丢弃计数用） */
export function isRecognizable(raw) {
  return !!(raw && typeof raw === 'object' && typeof raw.name === 'string' && CAP_TYPES.includes(raw.type));
}
