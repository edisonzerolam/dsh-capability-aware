// dsh-capability-aware · index.js（host 半 v4）
//
// 权威写法对照（均为本机在跑的真实插件）：
//   · dsh-our-free-model/index.js:L881 —— 软注入挂 HTTP 面：
//       ctx.inject(['webServer'], scoped => {
//         const server = scoped.webServer
//         scoped.effect(() => server.register({ kind:'exact', path, handler }), 'label')
//       })
//   · dsh-usage-stats —— ctx.effect(() => ctx.webServer.register(...)) 形态
// ⚠ 两个实测坑（都写进了本文件注释，别再踩）：
//   1) 用 export const inject = ['webServer'] **硬声明** → 无 webServer 的 profile 里
//      apply() 整体 pending，boot 扫描也不跑（实测报 "pending (waiting for service: webServer)"）。
//      RPC 是加分面，核心（扫描/监听）必须无条件运行 → 一律用 ctx.inject 软注入。
//   2) 裸 register 不挂 ctx.effect → 热重载 duplicate route → 打掉整棵插件树（memory pitfalls）。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scanAll } from './scanner.js';
import { load, applyScan, dataFile } from './registry.js';
import { match } from './matcher.js';
import { guide, guideStale } from './guidance.js';
import { doctor } from './doctor.js';
import { buildCapabilityTool } from './tool.js';
import { provisionSkill, provisionAgentsPointer } from './provision.js';
import { fileURLToPath } from 'node:url';

const name = 'capability-aware';
const BASE = '/api/capability-aware';
const PLUGIN_VERSION = '0.5.1';
// 插件根目录（lib/ 的上一级）——自供给技能文本里要写可执行路径
const __pluginDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// 反应式扫描用轻量探针集：排除 hardware/software（PowerShell 采集 10-20s，
// 且它们是「环境」事实，不随 DSH 装/删技能插件而变）→ 变更响应做到秒级。
const LIGHT_PROBES = ['skills', 'plugins', 'memory', 'mcp', 'automation', 'knowledge', 'tools', 'env'];
const FULL_ONLY_PROBES = ['hardware', 'software'];

function homeDshDir() {
  return process.env.DSH_CAP_DSH_HOME || path.join(os.homedir(), '.dsh');
}

function jsonOut(res, code, body) {
  try {
    const s = JSON.stringify(body, null, 2);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(s);
  } catch {
    try { res.end(); } catch {}
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e6) { try { req.destroy(); } catch {} } });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function urlQuery(req) {
  try { return Object.fromEntries(new URL(req.url, 'http://127.0.0.1').searchParams); } catch { return {}; }
}

