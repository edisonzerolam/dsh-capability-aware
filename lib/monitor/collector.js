/**
 * 采集器（M2 收口）—— **单个心跳**，三层融合 + 检出 + 落盘。
 *
 * ## 性能自保（六条，全部有实测依据）
 *
 * 1. **只允许一个 `setInterval`**。多定时器会让采集开销不可预测，且在卡顿时
 *    互相叠加。所有层合并进同一次 tick。
 * 2. **空闲退避**：无活跃会话且无 pending 工作时，心跳从 `intervalMs` 退到
 *    `idleMs`。依据是实测「DSH 空闲时 Host 仍占 200%+ CPU」——空闲期继续
 *    高频采样纯属浪费。
 * 3. **不阻塞 agent loop**：本模块跑在 Host 进程，但 `sampleAll` 的两次
 *    FFI 差分之间有 `await`，且**每个 tick 串行执行**（上一 tick 未结束就跳过
 *    下一次），不会堆积。
 * 4. **环形有界**：样本落盘由 `lib/monitor/store.js` 保证上限（默认 20000 条）。
 * 5. **序列化上限**：只落盘**摘要行**，不落全量进程树（`_raw` 剥掉）。
 * 6. **自证开销**：每 tick 用 `process.hrtime.bigint()` 量自己的耗时，
 *    写进样本的 `selfMs`；`selfcheck()` 报最近窗口的均值，供验收 A2.6 断言
 *    「自身 CPU < 0.5%」。
 *
 * ## 与 agent loop 的关系
 *
 * 采集器**不订阅任何会话事件**（那会与账本的订阅重复），只在 tick 里主动
 * 读 `ctx.sessions.list()` + 投影快照。故它不会因为 agent 事件风暴而放大。
 *
 * @module dsh-efficiency/lib/monitor/collector
 */
import { appendEvents, appendSamples, monitorDir, readSamples } from './store.js';
import { createDetector } from './detect.js';
import { readPlugins } from './plugins.js';
import { readSessions } from './sessions.js';
import { sampleAll } from './procs.js';

export const DEFAULTS = {
  enabled: true,
  intervalMs: 3000,        // 活跃时的心跳
  idleMs: 10000,           // 空闲退避
  sampleIntervalMs: 500,   // FFI 差分窗口
  maxSamples: 20000,
  keepRaw: false,          // 是否把 _raw 计数器落盘（默认否：体积 + 无查询价值）
  detect: {},              // 透传给 createDetector
  dir: undefined,          // 覆盖监控目录（测试用）
};

