// dsh-capability-aware · scanner.js
// 能力自感知：扫描 DSH 能力地形，产出原始条目流（不落盘，落盘归 registry）。
// 设计纪律（harness-ops.md §L）：
//  - 每类探针的映射字段必须先在真实样例上验证（counter 先断言 ≥1 命中再信整批）。
//  - 统计口径前置声明：排除 .bak*/node_modules/.incoming 等污染源。
//  - 单探针失败不影响其他探针（Promise.allSettled），失败计入 probeErrors。
//  - junction（符号链接）只按 realpath 收一次（~/.agents/skills 下 18/23 是 junction）。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { AUTHORITY, PRIMARY_DOMAINS } from './schema.js';

function homeDsh() {
  return process.env.DSH_CAP_DSH_HOME || path.join(os.homedir(), '.dsh');
}

/** CAP_TYPES 已在 schema.js 声明；env 为 v2 新增（本机环境能力，见 probeEnv） */

function listDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .filter((d) => !d.name.startsWith('.'))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function mtimeIso(p) {
  try {
    return fs.statSync(p).mtime.toISOString();
  } catch {
    return '';
  }
}

// ── triggers 自动提取（调研回归点：Claude Skills「description 即触发器」）──
// 中文技能描述的通行惯例（本机 54 技能实测）：「触发词：」/「用词触发：」/「提到…时触发」段。
// 提取出的词条作 triggers；带「勿用/已归档/不要」的段落产 negative:true（匹配强降权）。
export function extractTriggers(text) {
  const out = [];
  let negative = false;
  if (!text) return { triggers: out, negative };
  // 负触发：技能被归档/点名勿用
  if (/已归档|勿用|不要使用|deprecated/i.test(text.slice(0, 80))) negative = true;
  const patterns = [
    /(?:触发词|用词触发|关键词|triggers?)\s*[:：]\s*([^。\n]{2,200})/g,
    /(?:当用户提到|提到|提到[^时]{0,6}时触发|说到)\s*[:：]?\s*([^。\n]{2,200})/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text))) {
      const seg = m[1];
      // 按中文引号/顿号/逗号/引号切词
      const words = seg
        .split(/[、「，,「”"'『』（）()；;]+/)
        .map((w) => w.trim().replace(/^["'「」 ]+|["'「」 ]+$/g, ''))
        .filter((w) => w.length >= 2 && w.length <= 30);
      for (const w of words) out.push(w.toLowerCase());
    }
  }
  // 去重
  return { triggers: [...new Set(out)].slice(0, 30), negative };
}

// ── 本机事实探针（env 类型 · 事实性条目，非规则）──────────────────────
// 与 AGENTS.md 规则分离：本插件只登记「事实/状态」，判定规则留在各技能自身。
const LOCAL_FACT_PROBES = [
  {
    name: 'local-console-cp936',
    test: () => process.platform === 'win32',
    description: 'Windows 控制台默认 codepage cp936：裸写文件即 GBK；PowerShell Get-Content 读 UTF-8 文件显示 mojibake（文件本身无害）。文本文件一律显式 UTF-8 无 BOM。',
    triggers: ['乱码', 'mojibake', '编码', 'utf-8', 'gbk', 'cp936', '控制台乱码'],
    invoke: { kind: 'manual', how: '写文件显式 encoding="utf-8"；读回用 read 工具而非控制台打印' },
  },
  {
    name: 'local-proxy-7897',
    test: () => {
      const net = spawnSync('powershell', ['-NoProfile', '-Command',
        '(Test-NetConnection -ComputerName 127.0.0.1 -Port 7897 -WarningAction SilentlyContinue).TcpTestSucceeded'], { windowsHide: true, timeout: 15000 });
      return String(net.stdout || '').trim() === 'True';
    },
    description: '本机本地代理常见端口 7897（OPEN，2026-09-15 实测）：全球通道（google/ddg 等）默认走代理试探，CN 引擎直连需显式限定 engines 列表。',
    triggers: ['代理', 'proxy', '7897', '网络通道', '直连'],
    invoke: { kind: 'manual', how: '需要纯 CN 直连时显式限定 engines；全球通道空了自动降级 CN' },
  },
  {
    name: 'local-playwright-chromium',
    test: () => fs.existsSync(path.join(process.env.LOCALAPPDATA || '', 'ms-playwright')),
    description: '沙箱内无头浏览器为 Python playwright（非系统 Chrome）：裸 chromium.launch() 会找错版本，须 executable_path 指向 %LOCALAPPDATA%\\ms-playwright\\chromium-*。',
    triggers: ['无头浏览器', 'playwright', 'chromium', '浏览器自动化', '截图'],
    invoke: { kind: 'cli', how: 'launch(executable_path=r"%LOCALAPPDATA%\\ms-playwright\\chromium-<ver>\\chrome-win64\\chrome.exe")' },
  },
  {
    name: 'local-skills-two-roots',
    test: () => fs.existsSync(path.join(path.dirname(homeDsh()), '.agents', 'skills')),
    description: '本机技能有两棵根：~/.dsh/skills 与 ~/.agents/skills（junction 互通）；清点/检索技能必须两边都扫，否则漏一批。',
    triggers: ['技能目录', 'skills 目录', '技能在哪', '两棵根'],
    invoke: { kind: 'manual', how: 'cap list skill（本插件已自动双根扫描）' },
  },
];

// ── 探针 1：skills（两棵根：~/.dsh/skills/*/SKILL.md + ~/.agents/skills/*/SKILL.md）──
// 口径：顶层目录含 SKILL.md 即一条；.bak*/_snapshot/.incoming 排除（harness-ops §L 备份目录污染实证）。
// junction（符号链接）按 realpath 去重（~/.agents/skills 下多数是 junction，2026-10-03 实证 18/23）。
function probeSkillRoot(root, seen) {
  const entries = [];
  for (const name of listDirs(root)) {
    if (/\.bak|_snapshot|\.incoming/i.test(name)) continue;
    const dir = path.join(root, name);
    const skillMd = path.join(dir, 'SKILL.md');
    if (!fs.existsSync(skillMd)) continue;
    let real = dir;
    try {
      real = fs.realpathSync(dir);
    } catch {}
    if (seen.has(real)) continue;
    seen.add(real);
    const md = fs.readFileSync(skillMd, 'utf8');
    const m = md.match(/^name:\s*(.+)$/m);
    const d = md.match(/^description:\s*(.+)$/m);
    const desc = (d ? d[1] : '').trim().slice(0, 500);
    // v2：triggers 自动提取（「触发词：」段）+ 负触发（已归档/勿用）
    const ex = extractTriggers(desc);
    entries.push({
      name: (m ? m[1] : name).trim().replace(/^["']|["']$/g, ''),
      type: 'skill',
      description: desc,
      triggers: ex.triggers,
      negative: ex.negative,
      source: `${path.basename(root)}:${name}`,
      fingerprint: sha256(Buffer.from(md)) + ':' + mtimeIso(skillMd),
      invoke: { kind: 'auto-route', how: `skill-use-router query "${name}"`, example: `/skill ${name}` },
    });
  }
  return entries;
}

export function probeSkills(opts = {}) {
  const skip = opts.skip instanceof Set ? opts.skip : new Set();
  const home = homeDsh();
  const seen = new Set();
  const out = [
    ...probeSkillRoot(path.join(home, 'skills'), seen),
    ...probeSkillRoot(path.join(path.dirname(home), '.agents', 'skills'), seen),
  ];
  // v4.1 吸收 skill-use-router：其索引（358 条，含子技能/层级/禁用态）已覆盖的技能名跳过，
  // 避免重复条目；仍扫目录以兜住「新装技能尚未重建索引」的空窗。
  return out.filter((e) => !skip.has(e.name));
}

// ── 探针 11：吸收 skill-use-router 索引（用户自创技能的权威技能源）───────────
// 源：~/.dsh/skills/skill-use-router/references/index.json = {generated, entries[358]}
// 字段：{name, dir_name, path, root, rel, tier, super, description, disabled, version, tokens}
// 分工：路由器 = 技能检索/路由的权威入口（本插件不改其算法，只吸收其索引）；
//       本插件 = 跨源统一清单 + 变更审计 + 环境事实（硬件/软件），二者互补不互斥。
export function probeSkillRouter() {
  const f = path.join(homeDsh(), 'skills', 'skill-use-router', 'references', 'index.json');
  const raw = readJsonSafe(f);
  const list = raw?.entries;
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list) {
    if (!e || typeof e.name !== 'string' || !e.name.trim()) continue;
    const nm = e.name.trim();
    const desc = String(e.description || '').slice(0, 500);
    const ex = extractTriggers(desc);
    const sup = typeof e.super === 'string' && e.super ? e.super : null;
    const isDisabled = e.disabled === true;
    out.push({
      name: nm,
      type: 'skill',
      description: `${sup ? `[${sup} 子技能] ` : ''}${desc}`.slice(0, 500),
      triggers: [...new Set([nm.toLowerCase(), ...ex.triggers])].slice(0, 30),
      negative: isDisabled || ex.negative,
      disabled: isDisabled,
      source: `skill-router:${e.rel || nm}`,
      fingerprint: `${e.version || ''}:${isDisabled ? 'off' : 'on'}:${e.tier ?? ''}`,
      invoke: {
        kind: 'auto-route',
        // 权威入口指向路由器（不抢路由）；example 给直接点名式
        how: 'python ~/.dsh/skills/skill-use-router/scripts/skill_index.py query "<意图>"',
        example: `/skill ${nm}`,
      },
    });
  }
  return out;
}

// ── 探针 2：plugins（~/.dsh/plugins/*/package.json，dsh.bundle.patch 声明）──
export function probePlugins() {
  const root = path.join(homeDsh(), 'plugins');
  const entries = [];
  for (const name of listDirs(root)) {
    const pkg = readJsonSafe(path.join(root, name, 'package.json'));
    if (!pkg || !pkg.name) continue;
    const hasBundle = !!pkg.dsh?.bundle?.patch;
    if (!hasBundle) continue; // 非 DSH 宿主插件形态（纯 node_modules 等）
    entries.push({
      name: pkg.name,
      type: 'plugin',
      description: String(pkg.description || '').slice(0, 500),
      source: `plugins:${name}`,
      fingerprint: String(pkg.version || '') + ':' + mtimeIso(path.join(root, name, 'package.json')),
      invoke: { kind: 'auto-route', how: '（宿主自动加载，无需调用）', example: '' },
    });
  }
  return entries;
}

// ── 探针 3：memory 主题文件（~/.dsh/memory/README.md §1 表格 ↔ 实际文件）──
// 口径：只收 README §1 表格**登记**的主题文件（索引与文件一一对应是 check_memory 的纪律）。
export function probeMemory() {
  const root = path.join(homeDsh(), 'memory');
  const entries = [];
  const idx = path.join(root, 'README.md');
  const txt = fs.existsSync(idx) ? fs.readFileSync(idx, 'utf8') : '';
  // 表格行：| `file.md` | 覆盖 | 什么时候读 |
  const re = /\|\s*`([^`]+\.md)`\s*\|([^|]*)\|/g;
  let m;
  while ((m = re.exec(txt))) {
    const file = m[1].trim();
    if (file === 'README.md') continue;
    const cover = m[2].trim().slice(0, 300);
    const exists = fs.existsSync(path.join(root, file));
    entries.push({
      name: file,
      type: 'memory',
      description: cover,
      source: `memory:${file}`,
      fingerprint: exists ? mtimeIso(path.join(root, file)) : 'missing',
      invoke: { kind: 'manual', how: `读 ~/.dsh/memory/${file}`, example: '' },
    });
  }
  return entries;
}

// ── 探针 4：MCP 连接器（v3 实证路径：storages/mcp_connector.json）────────
// 真实结构（2026-10-05 全文取证）：
//   tables.connections.<key> = { key, name, transport: 'stdio'|'streamable-http',
//     command, args, url, serverName, enabled, updatedAt, credentialFields… }
//   tables.tool_catalog.<key>.tools = [{ name, title, description }]（最后一次成功的工具快照）
// 设计对齐 MCP 官方规范（docs/research-2026-10-05.md）：
//   - server.json 的 name/description/version/packages/remotes ↔ 本机 name/transport/command/url
//   - 官方 Registry「低频定期拉取」语义 → 工具快照 + fingerprint=updatedAt 即可感知变更，
//     协议层 tools.listChanged 通知由 DSH 连接器负责，插件层用 diff 兜底（口径一致）。
export function probeMcp() {
  const file = path.join(homeDsh(), 'storages', 'mcp_connector.json');
  const raw = readJsonSafe(file);
  const entries = [];
  const conns = raw?.tables?.connections || {};
  const catalog = raw?.tables?.tool_catalog || {};
  // 连接器市场目录（tables.catalog.remote.connectors[]）：中文 summary/tags，
  // 按 connectorId 关联到已装连接——没有它，中文查询（如「查A股行情」）命中不了英文工具快照。
  const market = {};
  const remoteConn = raw?.tables?.catalog?.remote?.connectors;
  if (Array.isArray(remoteConn)) {
    for (const c of remoteConn) {
      if (c && typeof c.id === 'string') market[c.id] = c;
    }
  }
  for (const [key, c] of Object.entries(conns)) {
    if (!c || typeof c !== 'object') continue;
    const name = String(c.name || key).trim();
    if (!name) continue;
    const mk = market[String(c.connectorId || '')] || {};
    // 触发面增强：工具快照的工具名/描述并入 triggers + description
    const tools = Array.isArray(catalog[key]?.tools) ? catalog[key].tools : [];
    const toolTriggers = tools
      .map((t) => String(t?.name || '').trim().toLowerCase())
      .filter((n) => n.length >= 3)
      .slice(0, 25);
    const toolDesc = tools
      .slice(0, 6)
      .map((t) => String(t?.name || '') + (t?.description ? `(${String(t.description).slice(0, 60)})` : ''))
      .join('; ');
    const transport = String(c.transport || '');
    const where = transport === 'stdio'
      ? `命令 ${c.command || '?'} ${(c.args || []).join(' ')}`.trim()
      : `URL ${c.url || c.servers?.[0]?.url || '?'}`;
    const desc = [
      String(mk.summary || c.description || c.summary || `MCP ${transport} 连接器（serverName: ${c.serverName || name}）`),
      toolDesc ? `工具：${toolDesc}` : '',
      tools.length ? `共 ${tools.length} 个工具` : '',
    ].filter(Boolean).join(' · ').slice(0, 500);
    // triggers 三源合并：市场目录 tags（中文）+ 描述提取 + 工具名快照
    const ex = extractTriggers(`${name} ${mk.summary || ''} ${c.description || ''} ${c.summary || ''}`);
    const mkTags = Array.isArray(mk.tags) ? mk.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean) : [];
    entries.push({
      name,
      type: 'mcp',
      description: desc,
      triggers: [...new Set([...mkTags, ...ex.triggers, ...toolTriggers])].slice(0, 30),
      source: `mcp:${key}`,
      fingerprint: String(c.updatedAt || mtimeIso(file)),
      invoke: {
        kind: 'mcp',
        how: `mcp__${c.serverName || name}__* 工具前缀（${transport || '未知传输'}：${where}）`,
        example: tools[0]?.name ? `mcp__${c.serverName || name}__${tools[0].name}` : '',
      },
      // 连接器被停用（enabled=false）≠ 缺失：登记但标记，检索时降权提示
      disabled: c.enabled === false,
    });
  }
  return entries;
}

// ── 探针 5：automation（~/.dsh/storages/dsh_automation.json definitions）─
// 表结构（harness-ops §K 实证）：tables.definitions / runs。
export function probeAutomation() {
  const file = path.join(homeDsh(), 'storages', 'dsh_automation.json');
  const raw = readJsonSafe(file);
  const defs = raw?.tables?.definitions;
  const entries = [];
  const pushDef = (id, def) => {
    if (!def || typeof def !== 'object') return;
    const name = String(def.name || id || '').trim();
    if (!name) return;
    entries.push({
      name,
      type: 'automation',
      description: String(def.prompt || '').slice(0, 500),
      source: `automation:${id || name}`,
      fingerprint: String(def.updatedAt || def.createdAt || mtimeIso(file)),
      invoke: { kind: 'auto-route', how: 'automation_list / automation_run_now', example: '' },
    });
  };
  if (Array.isArray(defs)) defs.forEach((d, i) => pushDef(d?.id || `#${i}`, d));
  else if (defs && typeof defs === 'object') Object.entries(defs).forEach(([id, d]) => pushDef(id, d));
  return entries;
}

// ── 探针 6：knowledge（Hindsight）─────────────────────────────────────
// 探的是数据目录存在性 + 记忆文件登记（存在性断言，不做内容断言）。
export function probeKnowledge() {
  const entries = [];
  const candidates = [
    { name: 'hindsight-knowledge', dir: path.join(homeDsh(), 'hindsight') },
    { name: 'hindsight-local', dir: path.join(homeDsh(), 'storages', 'hindsight') },
  ];
  for (const c of candidates) {
    if (fs.existsSync(c.dir)) {
      entries.push({
        name: c.name,
        type: 'knowledge',
        description: 'Hindsight 知识库/记忆后端（数据目录存在）',
        source: `knowledge:${c.name}`,
        fingerprint: mtimeIso(c.dir),
        invoke: { kind: 'auto-route', how: 'hindsight_search_knowledge_pages / memory_search', example: '' },
      });
      break;
    }
  }
  return entries;
}

// ── 探针 7：tools（CLI 白名单，v1 手动维护清单）────────────────────────
const TOOL_WHITELIST_DEFAULT = ['python', 'node', 'git', 'rg', 'dsh'];
export function probeTools(cfg = {}) {
  const list = Array.isArray(cfg.tools) && cfg.tools.length ? cfg.tools : TOOL_WHITELIST_DEFAULT;
  const entries = [];
  for (const t of list) {
    const ok = commandExists(t);
    if (!ok) continue;
    entries.push({
      name: t,
      type: 'tool',
      description: `本机 CLI 工具（PATH 可达）`,
      source: `tool:${t}`,
      fingerprint: 'path',
      invoke: { kind: 'cli', how: `命令行调用 \`${t}\``, example: '' },
    });
  }
  return entries;
}

function commandExists(cmd) {
  const isWin = process.platform === 'win32';
  const r = spawnSync(isWin ? 'where' : 'which', [cmd], { windowsHide: true, encoding: 'utf8' });
  return r.status === 0 && String(r.stdout || '').trim().length > 0;
}

// ── 探针 8：env（本机环境能力 · v2）────────────────────────────────────
// 三类条目：① web-intel channel-notes 通道边界表（表格行→条目）② 自进化状态（有记录=有此能力）
// ③ 本机事实探针（上面 LOCAL_FACT_PROBES 实测项）。
function probeChannelNotes() {
  const root = path.join(path.dirname(homeDsh()), '.agents', 'skills', 'web-intel', 'references', 'channel-notes.md');
  if (!fs.existsSync(root)) return [];
  const txt = fs.readFileSync(root, 'utf8');
  const entries = [];
  const seen = new Set();
  // 通道表行：| 失败特征 | 根因 | 正确通道 | 验证命令（§1 表）；也兼容 2 列坑表（§2/3：| 坑 | 规则 |）
  const lines = txt.split('\n');
  for (const line of lines) {
    if (!line.startsWith('|') || line.includes('---')) continue;
    const cells = line.split('|').map((c) => c.trim()).filter((c) => c.length > 0);
    if (cells.length < 2) continue;
    const feat = cells[0].replace(/`/g, '').slice(0, 90);
    const fix = cells[2] || cells[1];
    if (!fix || feat.length < 8) continue;
    // 特征句已在前文出现过的跳过（表格重复段头）
    const key = feat.slice(0, 24);
    if (seen.has(key)) continue;
    seen.add(key);
    const ex = extractTriggers(feat + ' ' + fix);
    entries.push({
      name: `通道：${feat}`,
      type: 'env',
      description: `${feat} → ${fix}`.slice(0, 500),
      triggers: ex.triggers,
      source: 'web-intel:channel-notes',
      fingerprint: sha256(Buffer.from(line)) + ':' + mtimeIso(root),
      invoke: { kind: 'manual', how: '查 ~/.agents/skills/web-intel/references/channel-notes.md 对应条目', example: '' },
    });
  }
  return entries;
}

function probeSelfEvolve() {
  const st = path.join(path.dirname(homeDsh()), '.agents', 'skills', 'web-intel', '.state');
  if (!fs.existsSync(st)) return [];
  const f = path.join(st, 'web-intel-evolve.jsonl');
  if (!fs.existsSync(f)) return [];
  const n = fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).length;
  return [{
    name: 'web-intel 自进化回路',
    type: 'env',
    description: `web-intel 通道自进化状态机已积累 ${n} 条踩坑记录（self_evolve.py log/report/prune），抓取通道选择可据此纠偏。`,
    triggers: ['自进化', 'self_evolve', '通道纠偏', '踩坑记录'],
    source: 'web-intel:.state',
    fingerprint: mtimeIso(f),
    invoke: { kind: 'cli', how: 'python ~/.agents/skills/web-intel/scripts/self_evolve.py report' },
  }];
}

export function probeEnv() {
  const out = [];
  for (const p of LOCAL_FACT_PROBES) {
    let ok = false;
    try { ok = !!p.test(); } catch {}
    if (ok) {
      out.push({
        name: p.name, type: 'env', description: p.description, triggers: p.triggers,
        source: `env:${p.name}`, fingerprint: 'fact', invoke: p.invoke,
      });
    }
  }
  out.push(...probeChannelNotes());
  out.push(...probeSelfEvolve());
  return out;
}

// ── 探针 9：hardware（v3 · 本机硬件）────────────────────────────────────
// 单次 PowerShell 采集 CPU/GPU/内存/磁盘/OS（WMI），解析在 JS 侧做（可测）。
// GPU 只收实体显卡：排除虚拟显示适配器（Todesk/OrayIdd/MuMu 等远程与模拟器虚拟卡——本机实测 3 台虚拟 1 实体）。
const VIRTUAL_GPU_RE = /virtual|idd|display adapter|remote|vmware|vbox|hyper-v|basic render|parsec|sunshine/i;

export function parseHardwareJson(raw) {
  const out = [];
  const push = (name, desc, triggers, invoke) => {
    if (!name || !desc) return;
    out.push({ name: String(name).slice(0, 120), description: String(desc).slice(0, 500), triggers, invoke });
  };
  if (!raw || typeof raw !== 'object') return out;
  const cs = raw.cs || {};
  const os = raw.os || {};
  const cpu = raw.cpu || {};
  const ramGb = raw.cs?.TotalPhysicalMemory ? Math.round(Number(cs.TotalPhysicalMemory) / 1073741824) : null;
  push(
    `CPU: ${cpu.Name || '未知'}`,
    `处理器 ${cpu.Name || ''}${cpu.NumberOfCores ? `，${cpu.NumberOfCores} 核 ${cpu.NumberOfLogicalProcessors || '?'} 线程` : ''}${cpu.MaxClockSpeed ? `，基频 ${(cpu.MaxClockSpeed / 1000).toFixed(1)}GHz` : ''}。`.trim(),
    ['cpu', '处理器', '核心', '算力', '编译速度'],
    { kind: 'manual', how: '物理事实条目：任务做算力/并发决策时参考（如并行子代理数、编译 -j 参数）' },
  );
  if (ramGb) {
    push(
      `RAM: ${ramGb}GB`,
      `物理内存 ${ramGb}GB${os.TotalVisibleMemorySize ? `（可用约 ${Math.round(Number(os.TotalVisibleMemorySize) / 1048576)}GB）` : ''}。大内存任务（批量 OCR/多会话并发/本地模型）参考。`,
      ['内存', 'ram', '并发容量', '本地模型'],
      { kind: 'manual', how: '物理事实条目：估算并发/批量任务容量时参考' },
    );
  }
  for (const g of Array.isArray(raw.gpus) ? raw.gpus : []) {
    const n = String(g.Name || '').trim();
    if (!n || VIRTUAL_GPU_RE.test(n)) continue;
    const vramGb = g.AdapterRAM ? Math.round(Number(g.AdapterRAM) / 1073741824) : null;
    push(
      `GPU: ${n}`,
      `显卡 ${n}${vramGb && vramGb > 0 ? `，WMI 报告显存 ${vramGb}GB（>4GB 卡 WMI 可能截断为 4GB，准确值以 dxdiag 为准）` : ''}。GPU 加速类任务（转写/推理/渲染）先核此条目再动手。`,
      ['gpu', '显卡', '显存', '加速', 'cuda', 'rocm', 'directml', '转写', '推理'],
      { kind: 'manual', how: '物理事实条目：GPU 加速任务前先查该卡官方支持矩阵（如 ROCm/DirectML）' },
    );
  }
  for (const d of Array.isArray(raw.disks) ? raw.disks : []) {
    const cap = d.Size ? Math.round(Number(d.Size) / 1073741824) : null;
    const free = d.FreeSpace ? Math.round(Number(d.FreeSpace) / 1073741824) : null;
    if (!d.DeviceID || cap == null) continue;
    push(
      `DISK: ${d.DeviceID} ${cap}GB`,
      `盘符 ${d.DeviceID} 总容量 ${cap}GB${free != null ? `，剩余 ${free}GB` : ''}。大批量落盘（会话扫描/数据集/模型下载）前参考剩余空间。`,
      ['磁盘', '硬盘', '空间', '容量', '落盘'],
      { kind: 'manual', how: '物理事实条目：大批量写盘前核对剩余空间' },
    );
  }
  if (os.Caption) {
    push(
      `OS: ${os.Caption}`,
      `操作系统 ${os.Caption}${os.Version ? `（${os.Version}）` : ''}。Windows 特有行为（注册表/ACL/路径长度/PowerShell 版本）任务前参考。`,
      ['操作系统', 'os', 'windows', '系统版本'],
      { kind: 'manual', how: '物理事实条目' },
    );
  }
  return out;
}

export function probeHardware() {
  const ps = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', `
$c = Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer,Model,TotalPhysicalMemory
$o = Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,TotalVisibleMemorySize
$p = Get-CimInstance Win32_Processor | Select-Object -First 1 Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed
$g = Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM
$d = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID,Size,FreeSpace
[pscustomobject]@{ cs=$c; os=$o; cpu=$p; gpus=@($g); disks=@($d) } | ConvertTo-Json -Depth 3`],
    { windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
  );
  if (ps.status !== 0 || !String(ps.stdout || '').trim()) {
    throw new Error(`hardware 探针失败：status=${ps.status} stderr=${String(ps.stderr || '').slice(0, 120)}`);
  }
  // 采集 → 解析 → 组装条目（复用 registry 会做的字段；scanner 产出 raw 流）
  const parsed = parseHardwareJson(JSON.parse(String(ps.stdout)));
  const home = homeDsh();
  return parsed.map((p) => ({
    name: p.name,
    type: 'hardware',
    description: p.description,
    triggers: p.triggers,
    source: 'hardware:wmi',
    // 指纹：日级（硬件不会频繁变化；日粒度 diff 足够，避免 mtime 每次都变）
    fingerprint: new Date().toISOString().slice(0, 10) + ':wmi',
    invoke: p.invoke,
  }));
}

// ── 探针 10：software（v3 · 本机软件）───────────────────────────────────
// 两个子探针：
//  a) 已安装软件（卸载注册表三视图合并）——全量条目，fingerprint 稳定（无版本变化则 diff 不动）
//  b) dev 工具链（python/node/git/uv/pnpm/gh/docker…）——带版本号，description 含精确版本
// 注意：注册表 DisplayIcon 常带 ",0" 后缀；DisplayName 为空的跳过；SystemComponent/WindowsUpdate 隐藏项过滤。
const DEV_TOOLS = [
  { cmd: 'python', ver: '--version', triggers: ['python', '脚本', '爬虫', '数据处理'] },
  { cmd: 'node', ver: '--version', triggers: ['node', 'javascript', 'npm', '前端'] },
  { cmd: 'git', ver: '--version', triggers: ['git', '版本控制', '仓库'] },
  { cmd: 'uv', ver: '--version', triggers: ['uv', 'python包管理', '虚拟环境'] },
  { cmd: 'pnpm', ver: '--version', triggers: ['pnpm', '包管理', 'monorepo'] },
  { cmd: 'gh', ver: '--version', triggers: ['github cli', 'pr', 'issue'] },
  { cmd: 'docker', ver: '--version', triggers: ['docker', '容器', '镜像'] },
  { cmd: 'ffmpeg', ver: '-version', triggers: ['ffmpeg', '视频转码', '音频转码', '压制', '转码', '音视频处理'] },
  { cmd: 'yt-dlp', ver: '--version', triggers: ['yt-dlp', '视频下载', 'youtube'] },
];

export function parseInstalledSoftware(stdout) {
  const out = [];
  for (const line of String(stdout || '').split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const name = line.slice(0, tab).trim();
    const version = line.slice(tab + 1).trim();
    if (!name || name.length < 2) continue;
    // 单字符 Displayname（如「X\t」残行）也丢弃——登记价值低且易误配
    // （v4.5.1：仅对拉丁/数字名启用 length<3 过滤——CJK 2 字名（微信/迅雷/豆包）是合法软件名，
    //   旧口径在 cp936 乱码形态下曾把它们误滤，真实修复后也不应再滤）
    if (name.length < 3 && /^[A-Za-z0-9 .+-]+$/.test(name)) continue;
    if (/^(KB\d{6}|Update for Microsoft)/i.test(name)) continue; // 系统更新噪声
    out.push({ name, version });
  }
  return out;
}

export function probeSoftware(cfg = {}) {
  const entries = [];
  const maxSoftware = Number.isFinite(cfg.maxSoftware) ? cfg.maxSoftware : 200;

  // a) dev 工具链（带版本 + 触发词，最有检索价值，先跑）
  for (const t of DEV_TOOLS) {
    const ok = commandExists(t.cmd);
    if (!ok) continue;
    const v = spawnSync(t.cmd, t.ver.split(' '), { windowsHide: true, encoding: 'utf8', timeout: 10000 });
    const verLine = String(v.stdout || v.stderr || '').split('\n')[0].trim().slice(0, 60);
    entries.push({
      name: `软件: ${t.cmd}`,
      type: 'software',
      description: `本机已安装开发工具 ${t.cmd}（版本 ${verLine || '未知'}，PATH 可达）。`,
      triggers: t.triggers,
      source: `software:devtool:${t.cmd}`,
      fingerprint: verLine || 'path',
      invoke: { kind: 'cli', how: `命令行调用 \`${t.cmd}\``, example: `${t.cmd} ${t.ver}` },
    });
  }

  // b) 已安装软件注册表（单次 PowerShell，读三视图）
  // ⚠ PS 片段里禁用反引号（JS 模板串会把 `t 当转义），分隔符用 [char]9 拼接。
  // ⚠ 编码（v4.5.1 修复）：PS 5.1 在中文系统输出 cp936 字节，spawnSync 按 utf8 解码会把
  //    注册表软件中文名打成乱码（「微信→΢」），且 2 字名被 parseInstalledSoftware 的
  //    length<3 过滤误滤。修法：PS 侧把 TSV 行按 UTF-8 编码成字节数组、Base64 输出
  //    （全 ASCII，任何控制台代码页下不损）；Node 侧 Base64→Buffer→utf8 还原真实名称。
  const ps = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', `
$paths = @(
 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
$lines = Get-ItemProperty $paths -ErrorAction SilentlyContinue |
 Where-Object { $_.DisplayName -and -not $_.SystemComponent } |
 ForEach-Object { [string]::Join([char]9, @($_.DisplayName, $_.DisplayVersion)) }
$bytes = [System.Text.Encoding]::UTF8.GetBytes(($lines -join [char]10))
[Convert]::ToBase64String($bytes)`],
    { windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
  );
  if (ps.status === 0) {
    // Base64（全 ASCII）→ 字节 → UTF-8 文本；Base64 失败时回退旧口径（按行原文解析）
    let stdout = String(ps.stdout || '');
    let text = stdout;
    const b64 = stdout.replace(/\s+/g, '');
    if (b64 && /^[A-Za-z0-9+/=]+$/.test(b64)) {
      try { text = Buffer.from(b64, 'base64').toString('utf8'); } catch { /* 回退原文 */ }
    }
    const installed = parseInstalledSoftware(text);
    // 全量落进 description 的价值低，取条目级登记（名字进 triggers 面，匹配「有没有装 X」类查询）
    for (const s of installed.slice(0, maxSoftware)) {
      entries.push({
        name: `软件: ${s.name}`,
        type: 'software',
        description: `本机已安装软件 ${s.name}${s.version ? `（版本 ${s.version}）` : ''}（来源：卸载注册表）。`,
        triggers: [s.name.toLowerCase()],
        source: `software:registry:${s.name}`,
        fingerprint: s.version || 'unknown',
        invoke: { kind: 'manual', how: '已安装软件；需要调用时查其 CLI/启动方式' },
      });
    }
  } else {
    throw new Error(`software 注册表探针失败：status=${ps.status}`);
  }
  return entries;
}

// v4.2 各类的适用范围/边界（结构化）——回答三个问题：能干什么(use)、不能干什么(limits)、前置条件(prereq)
const BOUNDS = {
  hardware: { use: '本机硬件事实（CPU/GPU/内存/磁盘），本插件是唯一权威来源', limits: '硬件不可"安装"；GPU 加速类任务须先核该卡官方支持矩阵（ROCm/DirectML 等）；WMI 对大显存卡可能截断为 4GB', prereq: '无' },
  software: { use: '本机已安装事实（PATH / 卸载注册表口径），本插件是权威来源', limits: '版本随升级变化；跨机器不可移植；"注册表有此软件"不等于其 CLI 可用', prereq: '无' },
  env: { use: '本机环境事实与抓取通道边界知识', limits: '通道边界会随时间漂移（需定期复验）；属经验事实，非规则', prereq: '无' },
  tool: { use: 'PATH 可达的 CLI 工具', limits: '仅证明"命令可达"，不证明版本/权限满足具体任务', prereq: '装好并在 PATH 中' },
  plugin: { use: 'DSH 宿主插件（自动加载）', limits: '装/改后必须重启 DSH 才生效（启动时刻判定，不热生效）；`file:` 安装是快照，改代码须 remove+add', prereq: '已装入本 profile' },
  skill: { use: '技能快速索引底稿（含子技能/层级/禁用态）', limits: '**权威入口是 skill-use-router**（打分/学习重排）；本条目为底稿，实时性弱于路由器', prereq: '技能目录已扫描；索引可能滞后于新增技能' },
  memory: { use: 'memory/ 主题文件登记（文件粒度索引底稿）', limits: '**条目级检索权威是 dsh-mneme memory_search**；本插件看不到文件内部条目', prereq: '已在 README §1 登记' },
  mcp: { use: 'MCP 连接与工具快照（索引底稿）', limits: '**实时状态/工具清单权威是宿主 mcp_connector_status**；快照可能滞后，服务端健康与否不在此反映', prereq: '连接器已配置' },
  automation: { use: '定时任务名称/调度索引底稿', limits: '**增删改查权威是 automation_list**；本插件不感知运行结果', prereq: '任务已创建' },
  knowledge: { use: '知识库后端存在性', limits: '**知识页检索权威是 Hindsight**；本插件不做内容断言', prereq: 'Hindsight 数据目录存在' },
};

// ── 汇总扫描 ────────────────────────────────────────────────────────────
// v4.2 权威归口后处理：给「已有对应系统」的类型打上 authority 标记，并把 invoke 指向权威入口
// （用户裁决：不重复造轮子——本插件是快速索引底稿 + 兜底，不抢已有系统的活）。
function applyAuthority(entries) {
  return entries.map((e) => {
    const a = AUTHORITY[e.type];
    const b = BOUNDS[e.type];
    const withMeta = { ...e, ...(b && !e.bounds ? { bounds: b } : {}) };
    if (!a) {
      // 「我能力强，我上」：DSH 无等价系统的领域，本插件即主权威
      const p = PRIMARY_DOMAINS[e.type];
      if (!p) return withMeta;
      return {
        ...withMeta,
        authority: {
          system: '本插件（dsh-capability-aware）',
          strength: 'primary',
          how: `node cap.mjs query "<意图>"（或 list ${e.type}）`,
          note: p,
          onFailure: '—（本插件即该领域的兜底来源）',
        },
      };
    }
    return {
      ...withMeta,
      authority: a,
      invoke: { kind: 'delegate', how: a.how, example: e.invoke?.example || '' },
    };
  });
}

/**
 * 全量扫描。
 * @param {{tools?: string[], probes?: string[]}} opts
 * @returns {{ entries: object[], probeErrors: {probe:string,error:string}[], scannedAt: string, dshHome: string }}
 */
export function scanAll(opts = {}) {
  const dshHome = homeDsh();
  const entries = [];
  const probeErrors = [];

  // v4.1：先吸收 skill-use-router 索引（权威技能源，358 条含子技能/层级/禁用态），
  // 其覆盖的技能名交给目录扫描去重——避免同一条技能出现两遍（applyScan 不去重 scanned）。
  let routerEntries = [];
  try {
    routerEntries = probeSkillRouter();
    entries.push(...routerEntries);
  } catch (err) {
    probeErrors.push({ probe: 'skillRouter', error: String(err && err.message ? err.message : err) });
  }
  const routerNames = new Set(routerEntries.map((e) => e.name));

  const probes = {
    skills: () => probeSkills({ skip: routerNames }),
    plugins: () => probePlugins(),
    memory: () => probeMemory(),
    mcp: () => probeMcp(),
    automation: () => probeAutomation(),
    knowledge: () => probeKnowledge(),
    tools: () => probeTools(opts),
    env: () => probeEnv(),
    hardware: () => probeHardware(),
    software: () => probeSoftware(opts),
  };
  const wanted = Array.isArray(opts.probes) && opts.probes.length ? opts.probes : Object.keys(probes);
  for (const key of wanted) {
    if (!probes[key]) continue;
    try {
      const out = probes[key]();
      for (const e of out) entries.push(e);
    } catch (err) {
      probeErrors.push({ probe: key, error: String(err && err.message ? err.message : err) });
    }
  }
  return { entries: applyAuthority(entries), probeErrors, scannedAt: new Date().toISOString(), dshHome };
}
