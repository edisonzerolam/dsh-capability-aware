/**
 * 插件层采集（L3）—— 读宿主 loader 的 entry 表。
 *
 * ## 诚实标签（必须写在任何 UI / 输出上）
 *
 * **本层是「相关性排序」，不是「CPU 归因」。** DSH 不提供插件级 CPU/内存
 * 计量 API（Cordis 的 `ctx.loader.entries()` 只给 Fiber 阶段，不给资源计数）。
 * 任何声称「插件 X 占用 N% CPU」的输出都是伪精度。本模块只报**事实**
 * （entry id / 模块标识 / 是否启用 / Fiber 阶段 / 是否本插件），
 * 由调用方结合进程与会话层做收敛式推理。
 *
 * ## 两种取数路径
 *
 * 1. **进程内直读**（首选）：`readPluginInventory(ctx)` 由
 *    `@deepseek-ai/dsh-host-plugin-inventory` 导出，遍历 `ctx.loader.entries()`。
 *    插件跑在 Host 里，直接可用，无 RPC 开销。
 * 2. **回退**：自己遍历 `ctx.loader.entries()`（同上，但字段可能随宿主版本漂移）。
 *
 * 注意该包的服务 `pluginInventory` 是 **TypertRemoteService**（Remote-only），
 * 故从 Host 侧调服务方法反而绕远——直读导出的纯函数才是正解。
 *
 * @module dsh-efficiency/lib/monitor/plugins
 */
import { safeService } from '../svc.js';

const FIBER_PHASE = {
  0: 'pending', 1: 'loading', 2: 'active', 3: 'failed', 4: 'disposed', 5: 'unloading',
};

/** 本插件自己的 entry id 前缀（用于自我标注，避免把自己算进「热点候选」）。 */
const SELF_HINTS = [/efficiency/i, /效率机/];

function phaseOf(fiber) {
  const s = fiber?.state;
  if (typeof s === 'number' && FIBER_PHASE[s]) return FIBER_PHASE[s];
  if (typeof s === 'string') return s;
  return null;
}

/**
 * 列出当前 loader entries。
 *
 * `entry.id` 在 `loader/entry-init` **构造函数内部**访问会抛
 * （`Cannot read properties of undefined (reading 'tree')`，见 dsh-my-guardian
 * 的注释），但**这里是 loader 已就绪后的主动遍历**，`entry.id` 是安全的。
 * 该坑只影响事件回调里的即时访问。
 */
export function readPlugins(ctx, { limit = 400 } = {}) {
  const rows = [];
  let source = 'loader';
  let note = '';
  let entries = [];
  try {
    // ⚠ `safeService` 而非 `ctx?.loader`：真实 Cordis Context 对未 inject 的服务做
    //   属性访问会抛（`cannot get property "loader" without inject`），`?.` 拦不住
    //   会抛的 getter。旧写法让本层**永远**返回 `source:'none'`（异常被下面的
    //   catch 吞掉、只留一句 note），即插件层在真机上从未真正工作过。
    const loader = safeService(ctx, 'loader');
    // 服务本身不可用 → 如实报 `source:'none'`。**不要**报 'loader'：那会让人以为
    // 「loader 路径跑通了、只是恰好没有条目」，而事实是这条路径根本没接上——
    // 把一个不可用说成空结果，正是本项目最忌讳的那种谎报。
    if (!loader) {
      return { source: 'none', plugins: [], note: 'loader 服务不可用（未注册 / 非 Cordis Context）' };
    }
    entries = loader.entries?.() ?? [];
    if (typeof entries[Symbol.iterator] !== 'function') entries = [...(entries ?? [])];
    else entries = [...entries];
  } catch (e) {
    return { source: 'none', plugins: [], note: `loader.entries() 失败：${e?.message ?? e}` };
  }
  if (!Array.isArray(entries)) entries = [];

  for (const entry of entries) {
    try {
      // 跳过 group（分组不是可加载的插件）。
      if (entry?.options?.group) continue;
      const opts = entry?.options ?? {};
      let id = null;
      try { id = entry?.id ?? null; } catch { id = null; }
      const moduleName = String(opts.name ?? opts.id ?? id ?? '');
      const self = SELF_HINTS.some((re) => re.test(String(id ?? '') + moduleName));
      rows.push({
        entryId: id == null ? null : String(id),
        moduleName,
        enabled: entry?.disabled !== true,
        fiberPhase: phaseOf(entry?.fiber),
        self,
      });
    } catch { /* 单 entry 失败不影响其他 */ }
  }
  if (rows.length > limit) rows = rows.slice(0, limit);

  const counts = {};
  for (const r of rows) counts[r.fiberPhase ?? 'unknown'] = (counts[r.fiberPhase ?? 'unknown'] ?? 0) + 1;
  if (!note && !rows.length) note = 'loader 无 entries（启动早期？）';
  return { source, plugins: rows, counts, note: note || undefined };
}

/**
 * 疑似热点候选 —— **明确标注这是相关性排序**。
 *
 * 排序依据（全部是「值得先看」的启发式，不是测量值）：
 *   1. `fiberPhase === 'failed'` 强制置顶（这是**确定**的问题，不是猜测）
 *   2. `!enabled` 但仍在表里
 *   3. 其余按 entry 顺序（宿主装载顺序 ≈ 依赖顺序，无资源含义）
 */
export function rankPluginCandidates(plugins) {
  return [...plugins]
    .map((p) => ({
      ...p,
      reason: p.fiberPhase === 'failed' ? '装载失败（确定问题）'
        : p.fiberPhase === 'loading' || p.fiberPhase === 'pending' ? '未完成装载'
          : !p.enabled ? '已禁用但仍注册'
            : null,
    }))
    .sort((a, b) => {
      const w = (x) => (x.fiberPhase === 'failed' ? 0 : x.fiberPhase === 'loading' ? 1 : x.fiberPhase === 'pending' ? 2 : !x.enabled ? 3 : 4);
      return w(a) - w(b);
    });
}
