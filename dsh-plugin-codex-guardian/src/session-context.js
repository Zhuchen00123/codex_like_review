/**
 * Read the pending action and its authorization evidence out of the session log.
 *
 * An approval request carries only `toolName`, `reason`, and `callId` — no
 * arguments. The arguments are already durable, though: the agent loop appends
 * `tool/call { turn, step, callId, name, arguments }` *before* it prepares and
 * dispatches the call
 * (`dsh-agent-loop/lib/index.js:580` → `:582` → `:586`), and the approval ask
 * happens inside dispatch. So at ask time the exact call is in the log.
 *
 * Everything here is read-only and defensive: a shape change yields `undefined`,
 * which the caller turns into "delegate to the human answerer".
 *
 * @module dsh-plugin-codex-guardian/session-context
 */

/** How far back to scan for the matching `tool/call` when `callId` is absent. */
const DEFAULT_MAX_SCAN = 400

/**
 * Walk the session log backwards from the tail.
 * @param {any} session
 * @param {number} maxScan
 * @param {(event: any) => boolean} visit - return true to stop.
 * @returns {any|undefined} the event that stopped the walk.
 */
function walkBack(session, maxScan, visit) {
  const rawSeq = session?.seq
  if (typeof rawSeq !== 'number' || !Number.isFinite(rawSeq)) return undefined
  for (let seq = rawSeq - 1, scanned = 0; seq >= 0 && scanned < maxScan; seq -= 1, scanned += 1) {
    let event
    try {
      event = session.eventAt(seq)
    } catch {
      return undefined
    }
    if (event === undefined || event === null) continue
    if (visit(event)) return event
  }
  return undefined
}

/**
 * Render a tool call's arguments as the text the reviewer sees. The session log
 * holds the model's raw JSON string; `tools/pre-execute` holds the parsed value.
 * Raw text can be non-JSON (the loop keeps the raw string when parsing fails,
 * `dsh-agent-loop/lib/index.js:535-541`), so both shapes are handled.
 *
 * @param {unknown} args
 * @returns {string}
 */
export function argsToText(args) {
  if (typeof args === 'string') return args
  try {
    return JSON.stringify(args ?? null)
  } catch {
    return String(args)
  }
}

/**
 * In-memory index of tool calls seen on the `tools/pre-execute` waterfall.
 *
 * Preferred over log archaeology: `exec.arguments` there is already parsed and
 * deep-frozen (`dsh-tools/lib/types/index.d.ts:216-242`), and the event is
 * dispatched before the approval ask on the same sequential path
 * (`dsh-tools/lib/index.js:3225` → `:3226` → `:3455`), so the entry is always
 * present by the time an ask arrives. Bounded so a long session cannot grow it
 * without limit.
 *
 * @param {{max?: number}} [options]
 */
export function createPendingCalls(options = {}) {
  const max = options.max ?? 256
  /** @type {Map<string, {toolName: string, argsText: string, seq: number}>} */
  const entries = new Map()
  return {
    /**
     * @param {{callId?: unknown, name?: unknown, arguments?: unknown}} exec
     */
    remember(exec) {
      if (exec === undefined || exec === null) return
      if (typeof exec.name !== 'string' || exec.name === '') return
      const key = exec.callId === undefined || exec.callId === null ? undefined : String(exec.callId)
      if (key === undefined) return
      entries.delete(key)
      entries.set(key, { toolName: exec.name, argsText: argsToText(exec.arguments), seq: -1 })
      while (entries.size > max) {
        const oldest = entries.keys().next()
        if (oldest.done === true) break
        entries.delete(oldest.value)
      }
    },
    /**
     * @param {unknown} callId
     * @returns {{toolName: string, argsText: string, seq: number}|undefined}
     */
    get(callId) {
      if (callId === undefined || callId === null) return undefined
      return entries.get(String(callId))
    },
    size() {
      return entries.size
    },
  }
}

/**
 * Recover the tool call being decided.
 *
 * Matches by `callId`, never "the latest tool call": a parallel group appends
 * sibling calls, so a loose match could attach the wrong arguments to a review —
 * the one failure mode that would silently approve the wrong action. When
 * `callId` is absent (no asker has one today) the most recent call for the same
 * tool name is used, which is unambiguous only because there is nothing to
 * correlate against.
 *
 * @param {any} session - `req.agent.session`.
 * @param {unknown} callId - `req.callId`, when the asker had one.
 * @param {{maxScan?: number, toolName?: string, pending?: ReturnType<typeof createPendingCalls>}} [options]
 * @returns {{toolName: string, argsText: string, seq: number, source: string}|undefined}
 */
