/**
 * 进程层采集（L1′）—— koffi FFI 直调 kernel32，拿**真实** CPU / 内存 / IO。
 *
 * ## 为什么不是 Electron `app.getAppMetrics()`
 *
 * 已实测确认**不可达**：`resources\app\lib\electron-runtime-*.js` 的 renderer action
 * 白名单只有 7 个（terminal/developer/diagnostics/check-for-updates/restart/
 * restart-recovery/reload），`preload.cjs` 只暴露 5 个桥，全 `lib\*.js` grep
 * `getAppMetrics|ProcessMetric|percentCPUUsage` **零命中**。插件跑在 Host
 * （Node 子进程，`node.mojom.NodeService`），不持有 Electron `app`。
 *
 * ## 为什么 koffi 可行（M0 实测，推翻原规划的悲观结论）
 *
 * `@deepseek-ai/dsh-win32-process` 导出了 **开放扩展点**：
 *
 * ```js
 * extendWin32ProcessBindings(create)  // create({kernel32, advapi32, bind}) => callerBindings
 * ```
 *
 * `bind(lib, name, result, args)` = `lib.func("__stdcall", name, result, args)`，
 * 因此第三方插件可以绑**任意** kernel32 API。M0 实测绑定成功：
 * `GetProcessTimes` / `K32GetProcessMemoryInfo` / `GetProcessIoCounters` /
 * `QueryFullProcessImageNameW`。
 *
 * 原规划把「Electron JS API 不可达」误推成「进程层数据不可达」——这是两件事。
 *
 * ## 非 Windows / FFI 失败时的降级
 *
 * `source: 'self-only'`，只报 Host 自己（`process.getCPUUsage()`），
 * 并在每条记录上标明来源，**不假装拿到了全机数据**。
 *
 * @module dsh-efficiency/lib/monitor/procs
 */
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hostNodeModules } from '../interfaces.js';

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const to100 = (f) => (BigInt(f.dwHighDateTime) << 32n) | BigInt(f.dwLowDateTime);

let cachedApi;      // { api, koffi, FILETIME, PMC, IO } | null
let cachedTried = false;

/**
 * 懒加载 koffi + 绑定表。**失败返回 null**（调用方降级），不抛。
 *
 * 坑：koffi 的 `struct()` 是**全局注册**，同名重复注册会抛。故整体只做一次并缓存。
 * 坑：`OpenProcess` 返回的是 **bigint**（koffi 指针），判空必须
 * `h === null || h === 0n`，用 `!h` 在 0n 时虽然也对，但对 null 语义不明确。
 */
