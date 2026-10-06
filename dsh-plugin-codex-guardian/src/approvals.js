/**
 * dsh-plugin-codex-guardian — answer DSH approval requests with Codex's own
 * auto-review model.
 *
 * Registers one `approval/request` waterfall listener. Returning an outcome
 * claims the request; calling `next()` delegates to the answerer composed after
 * it (the human UI). The plugin never fails closed on its own behalf: every
 * abnormal path — disabled, no credential, network failure, timeout, malformed
 * response, low confidence, breaker open — calls `next()` so the human still gets
 * the prompt.
 *
 * Zero runtime dependencies: only `node:` builtins. It deliberately does NOT go
 * through `ctx.llm`: `codex-auto-review` is `visibility: "hide"`, so
 * `dsh-codex-subscription`'s `visibleModel()` filters it out of the model registry
 * and `PiAiAdapter.modelOf()` would throw `UNKNOWN_MODEL`. This plugin speaks
 * HTTPS to `chatgpt.com` itself instead, which also keeps it free of any provider
 * id conflict with the subscription plugin.
 *
 * @module dsh-plugin-codex-guardian
 */
import { createBreaker, createBudget } from './breaker.js'
import { loadGuardianPolicy } from './prompt.js'
import { createReviewer, fingerprint, sanitize } from './reviewer.js'
import { createPendingCalls, readEnvironment, readPendingAction, readTrustedTurns } from './session-context.js'

/** Plugin id in the composed tree. */
export const name = 'codex-guardian'

/** The approval seam must exist for this answerer to have anything to answer. */
export const inject = ['approval']

/** Defaults for every knob; `config` in the patch layer overrides them. */
export const DEFAULTS = {
  /** Master switch. `false` unmounts the listener entirely. */
  enabled: true,
  /** Restrict review to these tool names (empty = every tool that asks). */
  onlyTools: [],
  /** Never review these tool names. */
  skipTools: [],
  /** Guardian policy bundle (`data/guardian-policy.json` by default). */
  policyFile: undefined,
  /**
   * `policy_template` (the OpenAI judge prompt with the policy substituted) or
   * `policy_only` (the policy text alone).
   */
  promptMode: 'policy_template',
  /** Credential file override; default search order is DSH store → Codex CLI store. */
  credentialFile: undefined,
  /** `auto` | `tunnel` | `fetch`. */
  transport: 'auto',
  /** CONNECT proxy used by the `tunnel` path. */
  proxy: { host: '127.0.0.1', port: 7897 },
  /** Per-attempt HTTP timeout. */
  timeoutMs: 20_000,
  /** Overall deadline across attempts. */
  totalTimeoutMs: 28_000,
  /** Extra attempts after the first failure (capped at 1). */
  retries: 1,
  /** Trusted user/developer turns included as authorization evidence. */
  maxTrustedTurns: 6,
  maxTrustedChars: 6_000,
  /** Bound on the reviewed action's argument text. */
  maxArgsChars: 8_000,
  /** Accepted risk levels for an `allow` verdict; anything else delegates. */
  allowRiskLevels: ['low', 'medium'],
  /** A `deny` verdict at these levels is honored; below them it delegates. */
  denyRiskLevels: ['high', 'critical'],
  /** Breaker + budget. */
  breakerConsecutiveDenials: 5,
  breakerWindow: 20,
  breakerMinSamples: 8,
  breakerDenialRate: 0.8,
  breakerCooldownMs: 300_000,
  maxReviewsPerHour: 120,
  /** Optional guard on the subscription's rate-limit windows. */
  usageGuard: false,
  usageStopPercent: 90,
  usageCacheMs: 60_000,
}

/** @param {unknown} value */
function stringList(value) {
  if (!Array.isArray(value)) return []
  return value.filter((entry) => typeof entry === 'string' && entry !== '')
}

/**
 * Merge user config over the defaults, normalizing the list/object knobs.
 * @param {Record<string, any>|undefined} config
 */
export function resolveConfig(config) {
  const merged = { ...DEFAULTS, ...(config ?? {}) }
  merged.onlyTools = stringList(merged.onlyTools)
  merged.skipTools = stringList(merged.skipTools)
  merged.allowRiskLevels = stringList(merged.allowRiskLevels)
  merged.denyRiskLevels = stringList(merged.denyRiskLevels)
  merged.proxy = { ...DEFAULTS.proxy, ...(typeof merged.proxy === 'object' && merged.proxy !== null ? merged.proxy : {}) }
  return merged
}

