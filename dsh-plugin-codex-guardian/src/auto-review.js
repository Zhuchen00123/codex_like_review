import { createBudget, createTurnBreaker } from './breaker.js'
import { buildExecutionContext } from './review-context.js'
import { fingerprint, sanitize } from './reviewer.js'

const NO_WORKAROUND = 'Do not pursue the same outcome through another tool, indirect execution, or policy circumvention. Continue only with a materially safer alternative; otherwise stop and ask the user.'
function denied(exec, rationale) {
  return {
    kind: 'deny',
    reason: `Codex Guardian rejected tool "${exec.name}"; its body was not executed. ${sanitize(rationale)} ${NO_WORKAROUND}`,
    info: { name: 'GuardianReviewDeniedError', code: 'GUARDIAN_REVIEW_DENIED' },
  }
}
function ask(exec, reason) {
  return {
    kind: 'ask',
    reason: `Codex Guardian could not decide tool "${exec.name}" (${reason}); human approval required. A reviewer failure is not a verdict that this action is unsafe.`,
    displayReason: { en: 'Codex Guardian could not complete review. Approve this action manually?', zh: 'Codex Guardian 未完成审查，需要你确认本次操作。' },
  }
}

/** Race the whole reviewer (including quota checks) against cancellation and deadline. */
export async function boundedReview(reviewer, action, signal, timeoutMs) {
  if (signal.aborted) return { status: 'unavailable', reason: 'aborted' }
  const deadline = AbortSignal.timeout(timeoutMs)
  const combined = AbortSignal.any([signal, deadline])
  return new Promise((resolve) => {
    const onAbort = () => finish({ status: 'unavailable', reason: signal.aborted ? 'aborted' : 'timeout' })
    const finish = (value) => { combined.removeEventListener('abort', onAbort); resolve(value) }
    combined.addEventListener('abort', onAbort, { once: true })
    Promise.resolve().then(() => reviewer.review({ ...action, signal: combined })).then(finish, () => finish({ status: 'unavailable', reason: 'reviewer-error' }))
  })
}

async function downstreamDecision(next, signal) {
  if (signal.aborted) return { kind: 'cancel' }
  return new Promise((resolve, reject) => {
    const onAbort = () => finish({ kind: 'cancel' })
    const finish = (value) => { signal.removeEventListener('abort', onAbort); resolve(value) }
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve().then(next).then(finish, (error) => { signal.removeEventListener('abort', onAbort); reject(error) })
  })
}