async function loadApi() {
  if (cachedTried) return cachedApi;
  cachedTried = true;
  if (process.platform !== 'win32') return (cachedApi = null);
  try {
    const require = createRequire(import.meta.url);

    // 解析宿主包目录。**实测坑**：从源码目录跑 CLI 时 `require.resolve` 会失败
    // （源码树不在 profile 的 node_modules 链上），故复用 interfaces.js 的三级兜底。
    const nm = hostNodeModules();
    const pkgDir = nm
      ? join(nm, '@deepseek-ai', 'dsh-win32-process')
      : (() => { try { return require.resolve('@deepseek-ai/dsh-win32-process/package.json').replace(/package\.json$/, ''); } catch { return null; } })();
    if (!pkgDir) return (cachedApi = null);

    // koffi 可能挂在 app 的 node_modules 根，也可能嵌在 dsh-win32-process 自己的
    // node_modules 下（pnpm 布局）——两处都试。
    const koffiCandidates = [
      nm && join(nm, 'koffi'),
      join(pkgDir, 'node_modules', 'koffi'),
      (() => { try { return require.resolve('koffi').replace(/[\\/]index\.js$/, ''); } catch { return null; } })(),
    ].filter(Boolean);
    const koffiDir = koffiCandidates.find((d) => { try { return require.resolve(join(d, 'index.js')); } catch { return false; } })
      ?? koffiCandidates[0];
    if (!koffiDir) return (cachedApi = null);

    const mod = await import(pathToFileURL(join(pkgDir, 'lib', 'index.js')).href);
    const koffi = require(join(koffiDir, 'index.js'));
    if (typeof mod?.extendWin32ProcessBindings !== 'function') return (cachedApi = null);

    const api = mod.extendWin32ProcessBindings(({ kernel32, bind }) => ({
      openProcess: bind(kernel32, 'OpenProcess', 'void *', ['uint32', 'int', 'uint32']),
      getProcessTimes: bind(kernel32, 'GetProcessTimes', 'int', ['void *', 'void *', 'void *', 'void *', 'void *']),
      k32GetProcessMemoryInfo: bind(kernel32, 'K32GetProcessMemoryInfo', 'int', ['void *', 'void *', 'uint32']),
      getProcessIoCounters: bind(kernel32, 'GetProcessIoCounters', 'int', ['void *', 'void *']),
    }));
    const FILETIME = koffi.struct('FILETIME', { dwLowDateTime: 'uint32', dwHighDateTime: 'uint32' });
    const PMC = koffi.struct('PROCESS_MEMORY_COUNTERS', {
      cb: 'uint32', PageFaultCount: 'uint32',
      PeakWorkingSetSize: 'size_t', WorkingSetSize: 'size_t',
      QuotaPeakPagedPoolUsage: 'size_t', QuotaPagedPoolUsage: 'size_t',
      QuotaPeakNonPagedPoolUsage: 'size_t', QuotaNonPagedPoolUsage: 'size_t',
      PagefileUsage: 'size_t', PeakPagefileUsage: 'size_t',
    });
    const IO = koffi.struct('IO_COUNTERS', {
      ReadOperationCount: 'uint64', WriteOperationCount: 'uint64', OtherOperationCount: 'uint64',
      ReadTransferCount: 'uint64', WriteTransferCount: 'uint64', OtherTransferCount: 'uint64',
    });
    // 复用 scratch 缓冲：每 tick 要采 (进程数 × 2 次差分) 个样本，每次都 alloc
    // 会产生大量短命对象（实测 16 进程 × 2 = 32 次 × 6 个 alloc ≈ 192 次/tick），
    // 既推高 CPU 又制造 GC 压力。缓冲只在一次 `sample()` 内被读走，复用安全。
    const scratch = {
      c: koffi.alloc(FILETIME, 1), e: koffi.alloc(FILETIME, 1),
      k: koffi.alloc(FILETIME, 1), u: koffi.alloc(FILETIME, 1),
      mem: koffi.alloc(PMC, 1), io: koffi.alloc(IO, 1),
      pmcSize: PMC.size,
    };
    return (cachedApi = { api, koffi, FILETIME, PMC, IO, scratch });
  } catch {
    return (cachedApi = null);
  }
}

/** 采样单个进程的累计计数器。进程不存在/无权限 → `{pid, error}`。 */
export async function sample(pid) {
  const ctx = await loadApi();
  if (!ctx) return { pid, error: 'ffi-unavailable' };
  const { api, koffi, FILETIME, PMC, IO, scratch } = ctx;
  const h = api.openProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (h === null || h === 0n) return { pid, error: 'OpenProcess denied' };
  try {
    if (!api.getProcessTimes(h, scratch.c, scratch.e, scratch.k, scratch.u)) return { pid, error: 'GetProcessTimes' };
    koffi.encode(scratch.mem, PMC, { cb: scratch.pmcSize });
    const okM = api.k32GetProcessMemoryInfo(h, scratch.mem, scratch.pmcSize);
    const okI = api.getProcessIoCounters(h, scratch.io);
    const mem = okM ? koffi.decode(scratch.mem, PMC) : null;
    const io = okI ? koffi.decode(scratch.io, IO) : null;
    return {
      pid,
      cpu100ns: to100(koffi.decode(scratch.k, FILETIME)) + to100(koffi.decode(scratch.u, FILETIME)),
      created: to100(koffi.decode(scratch.c, FILETIME)),
      workingSet: mem ? Number(mem.WorkingSetSize) : null,
      peakWorkingSet: mem ? Number(mem.PeakWorkingSetSize) : null,
      pageFaults: mem ? mem.PageFaultCount : null,
      readBytes: io ? Number(io.ReadTransferCount) : null,
      writeBytes: io ? Number(io.WriteTransferCount) : null,
      readOps: io ? Number(io.ReadOperationCount) : null,
      writeOps: io ? Number(io.WriteOperationCount) : null,
    };
  } finally {
    try { api.closeHandle(h); } catch { /* 句柄已在 finally 之外失效，忽略 */ }
  }
}