export function readPendingAction(session, callId, options = {}) {
  const wanted = callId === undefined || callId === null ? undefined : String(callId)

  const indexed = options.pending?.get(callId)
  if (indexed !== undefined && (options.toolName === undefined || indexed.toolName === options.toolName)) {
    return { ...indexed, source: 'pre-execute' }
  }

  const maxScan = options.maxScan ?? DEFAULT_MAX_SCAN
  const toolName = options.toolName
  let fallback
  const match = walkBack(session, maxScan, (event) => {
    if (event.type !== 'tool/call') return false
    const data = event.data
    if (data === null || typeof data !== 'object') return false
    if (typeof data.name !== 'string' || data.name === '') return false
    if (wanted !== undefined) return String(data.callId) === wanted
    if (fallback === undefined && (toolName === undefined || data.name === toolName)) fallback = event
    return false
  })
  const chosen = match ?? fallback
  if (chosen === undefined) return undefined
  const data = chosen.data
  return {
    toolName: data.name,
    argsText: argsToText(data.arguments),
    seq: typeof chosen.seq === 'number' ? chosen.seq : -1,
    source: 'session-log',
  }
}

/**
 * Pull the text out of one message-content block, whatever its spelling.
 * @param {any} block
 * @returns {string|undefined}
 */
function blockText(block) {
  if (typeof block === 'string') return block
  if (block === null || typeof block !== 'object') return undefined
  if (typeof block.text === 'string') return block.text
  if (typeof block.content === 'string') return block.content
  return undefined
}

/**
 * Extract the plain text of one message-like event payload.
 * @param {any} data
 * @returns {string|undefined}
 */
function messageText(data) {
  if (typeof data === 'string') return data
  if (data === null || typeof data !== 'object') return undefined
  const content = data.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = content.map(blockText).filter((text) => typeof text === 'string' && text.trim() !== '')
    return parts.length === 0 ? undefined : parts.join('\n')
  }
  return typeof data.text === 'string' ? data.text : undefined
}

/**
 * The most recent trusted turns, oldest first. Guardian's trust rule: user and
 * developer messages establish authorization; nothing else does.
 *
 * @param {any} session
 * @param {{maxMessages?: number, maxChars?: number, maxScan?: number}} [options]
 * @returns {string[]}
 */
export function readTrustedTurns(session, options = {}) {
  const maxMessages = options.maxMessages ?? 6
  const maxChars = options.maxChars ?? 6_000
  const maxScan = options.maxScan ?? DEFAULT_MAX_SCAN
  const collected = []
  let budget = maxChars
  const rawSeq = session?.seq
  if (typeof rawSeq !== 'number' || !Number.isFinite(rawSeq)) return collected
  for (let seq = rawSeq - 1, scanned = 0; seq >= 0 && scanned < maxScan; seq -= 1, scanned += 1) {
    if (collected.length >= maxMessages || budget <= 0) break
    let event
    try {
      event = session.eventAt(seq)
    } catch {
      break
    }
    if (event === undefined || event === null) continue
    if (event.type !== 'user/message' && event.type !== 'developer/message') continue
    const text = messageText(event.data)?.trim()
    if (text === undefined || text === '') continue
    const clipped = text.length > budget ? text.slice(text.length - budget) : text
    budget -= clipped.length
    collected.push(`${event.type === 'developer/message' ? '[developer]' : '[user]'} ${clipped}`)
  }
  return collected.reverse()
}

/**
 * Best-effort execution environment for the reviewer's context block.
 * @param {any} agent
 * @returns {{cwd: string, platform: string, workspaceRoots: string[]}}
 */
export function readEnvironment(agent) {
  const session = agent?.session
  const roots = []
  for (const candidate of [session?.header?.cwd, agent?.workspace?.root, agent?.cwd]) {
    if (typeof candidate === 'string' && candidate !== '' && !roots.includes(candidate)) roots.push(candidate)
  }
  const cwd = roots[0] ?? process.cwd()
  return { cwd, platform: process.platform, workspaceRoots: roots }
}