/**
 * @param {{toolName?: string}} req
 * @param {Record<string, any>} config
 * @returns {boolean}
 */
function toolSelected(req, config) {
  const toolName = req?.toolName
  if (typeof toolName !== 'string' || toolName === '') return false
  if (config.skipTools.includes(toolName)) return false
  if (config.onlyTools.length > 0 && !config.onlyTools.includes(toolName)) return false
  return true
}

/**
 * Mount the answerer.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, any>} [config]
 */
export function apply(ctx, config) {
  const settings = resolveConfig(config)
  /** @type {{info?: Function, debug?: Function, warn?: Function}} */
  const logger = ctx?.logger ?? {}
  const log = (level, message) => {
    try {
      logger[level]?.(`codex-guardian: ${message}`)
    } catch {
      /* logger must never break an approval */
    }
  }

  if (settings.enabled === false) {
    log('info', 'disabled by config')
    return
  }

  let policyBundle
  try {
    policyBundle = loadGuardianPolicy(settings.policyFile)
  } catch (error) {
    log('warn', `guardian policy unavailable (${error?.message ?? error}); approvals delegate to the human answerer`)
    return
  }

  const reviewer = createReviewer({ ...settings, policyBundle }, logger)
  const breaker = createBreaker(settings)
  const budget = createBudget(settings)
  const pending = createPendingCalls()
  log('info', `mounted: model=codex-auto-review transport=${settings.transport} policy=${policyBundle.policy.length} chars timeout=${settings.timeoutMs}ms`)

  // Capture every dispatched call with its already-parsed arguments. Transparent:
  // this listener always delegates, and `tools/pre-execute` runs before the
  // approval ask on the same sequential path.
  ctx.on('tools/pre-execute', (exec, next) => {
    try {
      pending.remember(exec)
    } catch (error) {
      log('debug', `pre-execute capture skipped: ${error?.message ?? error}`)
    }
    return next()
  })

  ctx.on('approval/request', async (req, next) => {
    try {
      if (!toolSelected(req, settings)) return await next()
      if (breaker.isOpen()) {
        log('info', `breaker open (${breaker.reason()}, ${Math.ceil(breaker.remainingMs() / 1000)}s left); delegating`)
        return await next()
      }
      if (!budget.take()) {
        log('warn', `hourly review budget exhausted (${settings.maxReviewsPerHour}); delegating`)
        return await next()
      }

      const session = req?.agent?.session
      const action = readPendingAction(session, req?.callId, { toolName: req?.toolName, pending })
      if (action === undefined) {
        log('debug', `no tool/call in the session log for "${req?.toolName}" (callId=${req?.callId ?? 'none'}); delegating`)
        return await next()
      }

      const fp = fingerprint(action.toolName, action.argsText)
      const trusted = readTrustedTurns(session, {
        maxMessages: settings.maxTrustedTurns,
        maxChars: settings.maxTrustedChars,
      })
      const result = await reviewer.review({
        toolName: action.toolName,
        argsText: action.argsText,
        reason: req?.reason,
        trusted,
        environment: readEnvironment(req?.agent),
        signal: req?.signal,
      })

      if (result.status !== 'verdict') {
        log('info', `delegate fp=${fp} tool=${action.toolName} reason=${result.reason} detail=${result.detail ?? ''}`)
        return await next()
      }

      const { verdict, meta } = result
      const summary = `fp=${fp} tool=${action.toolName} outcome=${verdict.outcome} risk=${verdict.riskLevel} auth=${verdict.userAuthorization} http=${meta.httpStatus} ${meta.elapsedMs}ms tokens=${meta.totalTokens ?? '?'}`
      if (verdict.outcome === 'allow' && settings.allowRiskLevels.includes(verdict.riskLevel)) {
        breaker.record('allow')
        log('info', `allow ${summary}`)
        return 'allowed-once'
      }
      if (verdict.outcome === 'deny' && settings.denyRiskLevels.includes(verdict.riskLevel)) {
        breaker.record('deny')
        log('info', `deny ${summary} rationale=${sanitize(verdict.rationale)}`)
        return 'rejected'
      }
      log(
        'info',
        `delegate (outcome/risk combination not actionable) ${summary} rationale=${sanitize(verdict.rationale)}`,
      )
      return await next()
    } catch (error) {
      log('warn', `reviewer error (${sanitize(error?.message ?? error)}); delegating`)
      try {
        return await next()
      } catch (nested) {
        log('warn', `next() failed: ${sanitize(nested?.message ?? nested)}`)
        return 'unavailable'
      }
    }
  })
}
