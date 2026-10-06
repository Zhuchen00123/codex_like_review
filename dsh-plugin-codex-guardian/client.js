/* Uses the host React runtime and authenticated Connection transport. */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-codex-guardian',
  factory(require) {
    const React = require('react'), h = React.createElement
    const { useState, useEffect, useRef } = React
    const errors = { 'settings-conflict': '配置已在其他页面更新，请重新载入后再保存。', 'provider-required': '请选择 DSH 供应商。', 'provider-unavailable': '这个 DSH 供应商当前不可用。', 'probe-busy': '连接测试正在进行。', 'probe-cooldown': '请等待 5 秒后再次测试。', 'budget-exhausted': '已达到每小时审查预算。', 'catalog-timeout': '模型列表加载超时。', 'control-operation-failed': '操作失败，请检查插件日志和配置文件权限。', 'invalid-breaker-window': '窗口内拒绝次数不能超过窗口大小。' }
    const css = `.guardian-control{color:inherit;max-width:960px}.guardian-control p{line-height:1.65;opacity:.8}.guardian-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin:18px 0}.guardian-field{display:flex;flex-direction:column;gap:7px;font-size:13px}.guardian-field input,.guardian-field select{box-sizing:border-box;width:100%;padding:9px 10px;background:transparent;color:inherit;border:1px solid #8886;border-radius:8px;font:inherit}.guardian-field select option{color:#202020;background:#fff}.guardian-actions{display:flex;flex-wrap:wrap;gap:10px;margin:16px 0}.guardian-control button{font:inherit;border:1px solid #8886;border-radius:8px;padding:8px 13px;background:transparent;color:inherit;cursor:pointer}.guardian-control button:disabled{opacity:.45;cursor:default}.guardian-control button[data-primary]{background:#3975bd;color:white;border-color:#3975bd}.guardian-control details{border-top:1px solid #8884;padding:14px 0}.guardian-control summary{cursor:pointer}.guardian-status{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.guardian-badge{border:1px solid #8885;border-radius:20px;padding:4px 10px;font-size:12px}.guardian-table{overflow:auto}.guardian-table table{width:100%;border-collapse:collapse;font-size:12px;white-space:nowrap}.guardian-table th,.guardian-table td{padding:9px 10px;text-align:left;border-bottom:1px solid #8883}.guardian-notice{padding:10px 12px;border-radius:8px;background:#8881;margin:12px 0;overflow-wrap:anywhere}.guardian-error{background:#c6434318;color:inherit}.guardian-checkbox{display:flex;align-items:center;gap:8px;margin:12px 0}.guardian-control :focus-visible{outline:2px solid #3975bd;outline-offset:2px}`
    function apply(ctx) {
      function Card(props) {
        if (props.view === 'summary') return '选择 Codex 订阅或 DSH 模型，管理 Auto 审查与连接测试。'
        return h(Control)
      }
      function Control() {
        const [snapshot, setSnapshot] = useState(null), [draft, setDraft] = useState(null), [catalog, setCatalog] = useState(null)
        const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('')
        const dirty = useRef(false), draftRevision = useRef(null), lifetime = useRef(null)
        async function rpc(method, payload = {}) {
          const result = await ctx.connection.rpc.call('/api', `guardianControl/${method}`, { args: payload }, lifetime.current?.signal)
          if (!result.ok) throw new Error(result.error?.message || 'control-operation-failed')
          return result.value
        }
        function accept(value, overwrite = false) { setSnapshot(value); if (overwrite || !dirty.current) { setDraft(value.settings); draftRevision.current = value.revision; dirty.current = false } }
        async function load() { accept(await rpc('status'), true) }
        useEffect(() => {
          const controller = new AbortController(); lifetime.current = controller
          load().catch((e) => { if (!controller.signal.aborted) setError(e.message) })
          rpc('models', { refresh: false }).then(setCatalog).catch(() => {})
          const interval = setInterval(() => rpc('status').then((value) => { if (!controller.signal.aborted) accept(value) }).catch(() => {}), 5000)
          return () => { controller.abort(); clearInterval(interval) }
        }, [])
        function edit(key, value) { dirty.current = true; setDraft((old) => ({ ...old, [key]: value })); setNotice('') }
        async function operation(kind, fn) {
          setBusy(kind); setError(''); setNotice('')
          try { await fn() } catch (e) { if (!lifetime.current?.signal.aborted) setError(errors[e.message] ?? (e.message.startsWith('invalid-setting:') ? `配置值不合法：${e.message.split(':')[1]}` : '操作失败，请重试或查看插件日志。')) }
          finally { if (!lifetime.current?.signal.aborted) setBusy('') }
        }
        const field = (label, key, type = 'text', extra = {}) => h('label', { className: 'guardian-field', key: `input-${key}` }, label, h('input', { value: draft[key], type, ...extra, onChange: (event) => edit(key, type === 'number' ? Number(event.target.value) : event.target.value), disabled: !!busy }))
        const select = (label, key, options, onChange) => h('label', { className: 'guardian-field', key: `select-${key}` }, label, h('select', { value: draft[key], disabled: !!busy, onChange: (event) => onChange ? onChange(event.target.value) : edit(key, event.target.value) }, options.map(([id, text]) => h('option', { value: id, key: id }, text))))
        const button = (label, kind, fn, primary) => h('button', { type: 'button', disabled: !!busy, 'data-primary': primary || undefined, onClick: () => operation(kind, fn) }, busy === kind ? '处理中…' : label)
        if (!draft || !snapshot) return h('div', { className: 'guardian-control' }, h('p', null, '正在加载 Guardian 控制页…'), error && h('div', { role: 'alert' }, error), h('button', { onClick: () => operation('load', load), disabled: !!busy }, '重新载入'))
        const models = (catalog?.models ?? []).filter((v) => v.source === draft.reviewerSource && (v.source !== 'dsh' || v.provider === draft.reviewProvider))
        const providers = [...new Set([...(catalog?.providers ?? []).map((v) => v.id), ...(catalog?.models ?? []).filter((v) => v.source === 'dsh').map((v) => v.provider)])]
        if (draft.reviewProvider && !providers.includes(draft.reviewProvider)) providers.push(draft.reviewProvider)
        const modelOptions = models.map((v) => [v.id, `${v.name} · ${v.id}`])
        if (!modelOptions.some(([id]) => id === draft.reviewModel)) modelOptions.unshift([draft.reviewModel, draft.reviewModel + '（自定义 ID）'])
        function route(source) {
          const first = (catalog?.models ?? []).find((v) => v.source === source)
          dirty.current = true; setDraft((old) => ({ ...old, reviewerSource: source, reviewProvider: source === 'dsh' ? first?.provider ?? '' : '', reviewModel: source === 'codex' ? 'codex-auto-review' : first?.id ?? old.reviewModel }))
        }
        const unavailable = snapshot.warning ? h('div', { className: 'guardian-notice', role: 'status' }, snapshot.warning === 'stored-settings-invalid' ? '已保存配置无法读取，当前使用插件默认配置。' : '审查记录写入失败，请检查文件权限。') : null
        return h('div', { className: 'guardian-control' }, h('style', null, css),
          h('div', { className: 'guardian-status' }, h('strong', null, 'Codex Guardian'), h('span', { className: 'guardian-badge' }, snapshot.settings.reviewEnabled ? '自动审查已启用' : '已暂停 · 转人工审批'), h('span', { className: 'guardian-badge' }, `本小时 ${snapshot.budgetUsed}/${snapshot.settings.maxReviewsPerHour} 次`)),
          h('p', null, '在权限菜单选择 Auto 后生效。保存后从下一次审查应用；运行中的审查使用启动时的配置。'),
          unavailable, error && h('div', { className: 'guardian-notice guardian-error', role: 'alert' }, error), notice && h('div', { className: 'guardian-notice', role: 'status' }, notice),
          h('label', { className: 'guardian-checkbox' }, h('input', { type: 'checkbox', checked: draft.reviewEnabled, disabled: !!busy, onChange: (e) => edit('reviewEnabled', e.target.checked) }), '启用自动审查（取消后转人工审批）'),
          h('div', { className: 'guardian-grid' }, select('模型来源', 'reviewerSource', [['codex', 'Codex 订阅模型'], ['dsh', 'DSH 已配置模型']], route),
            draft.reviewerSource === 'dsh' && select('DSH 供应商', 'reviewProvider', [['', '请选择供应商'], ...providers.map((id) => [id, id])], (provider) => { const first = catalog?.models.find((v) => v.source === 'dsh' && v.provider === provider); dirty.current = true; setDraft((old) => ({ ...old, reviewProvider: provider, reviewModel: first?.id ?? old.reviewModel })) }),
            select('可用模型', 'reviewModel', modelOptions), field('模型 ID（可手动填写）', 'reviewModel'),
            select('推理强度', 'reasoningEffort', ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((v) => [v, v === 'default' ? '模型默认' : v]))),
          h('p', null, '模型费用与额度按对应账号或供应商规则计算。自定义模型需要支持 Guardian JSON 审查；不可用或格式错误时转人工审批。'),
          h('details', null, h('summary', null, '超时、预算与拒绝限制'), h('div', { className: 'guardian-grid' }, field('单次请求超时（毫秒）', 'timeoutMs', 'number', { min: 1, max: 120000 }), field('总审查超时（毫秒）', 'totalTimeoutMs', 'number', { min: 1, max: 180000 }), field('重试次数', 'retries', 'number', { min: 0, max: 1 }), field('每小时最多审查次数', 'maxReviewsPerHour', 'number', { min: 1, max: 10000 }), field('连续拒绝上限', 'breakerConsecutiveDenials', 'number', { min: 1, max: 100 }), field('拒绝统计窗口', 'breakerWindow', 'number', { min: 1, max: 1000 }), field('窗口内拒绝上限', 'breakerDenialsInWindow', 'number', { min: 1, max: 1000 }), field('订阅额度停止阈值（%）', 'usageStopPercent', 'number', { min: 1, max: 100 })), h('label', { className: 'guardian-checkbox' }, h('input', { type: 'checkbox', checked: draft.usageGuard, disabled: !!busy, onChange: (e) => edit('usageGuard', e.target.checked) }), '检查 Codex 订阅额度（仅适用于 Codex 来源）')),
          h('div', { className: 'guardian-actions' }, button('保存配置', 'save', async () => { accept(await rpc('save', { patch: draft, expectedRevision: draftRevision.current }), true); setNotice('已保存，下一次审查生效。') }, true), button('放弃修改 / 重新载入', 'load', load), button('恢复默认值', 'defaults', async () => { dirty.current = true; draftRevision.current = snapshot.revision; setDraft({ ...snapshot.defaults }); setNotice('已填入默认值，点击保存后生效。') })),
          h('div', { className: 'guardian-actions' }, button('测试已保存模型', 'probe', async () => { const result = await rpc('probe'); setNotice(result.status === 'verdict' ? `连接成功 · ${result.model} · ${result.outcome} · ${result.elapsedMs ?? '—'} ms` : `连接未通过：${result.reason ?? 'unknown'}；实际工具调用会转人工审批。`); accept(await rpc('status')) }), button('刷新模型列表', 'models', async () => { const value = await rpc('models', { refresh: true }); setCatalog(value); setNotice(`模型列表已更新 · Codex: ${value.codexStatus} · DSH: ${value.dshStatus}`) })),
          h('p', null, '连接测试只发送合成的 git status 审查请求，不执行命令；占用一次审查预算。刷新模型列表会尝试读取订阅模型目录。'),
          h('details', { open: true }, h('summary', null, `最近审查 · 允许 ${snapshot.counters.allow} / 拒绝 ${snapshot.counters.deny} / 转人工 ${snapshot.counters.unavailable}`),
            h('p', null, '统计基于最近 200 条记录，下面显示最近 20 条。只保留工具名称和决策元数据。'),
            snapshot.recent.length ? h('div', { className: 'guardian-table' }, h('table', null, h('thead', null, h('tr', null, ['时间', '工具', '结果', '模型', '耗时', 'Token'].map((title) => h('th', { key: title, scope: 'col' }, title)))), h('tbody', null, snapshot.recent.slice(0, 20).map((row, index) => h('tr', { key: `${row.time}-${index}` }, [new Date(row.time).toLocaleTimeString(), row.tool, row.outcome === 'allow' ? '允许' : row.outcome === 'deny' ? '拒绝' : `转人工 (${row.reason ?? 'unknown'})`, row.model ?? row.requestedModel, row.elapsedMs == null ? '—' : `${row.elapsedMs} ms`, row.totalTokens ?? '—'].map((value, i) => h('td', { key: i }, value))))))) : h('p', null, '暂无审查记录。'), button('清空审查记录', 'clear', async () => { accept(await rpc('clearHistory')); setNotice('审查记录已清空。') })))
      }
      ctx.effect(() => ctx.locale.register('guardian.control', { zh: { title: 'Codex Guardian' }, en: { title: 'Codex Guardian' } }))
      ctx.effect(() => ctx.slots.inject('plugins.item', () => ctx.slots.register({ name: 'plugins.item', id: 'codex-guardian', order: 35, label: () => 'Codex Guardian', locale: 'guardian.control' }, Card)))
    }
    return { inject: ['slots', 'locale', 'connection'], apply }
  },
})
