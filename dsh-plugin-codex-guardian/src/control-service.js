import { boundedReview } from './auto-review.js'
import { listReviewModels } from './model-catalog.js'
import { createRequire } from 'node:module'

// The host's authenticated Connection/Gateway owns access and request cancellation.
// No additional HTTP listener or credential-bearing settings endpoint is created.
export async function installControlService(ctx, state, reviewer, budget) {
  // Resolve host-owned types from its installation anchor, including source-file mounts.
  const anchor = ctx.profileContext?.installAnchor ?? import.meta.url
  const { Remote, RemoteError, TypertRemoteService } = createRequire(anchor)('@deepseek-ai/dsh-typert-protocol')
  const initializers = [], lifetime = new AbortController()
  let probing = false, lastProbe = 0
  ctx.effect(() => () => lifetime.abort())
  function safeError(error) {
    const message = String(error?.message ?? '')
    const known = /^(settings-conflict|provider-required|provider-unavailable|invalid-breaker-window|invalid-settings|invalid-setting:[A-Za-z]+|unknown-setting:[A-Za-z]+|probe-busy|probe-cooldown|budget-exhausted|catalog-timeout)$/
    return new RemoteError('GUARDIAN_CONTROL', known.test(message) ? message : 'control-operation-failed', {})
  }
  class GuardianControl extends TypertRemoteService {
    constructor() { super(ctx, 'guardianControl'); for (const init of initializers) init.call(this) }
    status() { return { ...state.view(), budgetUsed: budget.used(), defaults: (this.defaults) } }
    async models(refresh, signal) {
      if (typeof refresh !== 'boolean') throw safeError(new Error('invalid-settings'))
      const bounded = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : []), AbortSignal.timeout(20000)])
      let remove = () => {}
      try {
        return await Promise.race([listReviewModels({ ...state.current }, ctx.llm, refresh, bounded), new Promise((_, reject) => {
          const abort = () => reject(new Error('catalog-timeout'))
          remove = () => bounded.removeEventListener('abort', abort)
          bounded.addEventListener('abort', abort, { once: true }); if (bounded.aborted) abort()
        })])
      } catch (error) { throw safeError(error) } finally { remove() }
    }
    save(patch, expectedRevision) {
      try {
        const provider = patch?.reviewProvider ?? state.current.reviewProvider
        if ((patch?.reviewerSource ?? state.current.reviewerSource) === 'dsh' && provider && !ctx.llm.listProviders().some((v) => v.id === provider)) throw new Error('provider-unavailable')
        state.save(patch, expectedRevision); return this.status()
      } catch (error) { throw safeError(error) }
    }
    async probe(signal) {
      if (probing) throw safeError(new Error('probe-busy'))
      if (Date.now()-lastProbe < 5000) throw safeError(new Error('probe-cooldown'))
      if (!budget.take()) throw safeError(new Error('budget-exhausted'))
      const settings = { ...state.current }
      probing = true; lastProbe = Date.now()
      try {
        const result = await boundedReview(reviewer, {
          toolName: 'bash', argsText: '{"command":"git status --short"}',
          trusted: ['[user] Inspect the working tree with git status. This is a synthetic connection test; do not execute any command.'],
          environment: { cwd: process.cwd(), platform: process.platform, workspaceRoots: [process.cwd()] }, reviewConfig: settings,
        }, AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]), settings.totalTimeoutMs)
        return { status: result.status, reason: result.reason ?? null, outcome: result.verdict?.outcome ?? null, model: result.meta?.model ?? null, elapsedMs: result.meta?.elapsedMs ?? null, totalTokens: result.meta?.totalTokens ?? null }
      } finally { probing = false }
    }
    clearHistory() { try { state.clearHistory(); return this.status() } catch (error) { throw safeError(error) } }
  }
  const { EDITABLE } = await import('./control-state.js')
  GuardianControl.prototype.defaults = { ...EDITABLE }
  for (const name of ['status', 'models', 'save', 'probe', 'clearHistory']) Remote(GuardianControl.prototype[name], { kind: 'method', name, private: false, static: false, addInitializer(fn) { initializers.push(fn) } })
  return new GuardianControl()
}
