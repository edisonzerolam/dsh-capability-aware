// dsh-efficiency · lib/interfaces.js
// 接口面索引（v0.9.0 目标 1）——「本机有哪些接口可供其他插件复用」。
//
// 为什么需要它：原有清单只回答「本机有什么能力」（技能/插件/MCP/定时…），
// 但**插件作者**要复用宿主时，需要的是另一类东西：Cordis 服务、Typert Remote、
// 客户端 UI 插槽、工具 JSON schema、插件自注册的 HTTP 路由。这些在旧清单里完全缺失。
//
// 数据源策略（**静态 + 运行期双源**，见 dsh-efficiency-plan.md §4 审核意见 2）：
//   - 静态源：不依赖 ctx，CLI 也能跑。从宿主 node_modules 里读
//       · 各包 lib/typert.host.js 的 TYPERT.invocations（Remote 方法，含参数/结果类型）
//       · dsh-base / dsh-web-app 的 cordis.patch.yml row（id + name = 服务/插件名）
//       · dsh-client-ui-slots 与已装插件 client bundle 里的插槽 id
//   - 运行期源：有 ctx 时用 ctx.get(name) 探测已知服务名，补 available 真值。
//
// ⚠ 不假装枚举 Cordis 服务注册表：Cordis 的 registry 未取证为公开可枚举 API，
//   所以 service 类目来自「静态已知名单 + 运行期探测」，**而不是**声称「全部服务」。
//   每条条目的 iface.origin 明写来源（'static' | 'runtime'），available 只在运行期有真值。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/**
 * 宿主 app 的 node_modules 根（用于静态扫描）；找不到返回 null。
 *
 * 三级兜底（实测：从**源码目录**跑 CLI 时 `require.resolve` 全部失败——
 * 源码树不在 profile 的 node_modules 链上，必须靠显式路径兜底）：
 *   1. `DSH_HOST_NODE_MODULES` 环境变量（测试/异常布局用）
 *   2. `require.resolve`（插件**装进 profile 后**的常规路径）
 *   3. 已知的 DSH Desktop 安装目录（CLI 从源码跑时的兜底）
 */
export function hostNodeModules() {
  const explicit = process.env.DSH_HOST_NODE_MODULES;
  if (explicit && fs.existsSync(explicit)) return explicit;

  const probes = [
    '@deepseek-ai/dsh-session/package.json',
    '@deepseek-ai/dsh-tools/package.json',
    '@deepseek-ai/cordis/package.json',
  ];
  for (const p of probes) {
    try {
      const resolved = require.resolve(p);
      // <root>/node_modules/@deepseek-ai/<pkg>/package.json
      const nm = resolved.slice(0, resolved.lastIndexOf(`${path.sep}node_modules${path.sep}`) + `${path.sep}node_modules`.length);
      if (fs.existsSync(nm)) return nm;
    } catch { /* 继续试下一个 */ }
  }

  // 3. 已知安装路径兜底（Windows 为主，其余平台按常见位置试）
  const guesses = [
    'D:\\Program Files\\DSH_Desktop\\DSH Desktop\\resources\\app\\node_modules',
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'DSH Desktop', 'resources', 'app', 'node_modules'),
    '/Applications/DSH Desktop.app/Contents/Resources/app/node_modules',
    '/opt/DSH Desktop/resources/app/node_modules',
  ];
  for (const g of guesses) {
    if (fs.existsSync(path.join(g, '@deepseek-ai'))) return g;
  }
  return null;
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function shortHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

// ── 静态源 1：Typert Remote（各包 lib/typert.host.js 的 TYPERT.invocations） ──
/**
 * 从宿主包目录扫出所有 typert.host.js，解析其 TYPERT 常量。
 * 这些文件是纯数据模块（`const TYPERT = {...}; export { TYPERT }`），
 * 用正则提取比 import 更稳（不需要满足其依赖）。
 */