function apply(ctx, config) {
  const cfg = {
    scanOnBoot: config?.scanOnBoot !== false,    scanDelayMs: Number.isFinite(config?.scanDelayMs) ? config.scanDelayMs : 3000,
    watch: config?.watch !== false,
    debounceMs: Number.isFinite(config?.debounceMs) ? config.debounceMs : 5000,
    minIntervalMs: Number.isFinite(config?.minIntervalMs) ? config.minIntervalMs : 30000,
    periodicMs: Number.isFinite(config?.periodicMs) ? config.periodicMs : 20 * 60 * 1000,
    tools: Array.isArray(config?.tools) ? config.tools : undefined,
    provisionSkill: config?.provisionSkill !== false,
    provisionAgentsPointer: config?.provisionAgentsPointer === true,
  };
  const file = dataFile();
  const logger = (() => { try { return ctx?.logger || null; } catch { return null; } })();
  const log = (msg) => { try { logger?.info?.(`[${name}] ${msg}`); } catch {} };
  const warn = (msg) => { try { logger?.warn?.(`[${name}] ${msg}`); } catch {} };

  let debounceTimer = null;
  let lastScanAt = 0;

  function doScan(reason = 'manual', opts = {}) {
    const light = opts.light === true;
    const scan = light
      ? scanAll({ probes: LIGHT_PROBES, tools: cfg.tools })
      : scanAll({ tools: cfg.tools });
    // ⚠ 轻扫必须保留未覆盖类型的既有条目：hardware/software 是慢探针（PowerShell），
    //   不参与轻扫，若按「以本次产出为准重建」会把它们整批抹掉（实测 total 125 → 10）。
    const res = applyScan(file, scan, {
      reason,
      preserveTypes: light ? FULL_ONLY_PROBES : [],
    });
    lastScanAt = Date.now();
    const out = {
      reason, light,
      state: res.state,
      counts: res.meta?.counts || {},
      probeErrors: res.meta?.lastScanProbeErrors || [],
      diff: {
        added: res.diff.added.map((e) => `${e.type}:${e.name}`),
        removed: res.diff.removed.map((e) => `${e.type}:${e.name}`),
        changed: res.diff.changed.map((c) => `${c.to.type}:${c.to.name}`),
      },
      file: res.file,
      scannedAt: scan.scannedAt,
    };
    if (out.diff.added.length || out.diff.removed.length || out.diff.changed.length) {
      log(`scan(${reason}) 变更：+${out.diff.added.length} -${out.diff.removed.length} ~${out.diff.changed.length}`);
      if (out.diff.removed.length) log(`  消失：${out.diff.removed.join(', ')}`);
    }
    return out;
  }

  // 防抖调度：合并密集文件事件 → 一次轻量重扫。
  // minIntervalMs 限频到点前**顺延补扫**，不丢弃变更（实测：窗口内删除技能被静默吞掉）。
  function schedule(reason, delay) {
    try { if (debounceTimer) clearTimeout(debounceTimer); } catch {}
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      const since = Date.now() - lastScanAt;
      if (since < cfg.minIntervalMs) {
        schedule(reason, cfg.minIntervalMs - since + 50); // 顺延到限流窗口结束
        return;
      }
      try { doScan(reason, { light: true }); } catch (e) { warn(`反应式扫描失败：${e?.message}`); }
    }, delay);
  }

  // ⓪ v4.5 自供给（安装即得，无需用户手工配置）：
  //   ① 技能入口 capability-lookup —— 默认开启：幂等写入 <dshHome>/skills/capability-lookup/SKILL.md
  //      （带版本戳），使任何安装者的会话技能目录都出现该能力 → 可移植的发现性。
  //   ② AGENTS.md 指针 —— **默认关闭**（provisionAgentsPointer），未经许可不改用户规则文件。
  try {
    if (cfg.provisionSkill !== false) {
      const r = provisionSkill({ version: PLUGIN_VERSION, pluginDir: __pluginDir, dshHome: homeDshDir() });
      if (r.action !== 'unchanged') log(`自供给技能：${r.action} → ${r.path}`);
    }
    if (cfg.provisionAgentsPointer === true) {
      const r = provisionAgentsPointer({ version: PLUGIN_VERSION, pluginDir: __pluginDir, dshHome: homeDshDir() });
      if (r.action !== 'unchanged') log(`自供给 AGENTS 指针：${r.action} → ${r.path}`);
    }
  } catch (e) {
    warn(`自供给失败（不影响其余功能）：${e?.message}`);
  }

  // ① 启动全量扫描
  if (cfg.scanOnBoot) {
    const t = setTimeout(() => {
      try { doScan('boot'); } catch (e) { warn(`boot 扫描失败：${e?.message}`); }
    }, cfg.scanDelayMs);
    ctx.effect(() => () => clearTimeout(t), `${name}: boot scan`);
  }

  // ② 反应式：能力根目录变更 → 自动更新清单（装/删/改 技能·插件·记忆·连接器·自动化）
  if (cfg.watch) {
    ctx.effect(() => {
      const watchers = [];
      const home = homeDshDir();
      const roots = [
        { p: path.join(home, 'skills'), recursive: true, what: 'skill' },
        { p: path.join(path.dirname(home), '.agents', 'skills'), recursive: true, what: 'skill(.agents)' },
        { p: path.join(home, 'plugins'), recursive: false, what: 'plugin' },
        { p: path.join(home, 'memory'), recursive: false, what: 'memory' },
        { p: path.join(home, 'storages'), recursive: false, what: 'mcp/automation' },
      ];
      for (const r of roots) {
        if (!fs.existsSync(r.p)) continue;
        try {
          const w = fs.watch(r.p, { recursive: r.recursive, persistent: false }, (_ev, fname) => {
            const f = fname ? String(fname) : '';
            if (f && /\.(tmp|log|lock|swp)$/i.test(f)) return;          // 噪声过滤
            if (/\.bak|~$|\.tmp-/i.test(f)) return;
            schedule(`${r.what} 变更${f ? `（${f}）` : ''}`, cfg.debounceMs);
          });
          watchers.push(w);
        } catch (e) {
          warn(`watch 失败（${r.p}）：${e?.message}`);
        }
      }
      log(`反应式监听已挂 ${watchers.length} 个根（防抖 ${cfg.debounceMs}ms）`);
      return () => { for (const w of watchers) { try { w.close(); } catch {} } };
    }, `${name}: capability watchers`);
  }

  // ③ 周期兜底全量扫描（覆盖 fs.watch 漏事件 + 硬件/软件等环境变化）
  if (cfg.periodicMs > 0) {
    ctx.effect(() => {
      const iv = setInterval(() => {
        if (Date.now() - lastScanAt < cfg.minIntervalMs) return;
        try { doScan('periodic'); } catch (e) { warn(`周期扫描失败：${e?.message}`); }
      }, cfg.periodicMs);
      return () => clearInterval(iv);
    }, `${name}: periodic scan`);
  }

  // ④ HTTP/RPC 面：**软注入**（对照 dsh-our-free-model/index.js:L881 的权威写法）
  // ⚠ 不要用 export const inject = ['webServer'] 硬声明——那会让无 webServer 的 profile
  //   （headless/tui/最小 profile）里 apply() 整体 pending，连 boot 扫描都不跑
  //   （本机实测：`dsh-capability-aware: pending (waiting for service: webServer)`）。
  //   RPC 是加分面，核心（扫描/监听/CLI）不得被它绑架 → 用 ctx.inject 软挂载。
  try {
    ctx.inject(['webServer'], (scoped) => {
      const server = scoped.webServer;
      const handlers = {
        [`${BASE}/list`]: async (req, res) => {
          const reg = load(file);
          jsonOut(res, 200, { state: reg.state, meta: reg.meta, count: reg.entries.length, entries: reg.entries });
        },
        [`${BASE}/query`]: async (req, res, body) => {
          const q = String(body?.query ?? urlQuery(req).query ?? '');
          const reg = load(file);
          if (reg.state !== 'ok') {
            return jsonOut(res, 200, { kind: 'empty_registry', message: '能力清单为空或未初始化：先执行 scan（RPC /scan、CLI cap.mjs scan，或重启 DSH 触发 boot 扫描）。' });
          }
          const m = match(q, reg.entries, { topK: body?.topK, minScore: body?.minScore });
          if (m.kind === 'no_match') return jsonOut(res, 200, { ...m, guidance: guide({ query: q }) });
          jsonOut(res, 200, m);
        },
        [`${BASE}/scan`]: async (req, res) => jsonOut(res, 200, doScan('rpc')),
        [`${BASE}/guide`]: async (req, res, body) => jsonOut(res, 200, guide(body || {})),
        [`${BASE}/doctor`]: async (req, res) => jsonOut(res, 200, doctor(file, {})),
      };
      for (const [p, h] of Object.entries(handlers)) {
        scoped.effect(() => server.register({
          kind: 'exact',
          path: p,
          handler: (req, res) => {
            (async () => {
              try {
                const body = await readBody(req);
                await h(req, res, body);
              } catch (e) {
                jsonOut(res, 500, { ok: false, error: String(e?.message || e) });
              }
            })();
          },
        }), `${name}: route ${p}`);
      }
      log(`RPC 面已挂载 ${Object.keys(handlers).length} 条：${BASE}/*`);
    });
  } catch (e) {
    warn(`webServer 软注入失败：${e?.message}（CLI 通路不受影响）`);
  }

  // ⑤ Agent 工具面：注册 capability_query —— 这是「DSH 跑任务时知不知道本插件存在」的**唯一通道**。
  // 实证：v4 之前本插件无任何暴露面（无 tool、无 SKILL.md、不在技能目录）→ agent 工具清单里看不到它，
  // 自然也不会去用。注册成工具后它随每轮工具清单注入，agent 才有「先查能力再动手」的入口。
  // ⚠ 只注册 1 个工具（dsh-super-injector 脚手架提示工具面 ≥5 个会触发首轮裁剪）。
  // ⚠ 不把 @deepseek-ai/dsh-tools 写进 peerDependencies：DSH 的 peer 兼容门禁不匹配会**静默禁用整包**
  //   （本机 web_search-local 前车之鉴）；改用运行时动态 import + 失败降级（CLI/RPC 通路不受影响）。
  try {
    ctx.inject(['tools'], (scoped) => {
      import('@deepseek-ai/dsh-tools')
        .then(({ defineTool }) => {
          const spec = buildCapabilityTool({ file });
          scoped.effect(() => scoped.tools.register(defineTool(spec)), `${name}: ${spec.name} tool`);
          log(`Agent 工具已注册：${spec.name}`);
        })
        .catch((e) => warn(`capability_query 工具注册失败（@deepseek-ai/dsh-tools 不可用）：${e?.message}`));
    });
  } catch (e) {
    warn(`tools 软注入失败：${e?.message}（CLI/RPC 通路不受影响）`);
  }
}

export { apply, name };
