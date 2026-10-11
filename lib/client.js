/**
 * dsh-efficiency · 浏览器半边（客户端插件）
 *
 * 把「DSH 效率机」注册成设置页里**独立的一项**。
 *
 * 关键机制（本机 2.0.17 实测）：`settings.section` 是一个 **list 槽**
 * （`{ kind: 'list', scope: 'root' }`），设置页左侧导航由
 * `ctx.slots.entries('settings.section')` 按 `order` 排序生成 —— 所以第三方
 * 插件可以单开一个顶层设置项，与 general(0) / models(10) / plugins(15) 并列。
 *
 * 手写 ModuleLoader bundle，无构建步骤；只 require 壳子已提供的 `react`。
 * 数据全部走同源只读路由 `/api/efficiency/*`（Host 侧已挂载 14 条），
 * 因此客户端不需要 RPC 命名空间，也**不写任何东西**（纯只读看板）。
 *
 * 诚实纪律：页面只呈现后端原样给出的数，不做二次推断；P3 明写「不要动」。
 */

window.__ModuleLoader__.load({
  id: 'dsh-efficiency',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')
    const h = React.createElement

    const NS = 'efficiency.settings'
    const API = '/api/efficiency'
    const inject = ['slots', 'locale']
    // 15 秒（原 5 秒）：一次完整刷新要打 5 个路由，其中 /diagnose 是 350KB 级响应，
    // 实测一轮完整刷新 1313ms Host CPU（单核 162.9%）⇒ 5 秒间隔即常驻单核 26.3%。
    // 放宽到 15 秒把它压到约 8.8%，对「看资源占用」这个用途毫无损失。
    const REFRESH_MS = 15000

    const zh = {
      nav: '效率机',
      title: 'DSH 效率机',
      intro: '本机能力索引 · 运行时资源监控 · 报错账本与分级诊断',
      refresh: '刷新',
      auto: '自动刷新',
      loading: '读取中…',
      overview: '概览',
      capability: '能力索引',
      entries: '条目',
      skills: '技能',
      plugins: '插件',
      interfaces: '接口',
      ledger: '错误账本',
      records: '记录',
      badLines: '坏行',
      monitor: '资源监控',
      ticks: '心跳',
      collectErrors: '采集失败',
      samples: '采样落盘',
      procs: '实时进程占用',
      pid: 'PID',
      kind: '角色',
      cpu: 'CPU%',
      ws: '工作集',
      proc: '进程',
      diag: '分级诊断',
      findings: '发现',
      fixable: '可修',
      notFixable: '不可修',
      times: '次',
      sessions: '会话',
      subject: '主体',
      fixprompt: '生成修复提示词',
      copy: '复制',
      copied: '已复制',
      empty: '暂无数据',
      p3note: 'P3 一律不要动 —— 那是模型供应商限流/配额/断流/网络，改本机代码对它们无效。',
      updated: '更新于',
      failed: '读取失败',
      partial: '部分数据缺失',
      // ── 修复台账（v0.11.0） ─────────────────────────────────────
      fixes: '修复台账',
      fixesHint: '「生成修复提示词」时自动开工单；这里按工单时刻之后的账本记录判断有没有再复发，未再复发的移出待修清单。',
      pending: '待修',
      fRecurring: '修过仍复发',
      fWatching: '已开单待观察',
      fUnticketed: '未修过',
      fResolved: '未再复发（已移出）',
      fDeclared: '人工声明已修',
      fNotFixable: '不修（非本机问题）',
      activeTickets: '在用工单',
      ticket: '工单',
      closeTicket: '标记为已修',
      closeHint: '人工声明 —— 不是测量：它没有「修后未再复发」的证据支撑。',
      noFixTickets: '还没有工单。点上方「生成修复提示词」会自动开单，之后这里就能跟踪修复结果。',
      // ── 进程表分组 / 范围 / 角色名 ──────────────────────────────
      groupCore: 'DSH 本体',
      groupTask: 'DSH 调起的任务进程',
      subtotal: '小计',
      count: '个',
      scope: '范围',
      k_main: '主进程',
      k_host: '宿主 (Node)',
      k_renderer: '渲染器',
      k_gpu: 'GPU 进程',
      k_network: '网络服务',
      k_crashpad: '崩溃守护',
      k_utility: '工具服务',
      k_node: 'Node 进程',
      k_tool_runner: '工具子进程',
      k_ego_worker: 'ego 浏览器',
      k_shell: 'Shell 子进程',
      k_task: '任务进程'
    }

    const en = {
      nav: 'Efficiency',
      title: 'DSH Efficiency',
      intro: 'Local capability index · runtime resource monitor · error ledger & graded diagnostics',
      refresh: 'Refresh',
      auto: 'Auto refresh',
      loading: 'Loading…',
      overview: 'Overview',
      capability: 'Capability index',
      entries: 'entries',
      skills: 'skills',
      plugins: 'plugins',
      interfaces: 'interfaces',
      ledger: 'Error ledger',
      records: 'records',
      badLines: 'bad lines',
      monitor: 'Resource monitor',
      ticks: 'ticks',
      collectErrors: 'collect errors',
      samples: 'samples written',
      procs: 'Live process usage',
      pid: 'PID',
      kind: 'Role',
      cpu: 'CPU%',
      ws: 'Working set',
      proc: 'Process',
      diag: 'Graded diagnostics',
      findings: 'findings',
      fixable: 'fixable',
      notFixable: 'not fixable',
      times: 'x',
      sessions: 'sessions',
      subject: 'subject',
      fixprompt: 'Build fix prompt',
      copy: 'Copy',
      copied: 'Copied',
      empty: 'No data',
      p3note: 'Never touch P3 — those are provider rate limits/quota/transport. Local code changes cannot help.',
      updated: 'updated',
      failed: 'Load failed',
      partial: 'partial data',
      // ── fix journal (v0.11.0) ───────────────────────────────────
      fixes: 'Fix journal',
      fixesHint: 'A ticket is opened whenever a fix prompt is generated. Recurrence is judged from ledger records after the ticket time; items with no recurrence leave the pending list.',
      pending: 'Pending',
      fRecurring: 'Fixed but recurring',
      fWatching: 'Ticketed, window too short',
      fUnticketed: 'Never fixed',
      fResolved: 'No recurrence (removed)',
      fDeclared: 'Declared fixed',
      fNotFixable: 'Not ours to fix',
      activeTickets: 'active tickets',
      ticket: 'Ticket',
      closeTicket: 'Mark as fixed',
      closeHint: 'A human declaration — not a measurement: it has no "no recurrence" evidence behind it.',
      noFixTickets: 'No tickets yet. Generating a fix prompt above opens tickets, after which this panel tracks the outcome.',
      // ── process table groups / scope / role names ───────────────
      groupCore: 'DSH core',
      groupTask: 'Tasks spawned by DSH',
      subtotal: 'subtotal',
      count: 'procs',
      scope: 'Scope',
      k_main: 'main',
      k_host: 'host (Node)',
      k_renderer: 'renderer',
      k_gpu: 'gpu',
      k_network: 'network',
      k_crashpad: 'crashpad',
      k_utility: 'utility',
      k_node: 'node',
      k_tool_runner: 'tool runner',
      k_ego_worker: 'ego worker',
      k_shell: 'shell',
      k_task: 'task'
    }

    /** 同源只读 GET；失败即抛，由调用方统一呈现（绝不假装成功）。 */
    const get = (path) => fetch(API + path, { headers: { accept: 'application/json' } }).then((r) => {
      if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`)
      return r.json()
    })

    /** 并行取数；任一失败只记 error 不吞掉其余。 */
    async function loadAll() {
      const want = {
        doctor: '/doctor',
        // ⚠ 不能用 /ledger/stats：它只回「本次运行」的计数器（captured/written/
        // pending/dedup…），**没有 total、没有 badLines**，页面因此长期显示「—」。
        // 累计真值在 /recent（readTail 返回 {total, badLines, records}）。
        ledger: '/ledger/recent?limit=1',
        health: '/monitor/health',
        procs: '/monitor/procs',
        diag: '/diagnose',
        // 修复台账（v0.11.0）：工单 + 复发核验 + 待修清单收敛。
        fixes: '/fixes'
      }
      const keys = Object.keys(want)
      const settled = await Promise.all(keys.map((k) => get(want[k]).then(
        (v) => ({ k, v }),
        (e) => ({ k, e: String((e && e.message) || e) })
      )))
      const out = { at: Date.now(), errors: [] }
      for (const s of settled) {
        if (s.e) out.errors.push(s.e)
        else out[s.k] = s.v
      }
      return out
    }

    // ── 样式（全部走壳子已有的 CSS 变量，带兜底值） ──────────────
    const TEXT = 'var(--dsw-alias-label-primary, inherit)'
    const MUTED = 'var(--dsw-alias-label-tertiary, #8a8a8a)'
    const LINE = 'var(--dsw-alias-border-secondary, rgba(128,128,128,0.28))'
    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

    const S = {
      wrap: { maxWidth: 900, display: 'flex', flexDirection: 'column', gap: 14, color: TEXT, fontSize: 13 },
      head: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      h2: { margin: 0, fontSize: 18, fontWeight: 600 },
      // ⚠ 这里曾经写 `flex: '1 1 320px'`：intro 是 S.wrap（flexDirection:'column'）
      // 的直接子元素，纵向 flex 里 flex-basis 量的是**高度**，grow:1 再吃掉全部剩余
      // 纵向空间 ⇒ 标题与「概览」之间被顶出一个 500+px 的空盒。不要加回 flex。
      intro: { margin: 0, color: MUTED, fontSize: 12 },
      btn: {
        border: `1px solid ${LINE}`, background: 'transparent', color: TEXT,
        borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer'
      },
      card: { border: `1px solid ${LINE}`, borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 },
      cardTitle: { fontSize: 12, fontWeight: 600, color: MUTED, letterSpacing: 0.3, textTransform: 'uppercase' },
      row: { display: 'flex', gap: 18, flexWrap: 'wrap' },
      kv: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 84 },
      kvNum: { fontSize: 17, fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
      kvLabel: { fontSize: 11, color: MUTED },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
      th: { textAlign: 'left', color: MUTED, fontWeight: 500, padding: '3px 6px', borderBottom: `1px solid ${LINE}` },
      td: { padding: '3px 6px', borderBottom: `1px solid ${LINE}`, fontVariantNumeric: 'tabular-nums' },
      tdName: { padding: '3px 6px', borderBottom: `1px solid ${LINE}`, fontFamily: MONO, fontSize: 11, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      badge: { display: 'inline-block', borderRadius: 4, padding: '0 5px', fontSize: 11, fontWeight: 600, marginRight: 4 },
      note: { margin: 0, color: MUTED, fontSize: 11, lineHeight: 1.5 },
      err: { margin: 0, color: 'var(--dsw-alias-label-error, #d9534f)', fontSize: 12 },
      ta: { width: '100%', minHeight: 180, fontFamily: MONO, fontSize: 11, lineHeight: 1.45, color: TEXT, background: 'transparent', border: `1px solid ${LINE}`, borderRadius: 6, padding: 8, resize: 'vertical' },
      finding: { display: 'flex', gap: 8, alignItems: 'baseline', padding: '2px 0' },
      code: { fontFamily: MONO, fontSize: 11, minWidth: 180 },
      // 进程表分组表头：把「DSH 本体」与「DSH 调起的任务进程」分开，各自带小计
      groupRow: { background: 'transparent' },
      groupTd: {
        padding: '8px 6px 3px', borderBottom: `1px solid ${LINE}`, color: MUTED,
        fontSize: 11, fontWeight: 600, letterSpacing: 0.3
      }
    }

    const SEV_COLOR = { P0: '#d9534f', P1: '#e08b2f', P2: '#4a90d9', P3: '#8a8a8a' }

    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString('en-US') : '—')
    const mb = (v) => (typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(v >= 100 ? 0 : 1)} MB` : '—')
    const pct = (v) => (typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(1)}%` : '—')

    function KV(props) {
      return h('div', { style: S.kv },
        h('span', { style: S.kvNum }, props.value),
        h('span', { style: S.kvLabel }, props.label))
    }

    function Card(props) {
      return h('div', { style: S.card },
        h('div', { style: S.cardTitle }, props.title),
        props.children)
    }

    function Badge(props) {
      return h('span', { style: { ...S.badge, color: SEV_COLOR[props.sev] || TEXT } }, props.sev)
    }

    /** 角色名本地化：词典里有就用词典的，没有就原样上屏（绝不编造）。 */
    const kindLabel = (t, k) => {
      const s = String(k ?? '')
      if (!s) return '—'
      const key = `k_${s.replace(/-/g, '_')}`
      const v = t(key)
      return typeof v === 'string' && v !== key ? v : s
    }

    /**
     * 实时进程表。
     *
     * 范围：**DSH 进程树**（`main` 及其全部后代）——非 DSH 进程不在这里（后端 `walk(root)`
     * 已保证，`scope` 字段由服务端给出）。表内分两组：
     *   · `core` = DSH 本体（Electron 主/宿主/渲染/GPU/网络/崩溃守护/工具服务）
     *   · `task` = DSH 调起的任务进程（node / 工具子进程 / ego / shell / 兜底）
     *
     * ⚠ 曾经这里 `.slice(0, 8)` 按 CPU 降序取前 8 —— 实测 21 个进程里所有 0% CPU 的
     * **任务进程被整批砍掉**，而「看 DSH 调起的任务」恰恰是这个页面存在的理由。
     * 故改为**全量列出**（两组各自成段 + 小计），不再按 CPU 截断。
     */
    function ProcTable(props) {
      const { procs, t } = props
      const all = (procs && Array.isArray(procs.procs) ? procs.procs : [])
        .slice()
        .sort((a, b) => (b.cpuPct ?? -1) - (a.cpuPct ?? -1))
      if (!all.length) return h('p', { style: S.note }, t('empty'))

      const totals = (procs && procs.groupTotals) || {}
      const body = []
      for (const g of [{ id: 'core', label: t('groupCore') }, { id: 'task', label: t('groupTask') }]) {
        const rows = all.filter((p) => (p.group || 'task') === g.id)
        const tot = totals[g.id] || {}
        body.push(h('tr', { key: `h-${g.id}`, style: S.groupRow },
          h('td', { style: S.groupTd, colSpan: 5 },
            `${g.label} · ${rows.length} ${t('count')} · ${t('subtotal')} ${pct(tot.cpuPct ?? 0)} / ${mb(tot.workingSetMB ?? 0)}`)))
        if (!rows.length) {
          body.push(h('tr', { key: `e-${g.id}` },
            h('td', { style: { ...S.td, color: MUTED }, colSpan: 5 }, t('empty'))))
          continue
        }
        for (const p of rows) {
          body.push(h('tr', { key: String(p.pid) },
            h('td', { style: S.td }, String(p.pid)),
            h('td', { style: S.td, title: String(p.kind ?? '') }, kindLabel(t, p.kind)),
            h('td', { style: S.td }, pct(p.cpuPct)),
            h('td', { style: S.td }, mb(p.workingSetMB)),
            h('td', { style: S.tdName, title: p.name }, String(p.name ?? ''))))
        }
      }

      const scope = procs && procs.scope
      return h('div', null,
        h('table', { style: S.table },
          h('thead', null, h('tr', null,
            h('th', { style: S.th }, t('pid')),
            h('th', { style: S.th }, t('kind')),
            h('th', { style: S.th }, t('cpu')),
            h('th', { style: S.th }, t('ws')),
            h('th', { style: S.th }, t('proc')))),
          h('tbody', null, body)),
        scope && scope.note ? h('p', { style: { ...S.note, marginTop: 6 } }, `${t('scope')}：${scope.note}`) : null,
        procs && procs.goneNote ? h('p', { style: { ...S.note, marginTop: 6 } }, procs.goneNote) : null,
        procs && procs.cpuBasis ? h('p', { style: { ...S.note, marginTop: 6 } }, procs.cpuBasis) : null,
        procs && procs.cached
          ? h('p', { style: { ...S.note, marginTop: 6 } }, `数据取自最近一次心跳采样（${Math.round((procs.sampleAgeMs || 0) / 1000)} 秒前）；点「刷新」不会重新采样全机。`)
          : null,
        procs && procs.disclaimer ? h('p', { style: { ...S.note, marginTop: 6 } }, procs.disclaimer) : null)
    }

    /** 分级诊断：P0–P3 计数 + 每档前 3 条（后端已按「确定性」而非严重度分档）。 */
    function DiagPanel(props) {
      const { diag, t } = props
      if (!diag) return h('p', { style: S.note }, t('empty'))
      const counts = diag.counts || {}
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h('div', { style: S.row },
          ['P0', 'P1', 'P2', 'P3'].map((sev) => h('div', { key: sev, style: S.kv },
            h('span', { style: { ...S.kvNum, color: SEV_COLOR[sev] } }, num(counts[sev] ?? 0)),
            h('span', { style: S.kvLabel }, sev))),
          h(KV, { value: num(diag.totalFindings), label: t('findings') }),
          h(KV, { value: num(diag.fixable ? diag.fixable.length : 0), label: t('fixable') }),
          h(KV, { value: num(diag.notFixable ? diag.notFixable.length : 0), label: t('notFixable') })),
        ['P0', 'P1', 'P2', 'P3'].map((sev) => {
          const list = (diag.bySeverity && diag.bySeverity[sev]) || []
          if (!list.length) return null
          return h('div', { key: sev },
            h('div', { style: { ...S.cardTitle, marginBottom: 4 } }, sev),
            list.slice(0, 3).map((f, i) => h('div', { key: `${sev}-${i}`, style: S.finding },
              h('span', { style: S.code, title: f.code }, String(f.code ?? '')),
              h('span', { style: { color: MUTED, fontSize: 11 } },
                `${f.subject ? `${f.subject.kind}:${f.subject.name}` : ''} · ${num(f.count)}${t('times')} / ${num(f.sessionCount)}${t('sessions')}`))))
        }).filter(Boolean),
        h('p', { style: S.note }, t('p3note')))
    }

    /**
     * 修复台账。
     *
     * 展示口径与 CLI 完全一致（同一份 `/fixes` 响应），**不在这里二次判定**：
     * 状态、复发次数、观察窗口都由 Host 侧 `lib/fixes.js` 算好，页面只负责呈现。
     * 「已开单待观察」故意留在待修清单里 —— 刚开单 0 次复发不等于修好了。
     */
    function FixesPanel(props) {
      const { fixes, t, onClose, busy } = props
      if (!fixes) return h('p', { style: S.note }, t('empty'))
      const c = fixes.counts || {}
      const rows = (fixes.pending || []).slice(0, 8)
      const STATE_COLOR = { recurring: SEV_COLOR.P0, watching: SEV_COLOR.P2, unticketed: MUTED }
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h('div', { style: S.row },
          h(KV, { value: num(c.pending), label: t('pending') }),
          h(KV, { value: num(c.recurring), label: t('fRecurring') }),
          h(KV, { value: num(c.watching), label: t('fWatching') }),
          h(KV, { value: num(c.unticketed), label: t('fUnticketed') }),
          h(KV, { value: num(c.resolved), label: t('fResolved') }),
          h(KV, { value: num(c.declared), label: t('fDeclared') }),
          // 「不修（非本机问题）」必须与「待修」分开显示：把修不了的东西摆进待修是
          // 按类别说谎，也会让真正该修的 P1 被挤到列表后面（真机实测踩到过）。
          h(KV, { value: num(c.notFixable), label: t('fNotFixable') }),
          h(KV, { value: num(c.activeTickets), label: t('activeTickets') })),
        h('p', { style: S.note }, t('fixesHint')),
        !rows.length
          ? h('p', { style: S.note }, t('noFixTickets'))
          : rows.map((it, i) => h('div', { key: `${it.key}-${i}`, style: S.finding },
            h('span', { style: S.code, title: it.code }, String(it.code ?? '')),
            h('span', { style: { color: STATE_COLOR[it.state] || MUTED, fontSize: 11 } },
              `${it.stateLabel || it.state} · ${it.subject ? `${it.subject.kind}:${it.subject.name}` : ''} · ${num(it.count)}${t('times')} / ${num(it.sessionCount)}${t('sessions')}`),
            it.ticket && it.ticket.id
              ? h('button', {
                style: { ...S.btn, fontSize: 11, padding: '1px 6px' },
                disabled: busy,
                onClick: () => onClose(it.ticket.id)
              }, t('closeTicket'))
              : null,
            it.note ? h('div', { style: { color: MUTED, fontSize: 11 } }, it.note) : null)),
        h('p', { style: S.note }, t('closeHint')))
    }

    function Page(props) {
      const { t } = props
      const [state, setState] = React.useState({ loading: true, data: null })
      const [auto, setAuto] = React.useState(true)
      const [fix, setFix] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      const reload = React.useCallback(() => {
        loadAll().then((d) => setState({ loading: false, data: d }))
          .catch((e) => setState({ loading: false, data: { errors: [String((e && e.message) || e)], at: Date.now() } }))
      }, [])

      React.useEffect(() => { reload() }, [reload])
      React.useEffect(() => {
        if (!auto) return undefined
        const id = setInterval(reload, REFRESH_MS)
        return () => clearInterval(id)
      }, [auto, reload])

      const buildFix = () => {
        setBusy(true)
        get('/fixprompt').then(
          (r) => {
            setFix(r.prompt || '')
            setBusy(false)
            // 生成即开单 ⇒ 立刻刷新台账，让「已开单待观察」当场可见。
            if (r && r.tickets && r.tickets.length) reload()
          },
          (e) => { setFix(`读取失败：${(e && e.message) || e}`); setBusy(false) }
        )
      }

      /** 人工关闭一张工单（声明，不是测量）。 */
      const closeFix = (id) => {
        if (!id) return
        setBusy(true)
        fetch(`${API}/fixes/close`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ id, by: 'ui' })
        }).then((r) => r.json()).then(
          (r) => {
            setBusy(false)
            if (r && r.matched === false) {
              setFix(`⚠ 未找到工单 ${id} —— 关闭记录已写入但没有对应工单。`)
            }
            reload()
          },
          (e) => { setBusy(false); setFix(`关闭失败：${(e && e.message) || e}`) }
        )
      }

      const copyFix = () => {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(fix || '')
        } catch (e) { /* 剪贴板不可用时用户仍可手动选中复制 */ }
      }

      const d = state.data
      const doctor = d && d.doctor
      const counts = (doctor && doctor.counts) || {}
      const ledger = d && d.ledger
      const health = d && d.health
      const stats = (health && health.stats) || {}

      return h('div', { style: S.wrap },
        h('div', { style: S.head },
          h('h2', { style: S.h2 }, t('title')),
          h('button', { style: S.btn, onClick: reload }, t('refresh')),
          h('label', { style: { ...S.kvLabel, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: auto, onChange: (e) => setAuto(!!e.target.checked) }),
            t('auto')),
          state.loading ? h('span', { style: S.kvLabel }, t('loading')) : null,
          d && d.at ? h('span', { style: S.kvLabel }, `${t('updated')} ${new Date(d.at).toLocaleTimeString()}`) : null),
        h('p', { style: S.intro }, t('intro')),

        d && d.errors && d.errors.length
          ? h('p', { style: S.err }, `${t('failed')}：${d.errors.join('；')}`)
          : null,

        h(Card, { title: t('overview') },
          h('div', { style: S.row },
            h(KV, { value: num(doctor && doctor.entries), label: t('capability') }),
            h(KV, { value: num(counts.skill), label: t('skills') }),
            h(KV, { value: num(counts.plugin), label: t('plugins') }),
            h(KV, { value: num(counts.interface), label: t('interfaces') }),
            h(KV, { value: num(ledger && ledger.total), label: `${t('ledger')} · ${t('records')}` }),
            h(KV, { value: num(ledger && ledger.badLines), label: t('badLines') }),
            h(KV, { value: num(stats.ticks), label: `${t('monitor')} · ${t('ticks')}` }),
            h(KV, { value: num(stats.errors), label: t('collectErrors') }),
            h(KV, { value: num(stats.samplesWritten), label: t('samples') }))),

        h(Card, { title: t('procs') }, h(ProcTable, { procs: d && d.procs, t })),

        h(Card, { title: t('diag') }, h(DiagPanel, { diag: d && d.diag, t })),

        h(Card, { title: t('fixprompt') },
          h('div', { style: { display: 'flex', gap: 8 } },
            h('button', { style: S.btn, onClick: buildFix, disabled: busy }, busy ? t('loading') : t('fixprompt')),
            fix ? h('button', { style: S.btn, onClick: copyFix }, t('copy')) : null),
          fix ? h('textarea', { style: S.ta, readOnly: true, value: fix }) : null),

        h(Card, { title: t('fixes') },
          h(FixesPanel, { fixes: d && d.fixes, t, onClose: closeFix, busy })))
    }

    function apply(ctx) {
      try {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'efficiency-settings: dictionaries')
        // settings.section 是 list 槽：注册即成为设置页左侧的一个独立导航项。
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'efficiency',
          order: 20,
          label: () => t('nav'),
          locale: NS
        }, (props) => h(Page, { ...props, t })))
      } catch (e) {
        console.error('[dsh-efficiency] client apply failed:', e)
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