export function scanTypertRemotes(nm) {
  const out = [];
  if (!nm) return out;
  const scopeDir = path.join(nm, '@deepseek-ai');
  let pkgs = [];
  try { pkgs = fs.readdirSync(scopeDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
  catch { return out; }
  for (const pkg of pkgs) {
    const file = path.join(scopeDir, pkg, 'lib', 'typert.host.js');
    if (!fs.existsSync(file)) continue;
    const src = readText(file);
    // 抓 invocations 数组里的每个 { id:'...', service:'...', namespace:'...', method:'...' }
    const inv = src.match(/invocations\s*:\s*\[([\s\S]*?)\]\s*\}/);
    if (!inv) continue;
    const blocks = inv[1].split(/\},\s*\{/);
    for (const b of blocks) {
      const id = (b.match(/id\s*:\s*['"]([^'"]+)['"]/) || [])[1];
      const service = (b.match(/service\s*:\s*['"]([^'"]+)['"]/) || [])[1];
      const namespace = (b.match(/namespace\s*:\s*['"]([^'"]+)['"]/) || [])[1];
      const method = (b.match(/method\s*:\s*['"]([^'"]+)['"]/) || [])[1];
      if (!id || !service || !method) continue;
      // 参数名（parameters 数组里的 name 字段）
      const params = [...b.matchAll(/name\s*:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
      out.push({
        pkg: `@deepseek-ai/${pkg}`,
        id,
        service,
        namespace: namespace || service,
        method,
        params,
        file: path.relative(nm, file).replace(/\\/g, '/'),
      });
    }
  }
  return out;
}

// ── 静态源 2：bundle row（cordis.patch.yml 的 `- id:` / `name:`） ──
/** 从宿主 bundle 的 cordis.patch.yml 提取已登记的 row（id + name = 插件/服务名）。 */
export function scanBundleRows(nm) {
  const out = [];
  if (!nm) return out;
  const scopeDir = path.join(nm, '@deepseek-ai');
  const candidates = ['dsh-base', 'dsh-web-app'];
  for (const pkg of candidates) {
    const file = path.join(scopeDir, pkg, 'cordis.patch.yml');
    if (!fs.existsSync(file)) continue;
    const src = readText(file);
    const re = /-\s*id:\s*([\w.@/-]+)\s*\n\s*name:\s*['"]?([^'"\n]+)['"]?/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      out.push({ bundle: pkg, id: m[1].trim(), name: m[2].trim(), file: path.relative(nm, file).replace(/\\/g, '/') });
    }
  }
  return out;
}

// ── 静态源 3：客户端 UI 插槽 ──
/**
 * 插槽 id 没有集中登记表（已取证：dsh-client-ui-slots 里无字面量清单），
 * 只能从**消费者**（已装插件的 client bundle）里反推。
 *
 * ⚠ 19 个插槽若共用同一组 triggers，检索会退化成**任意并列**（实测：查
 *   「客户端浮窗插槽」时 `command.palette.item` 与 `shell.overlay` 同分，
 *   排序靠运气）。所以关键插槽必须带**语义专属触发词**。
 */
export const SLOT_HINTS = {
  'shell.overlay': ['浮窗', '悬浮窗', '全局浮层', '跨面板浮窗', '置顶浮窗', 'overlay', '资源管理器浮窗'],
  'shell.header': ['顶栏', '全局头部'],
  'shell.footer': ['底栏', '全局底部', '状态栏'],
  'sidebar.panellist': ['侧边栏面板', '左侧面板列表'],
  'sidebar.footer.action': ['侧边栏底部按钮', '侧边栏操作'],
  'sidebar.settings': ['侧边栏设置入口'],
  'sidebar.workspaces': ['工作区列表', '侧边栏工作区'],
  'sidebar.guideDescription': ['引导描述', '侧边栏引导'],
  'sidebar.entry': ['侧边栏条目'],
  'conversation.view': ['会话视图', '对话主视图', '聊天主区域'],
  'conversation.input.dock': ['输入框下方', '输入区停靠', '输入框工具条'],
  'conversation.input.left': ['输入框左侧按钮'],
  'conversation.input.right': ['输入框右侧按钮'],
  'conversation.session.header.actions': ['会话头部按钮', '会话标题栏操作'],
  'settings.section': ['设置页分区', '设置面板'],
  'settings.sidebarEntry': ['设置侧边栏条目'],
  'settings.versionSection': ['版本信息区'],
  'settings.plugin.item': ['插件设置项', '插件配置条目'],
  'command.palette.item': ['命令面板条目', '命令面板'],
};

/** 插槽名 → 触发词（含 id 本身 + 语义提示）。 */
export function slotTriggers(id) {
  const base = ['插槽', 'slot', 'ui', '界面', '扩展点', id.toLowerCase()];
  return [...new Set([...base, ...(SLOT_HINTS[id] ?? [])])];
}

export function scanSlots(pluginDirs = []) {
  const found = new Map();
  for (const id of Object.keys(SLOT_HINTS)) found.set(id, new Set());
  for (const dir of pluginDirs) {
    const c = path.join(dir, 'lib', 'client.js');
    if (!fs.existsSync(c)) continue;
    const src = readText(c);
    for (const m of src.matchAll(/["'`]([a-z][a-z0-9]*(?:\.[a-z0-9]+){1,3})["'`]/g)) {
      const id = m[1];
      if (!found.has(id)) continue;
      found.get(id).add(path.basename(dir));
    }
  }
  return [...found.entries()].map(([id, users]) => ({ id, usedBy: [...users] }));
}

// ── 运行期源：服务探测 ──
/** 已知的宿主 Cordis 服务名（从宿主源码实证；用于 ctx.get 探测，不声称完整）。 */
export const KNOWN_SERVICES = [
  { name: 'systemPrompt', note: '系统提示词段注册（ctx.systemPrompt.section）', how: "ctx.systemPrompt.section({ name, order, text })", extra: ['系统提示词', '注入提示词', '提示词段', '常驻指令', 'prompt section'] },
  { name: 'tools', note: '工具注册表（ctx.tools.register / defineTool）', how: "ctx.tools.register(defineTool(spec))", extra: ['注册工具', '定义工具', '新增工具', '工具 schema', 'defineTool'] },
  { name: 'webServer', note: 'HTTP 路由注册（ctx.webServer.register）', how: "ctx.webServer.register({ kind: 'exact', path, handler })", extra: ['注册路由', 'http 接口', '暴露 api', 'web 服务'] },
  { name: 'loader', note: 'Cordis 插件树（ctx.loader.entries()）', how: "ctx.loader.entries()", extra: ['插件树', '插件清单', '遍历插件', '加载器'] },
  { name: 'sessions', note: '会话仓储（ctx.sessions.list / get / create）', how: "ctx.sessions.list()", extra: ['会话列表', '读取会话', '会话仓储'] },
  { name: 'sessionProjections', note: '会话投影（snapshot / onChanged / stateOf）', how: "ctx.sessionProjections.snapshot(session)", extra: ['投影', '会话指标', '实时统计', '订阅变更'] },
  { name: 'pluginInventory', note: '插件清单 Remote（TypertRemoteService）', how: "ctx.pluginInventory.list()", extra: ['插件清单远程', '插件状态查询'] },
  { name: 'sessionTelemetry', note: '会话遥测后端（默认未启用）', how: "ctx.sessionTelemetry.emit(record)", extra: ['遥测', 'telemetry', '上报'] },
  { name: 'skills', note: '技能目录（list / get / notifyChange）', how: "ctx.skills.list()", extra: ['技能目录服务', '读技能'] },
  { name: 'agentPresets', note: 'agent 预设名单', how: "ctx.agentPresets", extra: ['agent 预设', '预设名单'] },
  { name: 'jobs', note: '后台任务', how: "ctx.jobs", extra: ['后台任务', '长任务'] },
  { name: 'shortcuts', note: '快捷键注册', how: "ctx.shortcuts.register(...)", extra: ['注册快捷键', '键盘快捷键'] },
  { name: 'configForms', note: '配置表单持久化', how: "ctx.configForms", extra: ['配置持久化', '插件设置存储'] },
];

/**
 * 扫描接口面。
 * @param {{ctx?: object, nm?: string|null, pluginDirs?: string[]}} opts
 * @returns {{services: object[], remotes: object[], slots: object[], routes: object[], sources: object}}
 */
export function scanInterfaces(opts = {}) {
  const ctx = opts.ctx;
  const nm = opts.nm === undefined ? hostNodeModules() : opts.nm;
  const pluginDirs = opts.pluginDirs || [];

  // 服务：静态名单 + 运行期 available
  const services = KNOWN_SERVICES.map((s) => {
    let available = null; // null = 未知（无 ctx）
    if (ctx && typeof ctx.get === 'function') {
      try { const v = ctx.get(s.name); available = v !== undefined && v !== null; } catch { available = false; }
    }
    return { ...s, available, origin: available === null ? 'static' : 'runtime' };
  });

  const remotes = scanTypertRemotes(nm).map((r) => ({ ...r, origin: 'static' }));
  const rows = scanBundleRows(nm);
  const slots = scanSlots(pluginDirs).map((s) => ({ ...s, origin: 'static' }));

  return {
    services,
    remotes,
    slots,
    rows,
    sources: { hostNodeModules: nm, pluginDirs: pluginDirs.length, rows: rows.length },
  };
}

/**
 * 把接口面结果转成能力条目（type='interface'），供清单/检索消费。
 * 每条都带 invoke.how —— 要求是**能直接粘贴跑通**的最小片段（验收 A1.4）。
 */
export function interfacesToEntries(scan) {
  const entries = [];

  for (const s of scan.services) {
    entries.push({
      name: s.name,
      type: 'interface',
      description: `${s.note}${s.available === false ? '（当前 ctx 中不可用）' : ''}`,
      triggers: ['服务', 'service', 'ctx', '接口', s.name.toLowerCase(), ...(s.extra || [])],
      invoke: { kind: 'service', how: s.how, example: s.how },
      iface: { kind: 'service', available: s.available, origin: s.origin, note: s.note },
      source: 'interface:service',
      fingerprint: shortHash(`service|${s.name}|${s.how}`),
    });
  }

  for (const r of scan.remotes) {
    const how = `// Typert Remote：${r.id}\n// 宿主侧服务 ${r.service}，方法 ${r.method}${r.params.length ? `，参数 ${r.params.join(', ')}` : ''}`;
    entries.push({
      name: `${r.service}/${r.method}`,
      type: 'interface',
      description: `Typert Remote 方法（来自 ${r.pkg}）`,
      triggers: ['remote', 'typert', '接口', '远程', r.service.toLowerCase(), r.method.toLowerCase()],
      invoke: { kind: 'remote', how, example: r.id },
      iface: { kind: 'remote', pkg: r.pkg, service: r.service, method: r.method, params: r.params, origin: r.origin },
      source: 'interface:remote',
      fingerprint: shortHash(`remote|${r.id}`),
    });
  }

  for (const s of scan.slots) {
    const users = s.usedBy.length ? `（已被 ${s.usedBy.slice(0, 5).join(', ')} 使用）` : '';
    entries.push({
      name: s.id,
      type: 'interface',
      description: `客户端 UI 插槽${users}${(SLOT_HINTS[s.id] || []).length ? `｜用于：${(SLOT_HINTS[s.id] || []).slice(0, 3).join('/')}` : ''}`,
      triggers: slotTriggers(s.id),
      invoke: {
        kind: 'slot',
        how: `// 客户端半边注册到插槽：\n// window.__ModuleLoader__.load({ id, factory })\n//   → 在 factory 内 ctx.slots.get('${s.id}').register(component)`,
        example: s.id,
      },
      iface: { kind: 'slot', usedBy: s.usedBy, origin: s.origin },
      source: 'interface:slot',
      fingerprint: shortHash(`slot|${s.id}`),
    });
  }

  // 路由：宿主已注册的 HTTP 前缀（只登记已知的，不假装枚举）
  const routes = [
    { prefix: '/api/efficiency', note: '本插件（能力清单 + 错误账本 + 监控）' },
    { prefix: '/api/desktop', note: '宿主桌面控制（restart / reload / settings）' },
  ];
  for (const r of routes) {
    entries.push({
      name: r.prefix,
      type: 'interface',
      description: `HTTP 路由前缀：${r.note}`,
      triggers: ['路由', 'route', 'http', 'api', '接口', r.prefix.toLowerCase()],
      invoke: { kind: 'route', how: `GET http://127.0.0.1:<port>${r.prefix}/<endpoint>`, example: r.prefix },
      iface: { kind: 'route', origin: 'static' },
      source: 'interface:route',
      fingerprint: shortHash(`route|${r.prefix}`),
    });
  }

  return entries;
}

/** 便捷入口：一次拿到条目。 */
export function probeInterfaces(opts = {}) {
  return interfacesToEntries(scanInterfaces(opts));
}
