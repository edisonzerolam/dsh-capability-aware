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
  return 'other';
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
      rows: [{ pid: process.pid, kind: 'host', cpuPct: null, workingSetMB: null, selfCpu: cu }],
    };
  }
  const listed = await listProcesses();
  if (listed.error) {
    return { source: 'cim-failed', note: listed.error, wallMs: 0, rows: [] };
  }
  const pids = listed.processes.map((p) => p.pid);
  const wallStart = Date.now();
  const first = new Map();
  for (const pid of pids) first.set(pid, await sample(pid));
  await new Promise((r) => setTimeout(r, intervalMs));
  const second = new Map();
  for (const pid of pids) second.set(pid, await sample(pid));
  const wall = Date.now() - wallStart;

  const rows = listed.processes.map((p) => {
    const a = first.get(p.pid) ?? {};
    const b = second.get(p.pid) ?? {};
    const cpuPct = cpuPercent(a, b, wall);
    return {
      pid: p.pid, ppid: p.ppid, kind: p.kind, name: p.name,
      cpuPct: cpuPct === null ? null : Math.round(cpuPct * 100) / 100,
      workingSetMB: b.workingSet == null ? null : Math.round(b.workingSet / 1048576 * 10) / 10,
      peakMB: b.peakWorkingSet == null ? null : Math.round(b.peakWorkingSet / 1048576 * 10) / 10,
      readMB: b.readBytes == null ? null : Math.round(b.readBytes / 1048576 * 10) / 10,
      writeMB: b.writeBytes == null ? null : Math.round(b.writeBytes / 1048576 * 10) / 10,
      readOps: b.readOps ?? null,
      pageFaults: b.pageFaults ?? null,
      // 供差分检测器使用（不落盘时由调用方剥掉）
      _raw: { cpu100ns: b.cpu100ns, readBytes: b.readBytes, writeBytes: b.writeBytes },
      err: b.error ?? a.error ?? null,
    };
  });
  return {
    source: 'ffi',
    wallMs: wall,
    cores: (await import('node:os')).cpus().length,
    totalWorkingSetMB: Math.round(rows.reduce((s, r) => s + (r.workingSetMB ?? 0), 0) * 10) / 10,
    rows,
  };
}