/** 进程类型分类：Electron `--type=` 开关 + 命令行特征。 */
export function classify(name, cmd, isSelfPid) {
  const c = String(cmd ?? '');
  if (isSelfPid) return 'host';
  if (/ego-cast-worker/.test(c)) return 'ego-worker';
  if (/dsh-subprocess-local/.test(c)) return 'tool-runner';
  if (/--type=crashpad-handler/.test(c)) return 'crashpad';
  if (/--type=gpu-process/.test(c)) return 'gpu';
  if (/--type=renderer/.test(c)) return 'renderer';
  if (/--type=utility/.test(c)) {
    if (/node\.mojom\.NodeService/.test(c)) return 'host';
    if (/network\.mojom/.test(c)) return 'network';
    return 'utility';
  }
  if (/--type=/.test(c)) return 'utility';
  if (/DSH Desktop\.exe$/i.test(String(name ?? ''))) return 'main';
  if (/^node\.exe$/i.test(String(name ?? ''))) return 'node';
  // DSH 调起的 shell 子进程（工具执行、ego 桥接、脚本）：不是 DSH 本体，但确属 DSH 进程树。
  if (/^(powershell|pwsh|cmd|conhost|bash|sh|wsl)\.exe$/i.test(String(name ?? ''))) return 'shell';
  // 兜底改名 'other' → 'task'（2026-10-11）：
  //   本函数只被 `listProcesses()` 调用，而那里的列表是 `walk(root)` 走出来的 **DSH 进程树**
  //   ——树里每个进程都必然是 DSH 的后代，不存在「别人的进程」。叫 'other' 会让看页面的人
  //   以为混进了非 DSH 进程（老板正是这么读的）。叫 'task' 才与事实一致。
  return 'task';
}

/**
 * 把进程类型归到两个组 —— 这正是「只看 DSH 和 DSH 调起的任务」这个用途需要的切分。
 *
 * - `core` = DSH 本体：Electron 主进程 / 宿主 / 渲染 / GPU / 网络 / 崩溃守护 / 工具服务
 * - `task` = DSH 调起的任务进程：node / 工具子进程 / ego 浏览器 / shell / 兜底
 *
 * ⚠ 这个切分是**呈现层**的，不改变 `listProcesses()` 的范围（那里本来就只有 DSH 进程树）。
 */
export const CORE_KINDS = new Set(['main', 'host', 'renderer', 'gpu', 'network', 'crashpad', 'utility']);
export function groupOf(kind) {
  return CORE_KINDS.has(kind) ? 'core' : 'task';
}

/**
 * 列出 DSH 相关进程树。
 *
 * **必须走 powershell 而非 FFI 枚举**：Win32 没有稳定的「枚举所有 PID」的 FFI
 * 路径（`NtQuerySystemInformation` 结构体随 Windows 版本变化），CIM 查询简单可靠。
 *
 * ## 两个必须遵守的约束
 *
 * 1. **异步，绝不用 `execFileSync`**：本插件跑在 Host 进程里，而 agent loop 也在
 *    这个进程的事件循环上。`execFileSync` 会**阻塞整个事件循环** 200–400 ms
 *    （实测 powershell 冷启动），等于每个采样周期都卡住 agent 一次——
 *    监控插件把被监控对象搞卡，是本末倒置。
 * 2. **缓存 30 s**：进程树的变化很慢（工具子进程除外），而 powershell 冷启动昂贵。
 *    故树结构走 TTL 缓存；每个进程的**资源真值**仍由 FFI 每周期现采（微秒级）。
 *    注意：这意味着新出现的短命工具子进程可能晚最多 30 s 才进树——这是刻意的
 *    取舍（用 30 s 的可见性延迟换掉每个周期一次 300 ms 的阻塞）。
 */
