/**
 * Cordis 服务的安全取用 —— 供**可选**依赖的探测方使用。
 *
 * ⚠ 本模块存在的唯一理由是一个真机实测出来的坑（2026-10-11，由宿主 RPC 取证）：
 *
 *   在**真实 Cordis Context** 上，对未通过 `inject` 声明的服务做**属性访问**会直接抛错：
 *
 *     cannot get property "sessionProjections" without inject
 *
 *   **可选链救不了这件事**。`ctx?.sessionProjections` 里的 `?.` 只在左侧为
 *   `null`/`undefined` 时短路，而 Cordis 把服务装成**会抛的 getter** ——
 *   `?.` 会照常触发那个 getter，异常照常冒泡。
 *
 *   代价（实测）：监控心跳 `started:true` 但 `ticks:0`、`errors:45`，
 *   `lastError` 就是上面那串；即采集器每个周期都在同一行炸掉，
 *   监控形同虚设，而日志里只有一句"采集失败"。
 *
 * 正确姿势是 `ctx.get(name)` —— 它是「取服务，取不到给 undefined」的官方入口，
 * **不做 inject 检查**（`lib/interfaces.js` 的运行期服务探测一直用的就是它）。
 * 但为兼容 API 漂移，这里仍包一层 try/catch；并且**绝不**让
 * 「属性访问抛错」冒泡出去 —— 可选依赖缺失应当是**降级**，不是**故障**。
 *
 * @module dsh-efficiency/lib/svc
 */

/**
 * 取一个可选服务；取不到返回 `null`（永不抛）。
 *
 * @param {object} ctx  Cordis Context（或任何形状相似的对象）
 * @param {string} name 服务名，如 `'sessionProjections'` / `'loader'` / `'sessions'`
 * @returns {any|null}
 */
export function safeService(ctx, name) {
  if (!ctx || !name) return null;

  // ① 官方入口：get(name)。它不检查 inject，是「可选依赖」的正解。
  try {
    if (typeof ctx.get === 'function') {
      const v = ctx.get(name);
      if (v !== undefined && v !== null) return v;
    }
  } catch { /* 服务未注册时 get 也可能抛 —— 视为不可用 */ }

  // ② 退回属性访问（非 Cordis Context 的普通对象、或测试 stub 走这条）。
  //    这里的 try/catch 是**关键**：正是它把「会抛的 getter」变成「不可用」。
  try {
    const v = ctx[name];
    return v === undefined ? null : v;
  } catch {
    return null;
  }
}
