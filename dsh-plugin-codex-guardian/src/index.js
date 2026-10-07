/** Independent replacement for DSH's experimental Auto integration. */
import { resolveConfig as approvalConfig } from './approvals.js'
import { loadGuardianPolicy } from './prompt.js'
import { createReviewer } from './reviewer.js'
import { mountCodexLikeReview } from './codexlike-review.js'
import { createDenials } from './denials.js'
import { createControlState, EDITABLE } from './control-state.js'
import { createBudget } from './breaker.js'
import { createHostReviewer } from './host-reviewer.js'

export const name = 'codex-guardian'
export const inject = ['approval', 'permissionPresets', 'sessions', 'tools', 'agents', 'llm', 'profileContext']
export { mountAutoReview } from './auto-review.js' // Compatibility entry for pre-0.4 integrations.
export { mountCodexLikeReview, REVIEW_PRESET } from './codexlike-review.js'
export const DEFAULTS = {
  ...EDITABLE,
  enabled: true, maxArgsChars: 32_000, maxContextChars: 100_000,
  maxReviewsPerHour: 120, breakerConsecutiveDenials: 3,
  breakerWindow: 50, breakerDenialsInWindow: 10,
}
export function resolveConfig(config) {
  const settings = approvalConfig({ ...DEFAULTS, ...(config ?? {}) })
  for (const key of ['maxArgsChars', 'maxContextChars', 'maxReviewsPerHour', 'breakerConsecutiveDenials', 'breakerWindow', 'breakerDenialsInWindow']) {
    if (!Number.isSafeInteger(settings[key]) || settings[key] <= 0) throw new Error(`codex-guardian: ${key} must be a positive integer`)
  }
  for (const key of ['timeoutMs', 'totalTimeoutMs', 'usageCacheMs']) {
    if (!Number.isFinite(settings[key]) || settings[key] <= 0) throw new Error(`codex-guardian: ${key} must be positive`)
  }
  if (!['auto', 'fetch', 'tunnel'].includes(settings.transport)) throw new Error('codex-guardian: unknown transport')
  return settings
}
export function apply(ctx, config) {
  const settings = resolveConfig(config)
  if (settings.enabled === false) return
  // Missing policy is a mount failure: never advertise an unprotected Auto preset.
  const policyBundle = loadGuardianPolicy(settings.policyFile)
  return install(ctx, settings, policyBundle)
}
async function install(ctx, settings, policyBundle) {
  const state = createControlState(settings, settings.controlFile ? { file: settings.controlFile } : {})
  const budget = createBudget(state.current), denials = createDenials()
  let cachedKey, cachedReviewer
  const reviewer = { review(action) {
    const config = { ...(action.reviewConfig ?? state.current), policyBundle }
    const key = JSON.stringify(action.reviewConfig ?? state.current)
    if (key !== cachedKey) {
      cachedReviewer = config.reviewerSource === 'dsh' ? createHostReviewer(config, ctx.llm) : createReviewer(config, ctx.logger)
      cachedKey = key
    }
    return cachedReviewer.review(action)
  } }
  const { installControlService } = await import('./control-service.js')
  await installControlService(ctx, state, reviewer, budget, denials)
  return mountCodexLikeReview(ctx, state.current, reviewer, { budget, denials, onDecision: (entry) => state.record(entry) })
}