export async function listProcesses({ ttlMs = 30000, maxAgeMs = 0 } = {}) {
  const now = Date.now();
  if (listProcesses._cache && now - listProcesses._at < ttlMs && !maxAgeMs) {
    return { ...listProcesses._cache, cached: true };
  }
  let rows;
  try {
    const raw = await new Promise((resolve, reject) => {
      execFile('powershell', ['-NoProfile', '-Command',
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress",
      ], { encoding: 'utf8', maxBuffer: 32 << 20, timeout: 15000, windowsHide: true }, (err, stdout) => {
        if (err) reject(err); else resolve(stdout);
      });
    });
    const parsed = JSON.parse(raw);
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } catch (e) {
    return { processes: [], error: String(e?.message ?? e), source: 'cim-failed' };
  }
  const byPid = new Map(rows.map((p) => [Number(p.ProcessId), p]));

  // 从自身（Host）向上找到 Electron 主进程，再向下收全部后代。
  let root = process.pid;
  for (let i = 0; i < 8; i += 1) {
    const cur = byPid.get(root);
    if (!cur) break;
    const ppid = Number(cur.ParentProcessId);
    if (!byPid.has(ppid)) break;
    root = ppid;
  }

  const children = new Map();
  for (const p of rows) {
    const ppid = Number(p.ParentProcessId);
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(Number(p.ProcessId));
  }
  const tree = [];
  const seen = new Set();
  const walk = (pid) => {
    if (seen.has(pid)) return;
    seen.add(pid);
    tree.push(pid);
    for (const c of children.get(pid) ?? []) walk(c);
  };
  walk(root);

  const processes = tree.map((pid) => {
    const p = byPid.get(pid) ?? {};
    return {
      pid,
      ppid: Number(p.ParentProcessId) || 0,
      name: String(p.Name ?? ''),
      cmd: String(p.CommandLine ?? ''),
      kind: classify(p.Name, p.CommandLine, pid === process.pid),
    };
  });
  const out = { processes, root, source: 'cim', cached: false };
  listProcesses._cache = out;
  listProcesses._at = now;
  return out;
}

/** 差分算 CPU%。`delta100ns / 10000` = CPU 毫秒；除以墙钟毫秒即占用比例。 */
export function cpuPercent(prev, next, wallMs) {
  if (!prev || !next || prev.cpu100ns === undefined || next.cpu100ns === undefined) return null;
  if (!(wallMs > 0)) return null;
  const delta = next.cpu100ns - prev.cpu100ns;
  if (delta < 0n) return null; // 计数器回绕或进程被复用
  return Number(delta) / 10000 / wallMs * 100;
}

/**
 * 一次完整采样（两次 FFI 差分）。
 *
 * `intervalMs` 默认 500 —— 采样窗口太短会让 CPU% 抖动放大（1 ms 的调度误差
 * 在 100 ms 窗口里就是 1%）。500 ms 在 3 s 心跳里是可接受的额外延迟，
 * 且**只阻塞采集器自己的 promise**，不阻塞 agent loop（我们在 Host 侧异步跑）。
 */
