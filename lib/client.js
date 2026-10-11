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
      partial: '部分数据缺失'
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
      partial: 'partial data'
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
        diag: '/diagnose'
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
      code: { fontFamily: MONO, fontSize: 11, minWidth: 180 }
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

    /** 实时进程表：按 CPU% 降序取前 N（后端已按 kind 分类）。 */
    function ProcTable(props) {
      const { procs, t } = props
      const rows = (procs && Array.isArray(procs.procs) ? procs.procs : [])
        .slice()
        .sort((a, b) => (b.cpuPct ?? -1) - (a.cpuPct ?? -1))
        .slice(0, 8)
      if (!rows.length) return h('p', { style: S.note }, t('empty'))
      return h('div', null,
        h('table', { style: S.table },
          h('thead', null, h('tr', null,
            h('th', { style: S.th }, t('pid')),
            h('th', { style: S.th }, t('kind')),
            h('th', { style: S.th }, t('cpu')),
            h('th', { style: S.th }, t('ws')),
            h('th', { style: S.th }, t('proc')))),
          h('tbody', null, rows.map((p) => h('tr', { key: String(p.pid) },
            h('td', { style: S.td }, String(p.pid)),
            h('td', { style: S.td }, String(p.kind ?? '—')),
            h('td', { style: S.td }, pct(p.cpuPct)),
            h('td', { style: S.td }, mb(p.workingSetMB)),
            h('td', { style: S.tdName, title: p.name }, String(p.name ?? '')))))),
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
          (r) => { setFix(r.prompt || ''); setBusy(false) },
          (e) => { setFix(`读取失败：${(e && e.message) || e}`); setBusy(false) }
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
          fix ? h('textarea', { style: S.ta, readOnly: true, value: fix }) : null))
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
