import { boundedReview } from './auto-review.js'
import { buildExecutionContext } from './review-context.js'
import { createBudget, createTurnBreaker } from './breaker.js'
import { fingerprint, sanitize } from './reviewer.js'

export const REVIEW_PRESET = 'codexlikereview'
const NO_WORKAROUND = 'Do not pursue the same outcome through another tool, indirect execution, or policy circumvention. Continue only with a materially safer alternative; otherwise stop and ask the user.'

/** Retains DSH confinement; only existing approval requests go to the reviewer. */
export function mountCodexLikeReview(ctx, configuration, reviewer, options = {}) {
  const presets = ctx.permissionPresets
  if (!presets?.presets || typeof presets.emitCatalogChanged !== 'function') throw new Error('codexlikereview requires desktop rc2 permission preset catalog')
  const spec = { sandbox: 'workspace-write', approval: 'ask', name: REVIEW_PRESET, description: '保留工作区沙箱；越权批准交由 Codex 风格审查，异常转人工。' }
  const lifetime = new AbortController(), pending = new Map(), turns = new WeakMap(), active = new Set()
  const budget = options.budget ?? createBudget(configuration)
  const key = (exec) => `${exec.agent?.session.id}\0${exec.callId}`
  const log = (message) => { try { ctx.logger?.info?.(`codexlikereview: ${message}`) } catch {} }
  function migrateLegacy(session) {
    // The old reserved Auto identity cannot be restored without registerAuto().
    // Migrate it before the host's own session/created permission initializer.
    if (presets.autoAdmit !== undefined || presets.permissionState?.(session)?.preset !== 'auto') return
    const policy = ctx.approval.overrideOf(session)
    presets.set(session, REVIEW_PRESET)
    if (policy === 'never') session.append('approval/policy', { policy: 'never' })
    log('migrated legacy Auto selection to workspace sandbox')
  }
  async function gate(exec, next) {
    if (!exec.agent || presets.current(exec.agent.session) !== REVIEW_PRESET) return next()
    if (lifetime.signal.aborted || exec.signal.aborted) return { kind: 'cancel' }
    if (pending.size >= 1000) return { kind: 'deny', reason: 'codexlikereview pending approval capacity exhausted.' }
    // Keep the exact frozen execution available for approval requests inside tool bodies.
    pending.set(key(exec), { exec })
    try { return await next() } catch (error) { pending.delete(key(exec)); throw error }
  }
  async function approve(req, next) {
    const session = req.agent?.session
    if (!session || presets.current(session) !== REVIEW_PRESET) return next()
    const entry = pending.get(`${session.id}\0${req.callId}`)
    if (!entry || entry.exec.name !== req.toolName) return next()
    const signal = AbortSignal.any([lifetime.signal, entry.exec.signal, ...(req.signal ? [req.signal] : [])])
    if (signal.aborted) return 'cancelled'
    // Duplicate approval requests for one execution cannot mint additional grants.
    if (entry.reviewed) return 'rejected'
    entry.reviewed = true
    const settings = { ...configuration }, done = Promise.withResolvers()
    active.add(done.promise)
    try {
      let action, reason
      try {
        action = buildExecutionContext(entry.exec, settings)
        action.context.approval_request = { reason: req.reason ?? null, execution_scope: 'one call only; session sandbox remains workspace-write' }
        const override = options.denials?.consume(action, session.id)
        if (override) action.context.explicit_user_override = override
      } catch { reason = 'context-unavailable' }
      let state = turns.get(session)
      if (action && (!state || state.turn !== action.turn)) { state = { turn: action.turn, breaker: createTurnBreaker(settings) }; turns.set(session, state) }
      if (state?.breaker.isOpen()) { entry.feedback = 'codexlikereview stopped automatic approval for this turn. '+NO_WORKAROUND; return 'rejected' }
      if (settings.reviewEnabled === false) reason = 'paused'
      if ((settings.onlyTools?.length && !settings.onlyTools.includes(req.toolName)) || settings.skipTools?.includes(req.toolName)) reason = 'tool-filtered'
      if (!reason && !budget.take()) reason = 'hourly-budget'
      const result = reason ? { status: 'unavailable', reason } : await boundedReview(reviewer, { ...action, reason: req.reason, reviewConfig: settings }, signal, settings.totalTimeoutMs)
      if (signal.aborted) return 'cancelled'
      const verdict = result.status === 'verdict' ? result.verdict : undefined
      // The template permits narrowly-scoped high risk with medium or high authorization.
      const actionable = verdict && ['low', 'medium', 'high', 'critical'].includes(verdict.riskLevel) && ['allow', 'deny'].includes(verdict.outcome)
        && (verdict.outcome === 'deny' || (verdict.riskLevel !== 'critical' && (verdict.riskLevel !== 'high' || ['medium', 'high'].includes(verdict.userAuthorization))))
      const outcome = actionable ? verdict.outcome : 'unavailable'
      log(`decision fp=${action ? fingerprint(action.toolName, action.argsText) : 'unknown'} tool=${req.toolName} outcome=${outcome} model=${result.meta?.model ?? 'unavailable'}`)
      try { options.onDecision?.({ fingerprint: action ? fingerprint(action.toolName, action.argsText) : null, tool: req.toolName, outcome, risk: actionable ? verdict.riskLevel : 'unknown', source: settings.reviewerSource, requestedModel: settings.reviewModel, model: result.meta?.model ?? null, reason: outcome === 'unavailable' ? result.reason ?? 'invalid-verdict' : null, elapsedMs: result.meta?.elapsedMs ?? null, totalTokens: result.meta?.totalTokens ?? null, investigationCalls: result.meta?.investigationCalls ?? 0 }) } catch {}
      if (outcome === 'deny') {
        const id = options.denials?.record(action, session.id, { ...verdict, rationale: sanitize(verdict.rationale) })
        entry.feedback = `codexlikereview rejected tool "${req.toolName}": ${sanitize(verdict.rationale)} ${NO_WORKAROUND}${id ? ` Denial ${id} can be selected in the plugin control page for one reviewed retry.` : ''}`
      }
      if (state?.breaker.record(outcome)) {
        entry.feedback ??= 'codexlikereview rejection circuit breaker interrupted this turn. '+NO_WORKAROUND
        req.agent.cancel?.({ kind: 'hook', reason: 'codexlikereview rejection circuit breaker' })
        return 'rejected'
      }
      if (outcome === 'deny') return 'rejected'
      if (outcome === 'allow') return 'allowed-once'
      // Reviewer failure is not a risk verdict. Human approval still uses the native seam.
      return next()
    } finally { active.delete(done.promise); done.resolve() }
  }
  async function feedback(exec, result, next) {
    const downstream = await next()
    const text = pending.get(key(exec))?.feedback
    return text && result.isError && downstream.kind === 'accept' ? { kind: 'block', feedback: [{ type: 'text', text }] } : downstream
  }
  return ctx.effect(function* () {
    yield ctx.on('tools/pre-execute', gate, { prepend: true })
    yield ctx.on('approval/request', approve, { prepend: true })
    yield ctx.on('tools/post-execute', feedback)
    yield ctx.on('tools/result', (exec) => { pending.delete(key(exec)) })
    if (Object.hasOwn(presets.presets, REVIEW_PRESET)) throw new Error('codexlikereview is already registered')
    // Like native Auto, this live integration is a current-session choice.
    // Do not offer it as a persisted default that is resolved before plugins load.
    const originalCatalog = presets.catalog
    if (typeof originalCatalog === 'function') {
      const catalog = function (...args) { const value = originalCatalog.apply(this, args); return { ...value, defaultOptions: value.defaultOptions.filter((v) => v.value !== REVIEW_PRESET) } }
      presets.catalog = catalog
      yield () => { if (Object.getOwnPropertyDescriptor(presets, 'catalog')?.value === catalog) presets.catalog = originalCatalog }
    }
    // The original table is the loader's config object; never mutate it in place.
    presets.presets = { ...presets.presets, [REVIEW_PRESET]: spec }; presets.emitCatalogChanged()
    yield () => { if (presets.presets[REVIEW_PRESET] === spec) { const { [REVIEW_PRESET]: removed, ...rest } = presets.presets; presets.presets = rest; presets.emitCatalogChanged() } }
    yield ctx.on('session/created', migrateLegacy, { prepend: true })
    for (const session of ctx.sessions.list()) migrateLegacy(session)
    yield async () => {
      lifetime.abort(); options.denials?.clear()
      for (const session of ctx.sessions.list()) if (presets.current(session) === REVIEW_PRESET || presets.permissionState?.(session)?.preset === REVIEW_PRESET) {
        const policy = ctx.approval.overrideOf(session)
        ctx.agents?.get?.(session.id)?.cancel?.({ kind: 'hook', reason: 'codexlikereview unloaded' })
        presets.set(session, 'workspace-write')
        if (policy === 'never') session.append('approval/policy', { policy: 'never' })
      }
      await Promise.allSettled([...active]); pending.clear()
    }
    log('mounted sandbox-boundary reviewer')
  }, 'codexlikereview lifecycle')
}
