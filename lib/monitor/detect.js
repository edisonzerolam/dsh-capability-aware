/**
 * 异常检出（M3）—— 从样本序列里识别**值得人看**的模式。
 *
 * ## 设计纪律：宁可漏报，不可误报
 *
 * 每条规则都必须满足「**确定的事实 + 可复述的证据**」才发事件。理由：
 * 误报会训练用户忽略告警，比没有告警更糟。故：
 *
 *   - 阈值类规则要求**连续 N 次**满足（默认 3），单次尖峰不算。
 *   - 每条事件带 `evidence`，说明「凭什么这么说」（对齐 dshmarket 诊断的
 *     `evidence.basis` 范式 —— 不假装看到了没看到的东西）。
 *   - 无法确定时**不发**，而不是发一条「可能有问题」。
 *
 * ## 六条规则
 *
 * | code | 判据 | 确定性 |
 * |---|---|---|
 * | `PLUGIN_FAILED` | `fiberPhase === 'failed'` | 确定（宿主自己报的） |
 * | `PROCESS_GONE` | 曾连续稳定存在 ≥ `goneMinTicks` 周期的 PID 消失 | 推断（退出码不可读，不判定崩溃） |
 * | `HOT_PROCESS` | CPU% ≥ 阈值 连续 N 次 | 测量值 |
 * | `MEMORY_GROWTH` | WorkingSet 单调增且斜率超阈值 | 测量值 |
 * | `IO_STORM` | 单周期读写增量超阈值 | 测量值 |
 * | `SESSION_STALL` | 事件仍在流（asOfSeq 推进）但 llmMs/toolMs 零增长 | 推断（最弱，故阈值保守） |
 *
 * ## 两条规则为什么在 2026-10-11 被收紧
 *
 * 实测 2.67 小时产出 1631 条事件，其中 `PROCESS_GONE` 803 条（49.2%）、
 * `SESSION_STALL` 744 条（45.6%）—— **九成四是噪声**，且都是「恒亮的假告警」：
 * · `PROCESS_GONE` 把 Windows 上短命工具子进程的正常退出当异常，平均每 12 秒报一条；
 * · `SESSION_STALL` 把**已结束/空闲**会话当成停摆，9 个会话各被反复报约 70 次。
 * 按本项目纪律（宁可漏报不可误报），训练人忽略告警比没有告警更糟，故两者都收紧：
 * 前者加「曾经稳定存在」门限并降为 P2，后者只认「事件在流但时间零增长」。
 *
 * ## 去重与抑制
 *
 * 同一 `code + subject` 在 `COOLDOWN_MS` 内只发一次，避免持续热点刷屏
 * （一个卡死的进程会在每个心跳都满足 HOT_PROCESS）。
 *
 * @module dsh-efficiency/lib/monitor/detect
 */

export const DEFAULTS = {
  hotCpuPct: 80,          // 单进程 CPU% 阈值
  hotStreak: 3,           // 连续多少次才算热
  memGrowthMbPerMin: 60,  // 内存增长斜率阈值（MB/分钟）
  memStreak: 4,
  ioStormMbPerTick: 512,  // 单周期（一个心跳）读写增量阈值
  stallTicks: 5,          // 有 open step 但 N 个周期无时间增量
  cooldownMs: 120000,     // 同 code+subject 的抑制窗口
  goneMinTicks: 3,        // 进程须连续出现 ≥ N 个采样周期，其消失才值得报
};

/** 每条规则一条人类可读解释（写进事件的 evidence.reason）。 */
const REASONS = {
  PLUGIN_FAILED: '宿主 loader 报告该 entry 的 Fiber 阶段为 failed —— 这是确定事实，不是推断',
  PROCESS_GONE: '曾连续多个采样周期稳定存在、随后消失的进程 —— 进程已不在，退出码无从读取，故**不判定为崩溃**（推断）',
  HOT_PROCESS: '连续多个采样周期 CPU 占用超过阈值 —— 这是 koffi 直读 GetProcessTimes 的测量值',
  MEMORY_GROWTH: 'WorkingSet 持续单调增长且斜率超过阈值 —— 疑似泄漏',
  IO_STORM: '单周期内读写字节增量超过阈值 —— 疑似在疯狂读写磁盘',
  SESSION_STALL: '该会话仍在产生事件（asOfSeq 在推进），但 llmMs/toolMs 连续多周期零增长 —— 推断，非测量',
};