/** Production and test entry point. Only apply() creates the real network reviewer. */
export function mountAutoReview(ctx, configuration, reviewer, options = {}) {
  const presets = ctx.permissionPresets
  if (typeof presets?.registerAuto !== 'function') throw new Error('codex-guardian requires a DSH host with permissionPresets.registerAuto()')
  const lifecycle = new AbortController()
  let accepting = true
  const active = new Set()
  const turns = new WeakMap()
  const budget = options.budget ?? createBudget(configuration)
  const log = (message) => { try { ctx.logger?.info?.(`codex-guardian: ${message}`) } catch {} }

  async function gate(exec, next) {
    const settings = { ...configuration }
    const agent = exec.agent
    if (!agent || presets.current(agent.session) !== 'auto') return next()
    if (!accepting || lifecycle.signal.aborted || exec.signal.aborted) return { kind: 'cancel' }
    // DSH's PTC transport has its own capability fence; each actual inner call is reviewed.
    if (exec.parent === undefined && exec.name === 'run_code') return next()
    const signal = AbortSignal.any([exec.signal, lifecycle.signal])
    const completed = Promise.withResolvers()
    active.add(completed.promise)
    try {
      let action, fallback
      try { action = buildExecutionContext(exec, settings) } catch { fallback = 'context-unavailable' }
      let state
      if (action) {
        state = turns.get(agent.session)
        if (!state || state.turn !== action.turn) {
          state = { turn: action.turn, breaker: createTurnBreaker(settings) }
          turns.set(agent.session, state)
        }
        if (state.breaker.isOpen()) return denied(exec, 'The rejection circuit breaker stopped automatic execution for this turn.')
      }
      if ((settings.onlyTools?.length && !settings.onlyTools.includes(exec.name)) || settings.skipTools?.includes(exec.name)) fallback = 'tool-filtered'
      if (settings.reviewEnabled === false) fallback = 'paused'
      if (!fallback && !budget.take()) fallback = 'hourly-budget'
      const result = fallback ? { status: 'unavailable', reason: fallback }
        : await boundedReview(reviewer, { ...action, reviewConfig: settings }, signal, settings.totalTimeoutMs)
      if (signal.aborted || !accepting) return { kind: 'cancel' }
      const verdict = result?.status === 'verdict' ? result.verdict : undefined
      // Critical must never grant. High allows require an explicit high-authorization assessment.
      const actionable = verdict && ['low', 'medium', 'high', 'critical'].includes(verdict.riskLevel)
        && (verdict.outcome === 'deny' || (verdict.outcome === 'allow' && verdict.riskLevel !== 'critical'
          && (verdict.riskLevel !== 'high' || verdict.userAuthorization === 'high')))
      const outcome = actionable ? verdict.outcome : 'unavailable'
      const fp = action ? fingerprint(action.toolName, action.argsText) : 'unknown'
      log(`decision fp=${fp} tool=${exec.name} outcome=${outcome} risk=${actionable ? verdict.riskLevel : 'unknown'} model=${result.meta?.model ?? 'unavailable'}`)
      try { options.onDecision?.({ fingerprint: fp, tool: exec.name, outcome, risk: actionable ? verdict.riskLevel : 'unknown', source: settings.reviewerSource ?? 'codex', requestedModel: settings.reviewModel ?? 'codex-auto-review', model: result.meta?.model ?? null, reason: outcome === 'unavailable' ? result.reason ?? 'invalid-verdict' : null, elapsedMs: result.meta?.elapsedMs ?? null, totalTokens: result.meta?.totalTokens ?? null }) } catch {}
      if (state?.breaker.record(outcome)) {
        log(`rejection breaker interrupted turn=${state.turn}`)
        agent.cancel?.({ kind: 'hook', reason: 'codex-guardian rejection circuit breaker' })
        return denied(exec, 'Too many rejected actions in this turn. Stop and ask the user.')
      }
      if (outcome === 'deny') return denied(exec, verdict.rationale)
      // Never override a deny/cancel/ask produced by another host policy.
      const downstream = await downstreamDecision(next, signal)
      if (signal.aborted || !accepting) return { kind: 'cancel' }
      if (downstream.kind !== 'allow') return downstream
      return outcome === 'allow' ? downstream : ask(exec, result?.reason ?? 'invalid-verdict')
    } catch {
      // A broken downstream hook must not be re-entered or treated as permission to run.
      if (signal.aborted || !accepting) return { kind: 'cancel' }
      return { kind: 'deny', reason: `Guardian integration for tool "${exec.name}" failed; its body was not executed. Fix the failing host hook before retrying. This failure is not a Guardian risk verdict.`, info: { name: 'GuardianIntegrationError', code: 'GUARDIAN_INTEGRATION_FAILED' } }
    } finally {
      active.delete(completed.promise)
      completed.resolve()
    }
  }

  // Reverse-order disposal: cancel/reset/drain, remove Auto, then remove the gate.
  return ctx.effect(function* () {
    yield ctx.on('tools/pre-execute', gate, { prepend: true })
    yield presets.registerAuto(() => {
      if (!accepting) throw new Error('codex-guardian: integration is closing')
    })
    if (typeof presets.resolve === 'function' && presets.resolve('auto').approval !== 'ask') {
      throw new Error('codex-guardian requires the desktop rc2 Auto preset with ask policy; this host uses never')
    }
    yield async () => {
      accepting = false
      lifecycle.abort()
      let recoveryError
      for (const session of ctx.sessions.list()) {
        try {
          if (presets.current(session) !== 'auto') continue
          const policy = ctx.approval.overrideOf(session)
          const agent = ctx.agents?.get?.(session.id)
          agent?.cancel?.({ kind: 'hook', reason: 'codex-guardian integration unloaded' })
          presets.set(session, 'workspace-write')
          // A delegated child that disallows questions must retain that restriction.
          if (policy === 'never') session.append('approval/policy', { policy: 'never' })
        } catch (error) { recoveryError ??= error }
      }
      await Promise.allSettled([...active])
      if (recoveryError) throw recoveryError
    }
    log('mounted independent Auto reviewer')
  }, 'codex-guardian Auto lifecycle')
}
