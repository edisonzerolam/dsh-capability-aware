/**
 * 资源监控 host 半 —— 由 `lib/index.js` 调用 `mountMonitor(ctx, cfg, opts)`。
 *
 * ## 为什么与账本同插件、但独立子模块
 *
 * 账本（`lib/ledger/`）回答「**什么坏了**」，监控（`lib/monitor/`）回答
 * 「**现在跑得怎么样**」。两者数据源、生命周期、落盘目录都不同（账本是
 * 事件驱动的 append-only 明细；监控是定时心跳的有界环形样本），故各自成组。
 * 但对外是**同一个插件、同一份品牌、同一套 RPC 前缀**——用户不需要知道
 * 内部有两个子系统。
 *
 * ## 不自己 apply
 *
 * 与 `lib/ledger/index.js` 同款约束：本模块**不导出 `apply`**（两个 apply 会
 * 在宿主里争 RPC 路由与 effect 名）。由主插件显式调用 `mountMonitor(...)`。
 *
 * ## RPC 前缀
 *
 * `/api/efficiency/monitor/*`（stats / procs / sessions / plugins /
 * events / selfcheck / tick）。
 *
 * @module dsh-efficiency/lib/monitor
 */
import { createCollector, DEFAULTS as COLLECTOR_DEFAULTS } from './collector.js';
import { monitorDir, monitorPaths, readEvents, readMeta, readSamples, sampleFileSize } from './store.js';
import { rankPluginCandidates, readPlugins } from './plugins.js';
import { readSessions } from './sessions.js';
import { sampleAll } from './procs.js';

const MONITOR_NAME = 'efficiency/monitor';
const MONITOR_BASE = '/api/efficiency/monitor';

function jsonOut(res, code, body) {
  try {
    const s = JSON.stringify(body);
    res.statusCode = code;
    res.setHeader?.('content-type', 'application/json; charset=utf-8');
    res.end(s);
  } catch { /* 响应已结束 */ }
}

function urlQuery(req) {
  try { return Object.fromEntries(new URL(req.url, 'http://x').searchParams.entries()); } catch { return {}; }
}

/**
 * 挂载资源监控。
 *
 * @param {object} ctx 宿主 Context
 * @param {object} config 监控配置（见 collector DEFAULTS）
 * @param {{version?:string, log?:Function, warn?:Function}} opts
 */