export async function sampleAll({ intervalMs = 500 } = {}) {
  const ctx = await loadApi();
  if (!ctx) {
    const cu = process.cpuUsage();
    return {
      source: 'self-only',
      note: 'FFI 不可用（非 Windows 或 koffi 缺失）：只能报 Host 自己，不含全机数据',
      wallMs: 0,
      selfCpuMs: 0,
      rows: [{ pid: process.pid, kind: 'host', group: 'core', cpuPct: null, workingSetMB: null, selfCpu: cu }],
      gone: [],
      scope: { root: process.pid, basis: 'self-only', note: 'FFI 不可用：本表只有 Host 自己。' },
      groupTotals: { core: { count: 1, cpuPct: 0, workingSetMB: 0 }, task: { count: 0, cpuPct: 0, workingSetMB: 0 } },
    };
  }
  const listed = await listProcesses();
  if (listed.error) {
    return { source: 'cim-failed', note: listed.error, wallMs: 0, selfCpuMs: 0, rows: [], gone: [], scope: null, groupTotals: null };
  }
  const pids = listed.processes.map((p) => p.pid);
  const wallStart = Date.now();
  // ── 自证开销：只量**两次 FFI 采样本身**的 CPU，**排除中间那段刻意 sleep** ──
  // ⚠ 这是修一个把宿主 CPU 冒领成"采集自耗"的缺陷（2026-10-11 真机取证）：
  //   原实现用「整个 tick 的 process.cpuUsage 差值」当自耗，而 `process.cpuUsage()`
  //   量的是**整个 Host 进程**。tick 里含 `await sleep(intervalMs)`，那 500ms 里
  //   宿主自己在跑 agent loop / 投影维护 / 别的插件 —— 这些全被记到了采集器账上。
  //   实测：`selfMsAvg=1095.2ms`、`selfCpuPctApprox=36.507%`、`SELF_COST_HIGH` 恒亮，
  //   而那是宿主的 CPU，不是采集的。此类误报会训练人忽略告警，比没有告警更糟。
  //   故改为：**只累加两段同步 FFI 采样的 CPU**，sleep 窗口完全不进账。
  const cpuA0 = process.cpuUsage();
  const first = new Map();
  for (const pid of pids) first.set(pid, await sample(pid));
  const cpuA = process.cpuUsage(cpuA0);

  await new Promise((r) => setTimeout(r, intervalMs));   // ← 睡眠窗口：别人的 CPU，不记我们的

  const cpuB0 = process.cpuUsage();
  const second = new Map();
  for (const pid of pids) second.set(pid, await sample(pid));
  const cpuB = process.cpuUsage(cpuB0);
  const selfCpuUs = cpuA.user + cpuA.system + cpuB.user + cpuB.system;
  const wall = Date.now() - wallStart;

  const rows = [];
  const gone = [];
  for (const p of listed.processes) {
    const a = first.get(p.pid) ?? {};
    const b = second.get(p.pid) ?? {};
    // ── 幽灵行过滤（2026-10-11 真机取证）────────────────────────────
    // 最新一次采样都失败的进程 = 采样时它已经不存在（或彻底不可访问）⇒ 不产出这一行。
    // 依据：进程树有 30s TTL 缓存，而 DSH 调起的 powershell/conhost 是**短命子进程**，
    // 树里留着已退出的 PID，`OpenProcess` 返回 0 ⇒ 旧实现会吐出一行 cpuPct 与
    // workingSetMB 双 `-` 的记录。实测 21 行里有 2 行是这种幽灵（`Get-Process -Id`
    // 复验：GONE）。这种行不仅无信息，还会让人误判成「混进来的非 DSH 进程」。
    // 过滤掉，但**如实计数**（`gone`），不做静默丢弃。
    if (b.error) { gone.push({ pid: p.pid, name: p.name, kind: p.kind, reason: b.error }); continue }
    const cpuPct = cpuPercent(a, b, wall);
    rows.push({
      pid: p.pid, ppid: p.ppid, kind: p.kind, group: groupOf(p.kind), name: p.name,
      cpuPct: cpuPct === null ? null : Math.round(cpuPct * 100) / 100,
      workingSetMB: b.workingSet == null ? null : Math.round(b.workingSet / 1048576 * 10) / 10,
      peakMB: b.peakWorkingSet == null ? null : Math.round(b.peakWorkingSet / 1048576 * 10) / 10,
      readMB: b.readBytes == null ? null : Math.round(b.readBytes / 1048576 * 10) / 10,
      writeMB: b.writeBytes == null ? null : Math.round(b.writeBytes / 1048576 * 10) / 10,
      readOps: b.readOps ?? null,
      pageFaults: b.pageFaults ?? null,
      // 供差分检测器使用（不落盘时由调用方剥掉）
      _raw: { cpu100ns: b.cpu100ns, readBytes: b.readBytes, writeBytes: b.writeBytes },
      err: a.error ?? null,
    });
  }
  // 分组小计：数据，不是呈现 —— 页面直接显示，避免客户端自己加总出错。
  const sub = (g) => {
    const rs = rows.filter((r) => r.group === g);
    return {
      count: rs.length,
      cpuPct: Math.round(rs.reduce((s, r) => s + (r.cpuPct ?? 0), 0) * 100) / 100,
      workingSetMB: Math.round(rs.reduce((s, r) => s + (r.workingSetMB ?? 0), 0) * 10) / 10,
    };
  };
  return {
    source: 'ffi',
    wallMs: wall,
    // 两段 FFI 采样自身的 CPU 毫秒（不含中间的 sleep 窗口）—— 这才是"采集自耗"。
    selfCpuMs: Math.round(selfCpuUs / 100) / 10,
    cores: (await import('node:os')).cpus().length,
    totalWorkingSetMB: Math.round(rows.reduce((s, r) => s + (r.workingSetMB ?? 0), 0) * 10) / 10,
    // 范围说明必须由服务端给出：页面此前不说范围，看起来就像一张「全机进程表」。
    scope: {
      root: listed.root,
      basis: 'dsh-process-tree',
      note: `范围＝DSH 进程树（pid ${listed.root} 及其全部后代）；非 DSH 进程不在本表。`,
    },
    groupTotals: { core: sub('core'), task: sub('task') },
    gone,
    goneNote: gone.length
      ? `${gone.length} 个进程在采样时已退出（多为短命的工具子进程），未列出：${gone.map((g) => `${g.name}#${g.pid}`).join('、')}`
      : null,
    rows,
  };
}