export function createDetector(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const streaks = new Map();   // key → 连续命中次数
  const lastEmit = new Map();  // code|subject → ts
  const baselinePids = new Set();
  const pidTicks = new Map();  // pid → 连续出现的采样周期数（判「曾经稳定存在」）
  const memHist = new Map();   // pid → [{t, mb}]
  const stallHist = new Map(); // sessionId → {ticks, lastLlm, lastTool}
  const ioPrev = new Map();    // pid → 上周期累计 IO（MB）

  function allow(code, subject, now) {
    const k = `${code}|${subject}`;
    const prev = lastEmit.get(k);
    if (prev !== undefined && now - prev < cfg.cooldownMs) return false;
    lastEmit.set(k, now);
    return true;
  }

  function streak(key, ok) {
    if (!ok) { streaks.set(key, 0); return 0; }
    const n = (streaks.get(key) ?? 0) + 1;
    streaks.set(key, n);
    return n;
  }

  /**
   * 跑一轮检出。
   *
   * @param {{procs?, sessions?, plugins?, now?}} sample 本周期三层采集结果
   * @returns {Array} 事件数组（可能为空）
   */
  function run(sample) {
    const now = sample?.now ?? Date.now();
    const events = [];
    const push = (e) => {
      if (!allow(e.code, e.subject, now)) return;
      events.push({ v: 1, time: now, reason: REASONS[e.code] ?? null, ...e });
    };

    // ── 1. 插件装载失败（确定事实，最高优先） ─────────────────────────
    for (const p of sample?.plugins?.plugins ?? []) {
      if (p.fiberPhase === 'failed') {
        push({
          code: 'PLUGIN_FAILED', severity: 'P0', subject: p.entryId ?? p.moduleName,
          evidence: { basis: 'loader-fiber-phase', fiberPhase: 'failed', moduleName: p.moduleName },
        });
      }
    }

    // ── 2. 进程消失（相对基线，且须「曾经稳定存在」） ───────────────────
    // 判据收紧（2026-10-11 实测后）：原实现把「上轮在、本轮不在」直接报 P1，
    // 结果 2.67 小时报了 803 条（占全部事件的 49.2%，平均每 12 秒一条）——
    // Windows 上短命进程（工具子进程、CIM 查询、一次性 node 调用）本来就每分钟
    // 换一批，它们的正常退出不是「异常」。注释一直写着「只报曾经稳定存在的」，
    // 代码却没实现；现在补上：只有连续出现 ≥ goneMinTicks 个采样周期的 PID
    // 消失才报。
    const seenPids = new Set();
    for (const r of sample?.procs?.rows ?? []) {
      seenPids.add(r.pid);
      pidTicks.set(r.pid, (pidTicks.get(r.pid) ?? 0) + 1);
      baselinePids.add(r.pid);
    }
    if (sample?.procs?.source === 'ffi') {
      for (const pid of [...baselinePids]) {
        if (seenPids.has(pid)) continue;
        baselinePids.delete(pid);
        const seen = pidTicks.get(pid) ?? 0;
        pidTicks.delete(pid);
        if (seen < cfg.goneMinTicks) continue;  // 短命进程：正常退出，不报
        // 降为 P2：进程已不在，**退出码无从读取**，无法判定是崩溃还是正常退出。
        // 按本项目「分档看确定性、不看严重程度」的纪律，不能把「无法判定」写成 P1。
        push({
          code: 'PROCESS_GONE', severity: 'P2', subject: `pid:${pid}`,
          evidence: {
            basis: 'stable-pid-disappeared', pid, seenTicks: seen,
            note: '曾连续存在多个采样周期后消失；无退出码可读，故不判定为崩溃',
          },
        });
      }
    }

    // ── 3. 热进程（连续 N 次） ────────────────────────────────────────
    for (const r of sample?.procs?.rows ?? []) {
      if (r.pid === process.pid) continue; // 自己不算热点（另由自检报告）
      const hot = typeof r.cpuPct === 'number' && r.cpuPct >= cfg.hotCpuPct;
      const n = streak(`hot|${r.pid}`, hot);
      // ⚠ 必须用 `>=` 而不是 `===`：streak 只增不减，用 `===` 会让这条规则
      // 在进程生命周期内**只报一次**（第 N 次刚好等于阈值，第 N+1 次就错过），
      // 抑制窗口形同虚设。阈值只负责「够不够格报」，重复上报交给 `allow()` 的冷却窗。
      if (hot && n >= cfg.hotStreak) {
        push({
          code: 'HOT_PROCESS', severity: 'P1', subject: `pid:${r.pid}`,
          evidence: { basis: 'win32-getprocesstimes', cpuPct: r.cpuPct, streak: n, kind: r.kind, name: r.name },
        });
      }
    }

    // ── 4. 内存增长（斜率） ──────────────────────────────────────────
    for (const r of sample?.procs?.rows ?? []) {
      if (typeof r.workingSetMB !== 'number') continue;
      const h = memHist.get(r.pid) ?? [];
      h.push({ t: now, mb: r.workingSetMB });
      while (h.length > 12) h.shift();
      memHist.set(r.pid, h);
      // `memStreak` 在这里是**趋势所需的最少样本数**，不是「连续命中次数」：
      // 趋势本身只有攒够 N 个点才能算，再叠一层 streak 计数等于把门槛翻倍
      // （要 N 个点满足 + 连续 N 次评估都满足），实测会让这条规则几乎永不触发。
      // 故判据就是「样本够 + 单调 + 斜率达标」，重复上报交给 `allow()` 冷却。
      if (h.length >= cfg.memStreak) {
        const first = h[0], last = h[h.length - 1];
        const dtMin = (last.t - first.t) / 60000;
        const mono = h.every((x, i) => i === 0 || x.mb >= h[i - 1].mb);
        const slope = dtMin > 0 ? (last.mb - first.mb) / dtMin : 0;
        if (mono && slope >= cfg.memGrowthMbPerMin) {
          push({
            code: 'MEMORY_GROWTH', severity: 'P1', subject: `pid:${r.pid}`,
            evidence: { basis: 'win32-working-set-trend', slopeMbPerMin: Math.round(slope * 10) / 10, fromMB: first.mb, toMB: last.mb, samples: h.length },
          });
        }
      }
    }

    // ── 5. IO 风暴 ───────────────────────────────────────────────────
    // 与 CPU 不同，IO 计数是**累计量**，没有「连续 N 次」的概念——
    // 判据只能是「相邻两期的增量」。故这里用独立的 ioPrev 表存上次累计值，
    // 不复用 streaks（那是「连续命中次数」语义，混用会读出垃圾）。
    for (const r of sample?.procs?.rows ?? []) {
      const io = (r.readMB ?? 0) + (r.writeMB ?? 0);
      const prevIo = ioPrev.get(r.pid);
      ioPrev.set(r.pid, io);
      if (prevIo === undefined) continue;             // 首次见到该 pid，没有基线
      const delta = io - prevIo;
      if (delta < 0) continue;                        // pid 被复用或计数回绕
      if (delta >= cfg.ioStormMbPerTick) {
        push({
          code: 'IO_STORM', severity: 'P2', subject: `pid:${r.pid}`,
          evidence: { basis: 'win32-io-counters-delta', deltaMB: Math.round(delta * 10) / 10, readMB: r.readMB, writeMB: r.writeMB },
        });
      }
    }

    // ── 6. 会话停摆（推断，最弱） ────────────────────────────────────
    // 判据收紧（2026-10-11 实测后）：原实现只要求「steps>0 且本周期无增量」，
    // 结果把 9 个**已结束/空闲**会话各反复报了约 70 次（2.67 小时共 744 条，
    // 占全部事件的 45.6%）—— 那些会话本就不再产生事件，llmMs/toolMs 当然不增长。
    //
    // 关键限制（源码级事实，勿当作可绕过的实现细节）：`readSessions` 给出的行
    // （lib/monitor/sessions.js 的行投影）**没有「已结束/活跃」标志**，只有
    // `asOfSeq / turns / steps / llmMs / toolMs` 等计数。已结束的会话与停摆的会话
    // 在投影里都是「asOfSeq 冻结 + 时间不增」，**无法区分**。
    // 故本规则只认一种可观测的异常：**会话仍在产生事件（asOfSeq 在推进），
    // 但 LLM/工具时间连续多周期零增长**。已结束/空闲会话不产生事件 ⇒ 天然跳过。
    for (const s of sample?.sessions?.sessions ?? []) {
      const key = s.id;
      const h = stallHist.get(key) ?? { ticks: 0, lastSeq: null, lastLlm: null, lastTool: null };
      const seqMoved = h.lastSeq !== null && s.asOfSeq !== null && s.asOfSeq !== h.lastSeq;
      const noProgress = s.dLlmMs === 0 && s.dToolMs === 0 && s.dSteps === 0;
      h.ticks = noProgress && seqMoved ? h.ticks + 1 : 0;
      h.lastSeq = s.asOfSeq ?? null;
      h.lastLlm = s.llmMs; h.lastTool = s.toolMs;
      stallHist.set(key, h);
      // 同 HOT_PROCESS：`>=` 配合冷却窗，`===` 会让长停摆只报一次。
      if (h.ticks >= cfg.stallTicks) {
        push({
          code: 'SESSION_STALL', severity: 'P2', subject: `session:${key}`,
          evidence: {
            basis: 'events-flow-but-no-llm-tool-time', ticks: h.ticks,
            asOfSeq: s.asOfSeq, llmMs: s.llmMs, toolMs: s.toolMs, steps: s.steps, title: s.title,
          },
        });
      }
    }

    return events;
  }

  return { run, cfg, reset() { streaks.clear(); lastEmit.clear(); memHist.clear(); stallHist.clear(); ioPrev.clear(); baselinePids.clear(); pidTicks.clear(); } };
}

export { REASONS };