export function createCollector(ctx, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const dir = cfg.dir ?? monitorDir();
  const detector = createDetector(cfg.detect);

  let timer = null;
  let running = false;         // 当前 tick 是否在执行
  let stopped = false;
  const stats = {
    startedAt: Date.now(),
    ticks: 0, skipped: 0, errors: 0,
    samplesWritten: 0, eventsDetected: 0, eventsWritten: 0,
    selfMsTotal: 0, selfMsMax: 0,
    lastTickAt: null, lastError: null,
    idleSkips: 0, backoff: false,
  };
  const selfWindow = [];       // 最近 20 次自测耗时

  function isIdle(sessions) {
    // 「活跃」= 至少一个会话在本周期有增量，或存在 pending 的 step。
    const rows = sessions?.sessions ?? [];
    if (!rows.length) return true;
    return !rows.some((r) => (r.dLlmMs ?? 0) > 0 || (r.dToolMs ?? 0) > 0 || (r.dSteps ?? 0) > 0 || (r.steps ?? 0) > 0);
  }

  /** 一次 tick：三层采集 → 检出 → 落盘。**串行、可跳过、绝不抛**。 */
  async function tick() {
    if (stopped) return null;
    if (running) { stats.skipped += 1; return null; }   // 上一 tick 未完成 → 跳过（不堆积）
    running = true;
    const t0 = process.hrtime.bigint();
    const cu0 = process.cpuUsage();
    const now = Date.now();
    try {
      const procs = await sampleAll({ intervalMs: cfg.sampleIntervalMs });
      const sessions = readSessions(ctx);
      const plugins = readPlugins(ctx);

      const idle = isIdle(sessions);
      stats.backoff = idle;
      if (idle) stats.idleSkips += 1;

      const events = detector.run({ procs, sessions, plugins, now });

      const summary = {
        v: 1, time: now, idle,
        source: procs.source,
        wallMs: procs.wallMs,
        totalWorkingSetMB: procs.totalWorkingSetMB ?? null,
        cores: procs.cores ?? null,
        // 只落摘要：热点前 8 个进程（按 CPU 降序），全量树不落盘
        hotProcs: (procs.rows ?? [])
          .filter((r) => r.pid !== process.pid)
          .sort((a, b) => (b.cpuPct ?? -1) - (a.cpuPct ?? -1))
          .slice(0, 8)
          .map((r) => ({
            pid: r.pid, kind: r.kind, cpuPct: r.cpuPct,
            wsMB: r.workingSetMB, readMB: r.readMB, writeMB: r.writeMB,
          })),
        sessions: (sessions.sessions ?? []).slice(0, 12).map((s) => ({
          id: s.id, title: s.title, dLlmMs: s.dLlmMs, dToolMs: s.dToolMs,
          dSteps: s.dSteps, llmMs: s.llmMs, toolMs: s.toolMs, steps: s.steps,
        })),
        plugins: plugins.counts ?? null,
        events: events.map((e) => ({ code: e.code, severity: e.severity, subject: e.subject })),
      };
      // 自证开销必须量**CPU 时间**，不是墙钟时间。
      //
      // ⚠ 实测踩过的坑：第一版用 `hrtime` 差值（墙钟）当自耗，结果每 tick 报
      //   400–870 ms，`SELF_COST_HIGH` 恒亮。根因是 `sampleAll()` 内部**故意**
      //   `await` 400ms 做两次 FFI 差分——那是「等」，不是「算」。墙钟里
      //   99% 是等待，拿它当自耗等于把心跳间隔算成 CPU 占用。
      //   `process.cpuUsage()` 返回进程真实消耗的用户+系统 CPU 微秒，才是
      //   自证开销的正确口径（A2.6 判据「自身 CPU < 0.5%」也是这个口径）。
      const cpuUs = process.cpuUsage(cu0);
      const selfMs = (cpuUs.user + cpuUs.system) / 1000;
      const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
      summary.selfMs = Math.round(selfMs * 100) / 100;
      summary.selfWallMs = Math.round(wallMs);

      const w = await appendSamples([summary], { dir, max: cfg.maxSamples });
      if (w.error) { stats.errors += 1; stats.lastError = w.error; }
      else stats.samplesWritten += w.appended;

      if (events.length) {
        stats.eventsDetected += events.length;
        const ew = await appendEvents(events, { dir });
        if (!ew.error) stats.eventsWritten += ew.appended;
      }

      stats.ticks += 1;
      stats.selfMsTotal += selfMs;
      if (selfMs > stats.selfMsMax) stats.selfMsMax = selfMs;
      selfWindow.push(selfMs);
      while (selfWindow.length > 20) selfWindow.shift();
      stats.lastTickAt = now;
      return summary;
    } catch (e) {
      stats.errors += 1;
      stats.lastError = String(e?.message ?? e);
      return null;
    } finally {
      running = false;
    }
  }

  /** 按当前退避状态重排下一次心跳（每次 tick 后调用，实现动态退避）。 */
  function reschedule() {
    if (stopped) return;
    const delay = stats.backoff ? cfg.idleMs : cfg.intervalMs;
    timer = setTimeout(async () => {
      await tick();
      reschedule();
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();   // 不阻止进程退出
  }

  function start() {
    if (stopped || timer) return { started: false, reason: 'already-running' };
    reschedule();
    return { started: true, intervalMs: cfg.intervalMs, idleMs: cfg.idleMs, dir };
  }

  function stop() {
    stopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
    return { stopped: true };
  }

  function statsOf() {
    const avg = selfWindow.length ? selfWindow.reduce((a, b) => a + b, 0) / selfWindow.length : 0;
    return {
      ...stats,
      uptimeMs: Date.now() - stats.startedAt,
      selfMsAvg: Math.round(avg * 100) / 100,
      // 采集器自身占用率（相对墙钟）：avg ms / 心跳间隔。用于 A2.6 验收。
      selfCpuPctApprox: Math.round(avg / (stats.backoff ? cfg.idleMs : cfg.intervalMs) * 100 * 1000) / 1000,
    };
  }

  async function selfcheck() {
    const r = await readSamples({ dir, limit: 20 });
    const rows = r.rows.filter((x) => typeof x.selfMs === 'number');
    const avg = rows.length ? rows.reduce((a, b) => a + b.selfMs, 0) / rows.length : 0;
    const max = rows.length ? Math.max(...rows.map((x) => x.selfMs)) : 0;
    return {
      samples: rows.length, selfMsAvg: Math.round(avg * 100) / 100,
      selfMsMax: Math.round(max * 100) / 100,
      thresholdMs: cfg.intervalMs * 0.005,   // 0.5% of the heartbeat
      ok: rows.length === 0 ? null : avg < cfg.intervalMs * 0.005,
      note: rows.length === 0 ? '尚无样本（先跑一个心跳）' : undefined,
    };
  }

  return { cfg, dir, start, stop, tick, stats: statsOf, selfcheck, detector, reset: () => detector.reset() };
}
