/**
 * The reviewer: one Guardian decision per approval request.
 *
 * Contract: `review()` NEVER decides by accident. It returns either a parsed
 * verdict or an `unavailable` outcome with a reason code; every failure mode
 * (no credential, expired token, network, timeout, HTTP error, malformed SSE,
 * unparseable JSON, quota guard) resolves to `unavailable` so the caller can
 * delegate to the human answerer.
 *
 * @module dsh-plugin-codex-guardian/reviewer
 */
import { createHash, randomUUID } from 'node:crypto'
import { readCredential } from './credentials.js'
import { createTransport, parseSse, TransportError } from './transport.js'
import { buildInstructions, buildReviewInput, parseVerdict } from './prompt.js'
import { createInvestigator, INVESTIGATION_INSTRUCTIONS } from './investigation.js'

/** The route the Codex CLI uses for Guardian. */
export const REVIEW_URL = 'https://chatgpt.com/backend-api/codex/responses'
/** The usage endpoint, used only for the optional quota guard. */
export const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
/** Server-side model slug. */
export const REVIEW_MODEL = 'codex-auto-review'

/** Per-process session id for the route; the server only uses it for correlation. */
const SESSION_ID = randomUUID()

/**
 * Remove anything token-shaped from a message before it can reach a log.
 * @param {unknown} value
 * @returns {string}
 */
export function sanitize(value) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  return text
    .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g, '<redacted-jwt>')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1<redacted>')
    .slice(0, 400)
}

/**
 * Stable, non-reversible fingerprint of the action under review. Logged instead
 * of the arguments, which may carry secrets.
 * @param {string} toolName
 * @param {string} argsText
 * @returns {string}
 */
export function fingerprint(toolName, argsText) {
  return createHash('sha256').update(`${toolName}\n${argsText}`).digest('hex').slice(0, 12)
}

/**
 * Turn one buffered SSE body into `{ text, model, usage, failure }`.
 * @param {string} body
 */
export function readStream(body) {
  const text = []
  const toolCalls = new Map(), started = new Set()
  let model
  let usage
  let failure
  let completed = false
  function collect(item) {
    if (item?.type !== 'function_call') return
    if (typeof item.call_id !== 'string' || typeof item.name !== 'string' || typeof item.arguments !== 'string') { failure = { message: 'invalid function call' }; return }
    const call = { type: 'function_call', call_id: item.call_id, name: item.name, arguments: item.arguments }
    if (toolCalls.has(call.call_id) && JSON.stringify(toolCalls.get(call.call_id)) !== JSON.stringify(call)) failure = { message: 'conflicting function call' }
    toolCalls.set(call.call_id, call)
  }
  for (const payload of parseSse(body)) {
    let event
    try {
      event = JSON.parse(payload)
    } catch {
      continue
    }
    const type = event?.type
    if (type === 'response.output_text.delta' && typeof event.delta === 'string') text.push(event.delta)
    else if (type === 'response.output_item.added' && event.item?.type === 'function_call') started.add(event.item.call_id)
    else if (type === 'response.output_item.done') collect(event.item)
    else if (type === 'response.completed') {
      completed = true
      model = event.response?.model ?? model
      usage = event.response?.usage ?? usage
      for (const item of event.response?.output ?? []) {
        if (item.type === 'function_call') collect(item)
        else if (item.type?.endsWith('_call')) failure = { message: 'unexpected built-in review tool' }
      }
    } else if (type === 'response.failed' || type === 'response.incomplete' || type === 'response.error' || type === 'error') {
      failure = event.response?.error ?? event.error ?? event
    }
  }
  if ([...started].some((id) => !toolCalls.has(id))) failure = { message: 'incomplete function call' }
  return { text: text.join(''), toolCalls: [...toolCalls.values()], model, usage, failure, completed }
}

/**
 * Create a reviewer bound to one configuration.
 *
 * @param {Record<string, any>} config
 * @param {{info?: Function, debug?: Function, warn?: Function}} [logger]
 */