function mountMonitor(ctx, config = {}, opts = {}) {
  const hostLog = (m) => { try { opts.log?.(`[monitor] ${m}`); } catch { /* 忽略 */ } };
  const warn = (m) => { try { opts.warn?.(`[monitor] ${m}`); } catch { /* 忽略 */ } };
  const version = opts.version ?? '?';

  const cfg = {
    ...COLLECTOR_DEFAULTS,
    ...(config && typeof config === 'object' ? config : {}),
  };
  delete cfg.dir;
  const dir = (config && typeof config === 'object' && config.dir) || monitorDir();
  const P = monitorPaths(dir);

  const collector = createCollector(ctx, { ...cfg, dir });
  let started = false;

  // ── ① 启动心跳 ────────────────────────────────────────────────
  if (cfg.enabled !== false) {
    try {
      const r = collector.start();
      started = r.started === true;
      if (started) hostLog(`心跳已启动：活跃 ${cfg.intervalMs}ms / 空闲退避 ${cfg.idleMs}ms，样本落 ${dir}`);
      else hostLog(`心跳未启动：${r.reason}`);
    } catch (e) {
      warn(`心跳启动失败：${e?.message}`);
    }
    // 卸载时停心跳（避免宿主退出后仍留定时器）
    try {
      ctx.effect(() => () => collector.stop(), `${MONITOR_NAME}: heartbeat`);
    } catch { /* ctx.effect 不可用时忽略 */ }
  }

  // ── ② RPC 面（软注入，核心不被它绑架） ────────────────────────
  try {
    ctx.inject(['webServer'], (scoped) => {
      const server = scoped.webServer;
      const handlers = {
        [`${MONITOR_BASE}/stats`]: async (req, res) => {
          const s = collector.stats();
          jsonOut(res, 200, {
            version, dir, started,
            ...s,
            samplesFileBytes: await sampleFileSize(dir),
            meta: await readMeta(dir),
          });
        },
        [`${MONITOR_BASE}/procs`]: async (req, res) => {
          const q = urlQuery(req);
          // ── 缓存路径（D4）───────────────────────────────────────────
          // 默认复用采集器最近一次心跳的采样，**不再自己重采一遍全机**。
          // 依据：设置页每 5 秒轮询一次本路由，而这里原本每次 `await sampleAll()`
          // 重新采样，实测一轮完整刷新烧 1313ms Host CPU（单核 162.9%）⇒ 常驻
          // 单核 26.3%；而采集器本已每 3 秒采一次全机，等于把同一份数据算两遍。
          // 需要「此刻」而非「刚才」时用 `?fresh=1` 强制现采。
          const wantFresh = q.fresh === '1' || q.fresh === 'true';
          const cached = collector.lastSample?.() ?? null;
          const useCached = !wantFresh && cached?.procs != null;
          const s = useCached
            ? cached.procs
            : await sampleAll({ intervalMs: Number(q.intervalMs) || cfg.sampleIntervalMs });
          const rows = [...(s.rows ?? [])].sort((a, b) => (b.cpuPct ?? -1) - (a.cpuPct ?? -1));
          const cores = s.cores ?? null;
          jsonOut(res, 200, {
            source: s.source, cores: s.cores, wallMs: s.wallMs,
            totalWorkingSetMB: s.totalWorkingSetMB, note: s.note,
            cached: useCached,
            sampleAgeMs: useCached ? Math.max(0, Date.now() - cached.at) : 0,
            procs: rows.map(({ _raw, ...r }) => r),
            // 诚实标签：本层是测量值，但**进程 ≠ 插件**
            disclaimer: '进程层为 koffi 直读 Win32 的测量值；但一个进程内跑多个插件，无法据此归因到单个插件。',
            // CPU 口径必须写出来 —— 实测有人把 209% 当成异常，其实数是对的、只是没标口径
            cpuBasis: `cpuPct 口径：100% = 占满 1 个逻辑核（本机共 ${cores ?? '?'} 个）⇒ 整机满载为 ${cores != null ? cores * 100 : '?'}%。`,
          });
        },
        [`${MONITOR_BASE}/sessions`]: async (req, res) => {
          const q = urlQuery(req);
          const s = readSessions(ctx, { limit: Number(q.limit) || 50 });
          jsonOut(res, 200, {
            source: s.source, note: s.note,
            sessions: [...s.sessions].sort((a, b) => ((b.dLlmMs ?? 0) + (b.dToolMs ?? 0)) - ((a.dLlmMs ?? 0) + (a.dToolMs ?? 0))),
            disclaimer: '增量为「本插件上次读取至今」的差值，非宿主官方计费口径。',
          });
        },
        [`${MONITOR_BASE}/plugins`]: async (req, res) => {
          const p = readPlugins(ctx);
          jsonOut(res, 200, {
            source: p.source, note: p.note, counts: p.counts,
            plugins: rankPluginCandidates(p.plugins ?? []),
            disclaimer: '相关性排序，非 CPU 归因 —— DSH 不提供插件级资源计量 API。',
          });
        },
        [`${MONITOR_BASE}/events`]: async (req, res) => {
          const q = urlQuery(req);
          jsonOut(res, 200, await readEvents({ dir, limit: Number(q.limit) || 200 }));
        },
        [`${MONITOR_BASE}/samples`]: async (req, res) => {
          const q = urlQuery(req);
          jsonOut(res, 200, await readSamples({ dir, limit: Number(q.limit) || 200 }));
        },
        [`${MONITOR_BASE}/selfcheck`]: async (req, res) => jsonOut(res, 200, {
          ...(await collector.selfcheck()),
          collector: collector.stats(),
        }),
        [`${MONITOR_BASE}/tick`]: async (req, res) => jsonOut(res, 200, { ok: true, sample: await collector.tick() }),
        [`${MONITOR_BASE}/health`]: async (req, res) => jsonOut(res, 200, health()),
      };
      for (const [p, h] of Object.entries(handlers)) {
        scoped.effect(() => server.register({
          kind: 'exact',
          path: p,
          handler: (req, res) => {
            (async () => {
              try { await h(req, res); }
              catch (e) { jsonOut(res, 500, { ok: false, error: String(e?.message || e) }); }
            })();
          },
        }), `${MONITOR_NAME}: route ${p}`);
      }
      hostLog(`RPC 面已挂载 ${Object.keys(handlers).length} 条：${MONITOR_BASE}/*`);
    });
  } catch (e) {
    warn(`webServer 软注入失败：${e?.message}（CLI 通路不受影响）`);
  }

  // ── 健康自检 ──────────────────────────────────────────────────
  function health() {
    const s = collector.stats();
    const findings = [];
    if (s.errors > 0) findings.push({ level: 'warn', code: 'COLLECT_ERRORS', message: `${s.errors} 次采集失败，最近：${s.lastError}` });
    if (s.startedAt && s.ticks === 0 && Date.now() - s.startedAt > 30000) findings.push({ level: 'warn', code: 'NO_TICKS', message: '心跳已启动但 30 秒内无成功采样' });
    if (s.ticks > 0 && s.samplesWritten === 0) findings.push({ level: 'warn', code: 'NO_SAMPLES_WRITTEN', message: '有采样但无落盘（磁盘权限？）' });
    if (s.selfMsAvg > cfg.intervalMs * 0.05) findings.push({ level: 'warn', code: 'SELF_COST_HIGH', message: `采集自耗 ${s.selfMsAvg}ms 超过心跳的 5%` });
    if (s.backoff) findings.push({ level: 'info', code: 'IDLE_BACKOFF', message: `当前空闲退避中（${cfg.idleMs}ms）` });
    return {
      healthy: findings.every((f) => f.level !== 'warn'),
      version, dir, started,
      procsSource: null,
      stats: s,
      findings,
    };
  }

  return {
    dir, P, cfg, collector, started,
    stats: () => collector.stats(),
    health,
    tick: () => collector.tick(),
    selfcheck: () => collector.selfcheck(),
    readSamples: (n) => readSamples({ dir, limit: n ?? 200 }),
    readEvents: (n) => readEvents({ dir, limit: n ?? 200 }),
    readMeta: () => readMeta(dir),
    reset: () => collector.reset(),
  };
}

export { mountMonitor, MONITOR_BASE, MONITOR_NAME };