export function createReviewer(config, logger, dependencies = {}) {
  const model = config.reviewModel ?? REVIEW_MODEL
  const transport = dependencies.transport ?? createTransport({
    mode: config.transport,
    proxy: config.proxy,
    timeoutMs: config.timeoutMs,
    logger,
  })
  const instructions = buildInstructions(config.policyBundle, config.promptMode)
  /** Cached quota reading, to keep the guard from doubling request volume. */
  let usageCache = { at: 0, value: undefined }

  /**
   * Read `used_percent` for the primary/secondary rate-limit windows.
   * @param {{access: string, accountId: string}} credential
   * @param {AbortSignal|undefined} signal
   */
  async function readUsage(credential, signal) {
    const now = Date.now()
    if (now - usageCache.at < (config.usageCacheMs ?? 60_000)) return usageCache.value
    try {
      const response = await transport.request({
        url: USAGE_URL,
        method: 'GET',
        headers: {
          authorization: `Bearer ${credential.access}`,
          'chatgpt-account-id': credential.accountId,
          accept: 'application/json',
          originator: 'codex_cli_rs',
        },
        signal,
      })
      if (response.status !== 200) {
        usageCache = { at: now, value: undefined }
        return undefined
      }
      const parsed = JSON.parse(response.body)
      const value = {
        primary: parsed?.rate_limit?.primary_window?.used_percent,
        secondary: parsed?.rate_limit?.secondary_window?.used_percent,
      }
      if (![value.primary, value.secondary].every((percent) => typeof percent === 'number' && Number.isFinite(percent) && percent >= 0 && percent <= 100)) {
        usageCache = { at: now, value: undefined }
        return undefined
      }
      usageCache = { at: now, value }
      return value
    } catch {
      usageCache = { at: now, value: undefined }
      return undefined
    }
  }

  /**
   * One HTTP attempt. Throws `TransportError` for transport-level failure.
   * @param {object} action
   * @param {{access: string, accountId: string}} credential
   * @param {number} timeoutMs
   * @param {AbortSignal|undefined} signal
   */
  async function attempt(action, credential, timeoutMs, signal, input, investigator) {
    const body = JSON.stringify({
      model,
      ...(config.reasoningEffort && config.reasoningEffort !== 'default' ? { reasoning: { effort: config.reasoningEffort } } : {}),
      instructions: buildInstructions(config.policyBundle, config.promptMode, action)+(investigator ? INVESTIGATION_INSTRUCTIONS : ''),
      input,
      ...(investigator ? { tools: investigator.tools.map((tool) => ({ type: 'function', ...tool })) } : {}),
      stream: true,
      store: false,
    })
    const startedAt = Date.now()
    const response = await transport.request({
      url: REVIEW_URL,
      method: 'POST',
      headers: {
        authorization: `Bearer ${credential.access}`,
        'chatgpt-account-id': credential.accountId,
        originator: 'codex_cli_rs',
        accept: 'text/event-stream',
        'content-type': 'application/json',
        'session-id': SESSION_ID,
        'accept-encoding': 'identity',
      },
      body,
      signal,
      timeoutMs,
    })
    const elapsedMs = Date.now() - startedAt
    const meta = {
      httpStatus: response.status,
      elapsedMs,
      route: response.route,
      activeLimit: response.headers['x-codex-active-limit'],
      inferenceLimit: response.headers['x-base-model-inference-limit-name'],
    }
    if (response.status !== 200) {
      const retryable = response.status === 429 || response.status >= 500
      return { ok: false, retryable, reason: `http-${response.status}`, detail: sanitize(response.body), meta }
    }
    const stream = readStream(response.body)
    if (stream.failure !== undefined) {
      return {
        ok: false,
        retryable: false,
        reason: 'response-failed',
        detail: sanitize(stream.failure?.message ?? JSON.stringify(stream.failure)),
        meta,
      }
    }
    if (!stream.completed || stream.model !== model) {
      return { ok: false, retryable: false, reason: !stream.completed ? 'incomplete-stream' : 'wrong-model', meta }
    }
    if (stream.toolCalls.length) {
      if (!investigator || parseVerdict(stream.text) || stream.toolCalls.length > 6) return { ok: false, retryable: false, reason: 'unexpected-review-tool-call', meta }
      return { ok: true, toolCalls: stream.toolCalls, meta: { ...meta, model: stream.model, totalTokens: stream.usage?.total_tokens } }
    }
    const verdict = parseVerdict(stream.text)
    if (verdict === undefined) {
      return { ok: false, retryable: true, reason: 'unparseable-verdict', detail: sanitize(stream.text), meta }
    }
    return {
      ok: true,
      verdict,
      meta: {
        ...meta,
        model: stream.model,
        totalTokens: stream.usage?.total_tokens,
        textChars: stream.text.length,
      },
    }
  }

  return {
    /** Exposed for tests and diagnostics. */
    instructions,
    fingerprint,

    /**
     * Decide one action.
     * @param {{toolName: string, argsText: string, reason?: string, trusted?: string[],
     *   environment?: object, signal?: AbortSignal}} action
     * @returns {Promise<{status: 'verdict', verdict: object, meta: object}
     *   | {status: 'unavailable', reason: string, detail?: string, meta?: object}>}
     */
    async review(action) {
      if (action.signal?.aborted) return { status: 'unavailable', reason: 'aborted' }
      if (typeof action.argsText !== 'string' || action.argsText.length > (config.maxArgsChars ?? 8_000)) return { status: 'unavailable', reason: 'oversized-action' }
      const deadline = Date.now() + (config.totalTimeoutMs ?? 25_000)
      const credential = (dependencies.readCredential ?? readCredential)({ credentialFile: config.credentialFile })
      if (!credential.ok) {
        return { status: 'unavailable', reason: credential.reason, detail: credential.detail }
      }

      if (config.usageGuard === true) {
        const usage = await readUsage(credential, action.signal)
        if (usage === undefined) return { status: 'unavailable', reason: 'quota-unavailable' }
        const worst = Math.max(usage?.primary ?? 0, usage?.secondary ?? 0)
        if (Number.isFinite(worst) && worst >= (config.usageStopPercent ?? 90)) {
          return { status: 'unavailable', reason: 'quota-guard', detail: `usage window at ${worst}%` }
        }
      }

      const attempts = Math.max(1, Math.min(2, (config.retries ?? 1) + 1))
      const investigator = createInvestigator(action, config)
      const input = buildReviewInput({ ...action, maxTrustedChars: config.maxTrustedChars, maxArgsChars: config.maxArgsChars })
      const started = Date.now()
      let rounds = 0, tokens = 0, tokenKnown = false
      let last = { status: 'unavailable', reason: 'not-attempted' }
      for (let attemptIndex = 0; attemptIndex < attempts; attemptIndex += 1) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
          last = { status: 'unavailable', reason: 'timeout', detail: 'overall deadline exhausted' }
          break
        }
        let result
        try {
          result = await attempt(action, credential, Math.min(config.timeoutMs ?? 20_000, remaining), action.signal, input, investigator)
        } catch (error) {
          const code = error instanceof TransportError ? error.code : error?.code
          const aborted = code === 'ABORT_ERR' || action.signal?.aborted === true
          result = {
            ok: false,
            retryable: !aborted,
            reason: aborted ? 'aborted' : 'transport',
            detail: sanitize(error?.message ?? error),
          }
        }
        if (result.ok) {
          if (Number.isFinite(result.meta?.totalTokens)) { tokens += result.meta.totalTokens; tokenKnown = true }
          if (result.verdict) return { status: 'verdict', verdict: result.verdict, meta: { ...result.meta, elapsedMs: Date.now()-started, totalTokens: tokenKnown ? tokens : undefined, investigationCalls: investigator?.calls ?? 0 } }
          if (++rounds > 3) return { status: 'unavailable', reason: 'investigation-limit' }
          try {
            const outputs = []
            for (const call of result.toolCalls) outputs.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify({ role: 'untrusted-evidence', result: await investigator.execute(call.name, call.arguments, action.signal) }) })
            input.push(...result.toolCalls, ...outputs)
          } catch (error) { return { status: 'unavailable', reason: action.signal?.aborted ? 'aborted' : 'invalid-investigation' } }
          // Tool rounds are not transport retries; each round still has bounded retries.
          attemptIndex = -1
          continue
        }
        last = { status: 'unavailable', reason: result.reason, detail: result.detail, meta: result.meta }
        if (!result.retryable) break
        logger?.debug?.(`codex-guardian: attempt ${attemptIndex + 1} failed (${result.reason}); retrying once`)
      }
      return last
    },
  }
}
