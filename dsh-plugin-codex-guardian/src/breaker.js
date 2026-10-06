/**
 * Circuit breakers and call budget.
 *
 * An automatic answerer that is wrong in the "allow" direction is worse than a
 * slow one, and an automatic answerer stuck in a denial loop silently breaks the
 * session. Both are bounded here: a run of denials, or a high denial rate over a
 * window, stops automatic answering for a cooldown and hands everything back to
 * the human; a per-hour call budget stops runaway review volume.
 *
 * @module dsh-plugin-codex-guardian/breaker
 */

/**
 * @param {Record<string, any>} config
 * @param {() => number} [clock]
 */
export function createBreaker(config, clock = () => Date.now()) {
  const consecutiveLimit = config.breakerConsecutiveDenials ?? 5
  const windowSize = config.breakerWindow ?? 20
  const minSamples = config.breakerMinSamples ?? 8
  const denialRate = config.breakerDenialRate ?? 0.8
  const cooldownMs = config.breakerCooldownMs ?? 300_000

  let consecutiveDenials = 0
  /** @type {Array<'allow'|'deny'>} */
  let recent = []
  let openUntil = 0
  let lastReason

  /** @param {string} reason */
  function open(reason) {
    openUntil = clock() + cooldownMs
    consecutiveDenials = 0
    recent = []
    lastReason = reason
  }

  return {
    /** True while automatic answering is suspended. */
    isOpen() {
      return clock() < openUntil
    },
    /** Why the breaker last opened. */
    reason() {
      return lastReason
    },
    /** Milliseconds until the breaker closes again (0 when closed). */
    remainingMs() {
      return Math.max(0, openUntil - clock())
    },
    /**
     * Record one decision. Only definitive verdicts count; `unavailable`
     * outcomes are not evidence about the reviewer's behaviour.
     * @param {'allow'|'deny'} outcome
     */
    record(outcome) {
      if (outcome === 'allow') {
        consecutiveDenials = 0
      } else {
        consecutiveDenials += 1
        if (consecutiveDenials >= consecutiveLimit) {
          open(`${consecutiveDenials} consecutive denials`)
          return
        }
      }
      recent.push(outcome)
      if (recent.length > windowSize) recent = recent.slice(recent.length - windowSize)
      if (recent.length >= minSamples) {
        const denials = recent.filter((entry) => entry === 'deny').length
        if (denials / recent.length >= denialRate) open(`${denials}/${recent.length} recent denials`)
      }
    },
  }
}

/**
 * Sliding-window call budget.
 * @param {Record<string, any>} config
 * @param {() => number} [clock]
 */
export function createBudget(config, clock = () => Date.now()) {
  /** @type {number[]} */
  let stamps = []
  return {
    /** @returns {boolean} true when a call may be made now. */
    take() {
      const limit = config.maxReviewsPerHour ?? 120
      const now = clock()
      stamps = stamps.filter((stamp) => now - stamp < 3_600_000)
      if (stamps.length >= limit) return false
      stamps.push(now)
      return true
    },
    /** @returns {number} calls made in the current window. */
    used() {
      const now = clock()
      stamps = stamps.filter((stamp) => now - stamp < 3_600_000)
      return stamps.length
    },
  }
}

/** Codex-style rejection limits; the owner creates one instance per session turn. */
export function createTurnBreaker(config) {
  let consecutive = 0
  const recent = []
  let tripped = false
  return {
    isOpen: () => tripped,
    record(outcome) {
      consecutive = outcome === 'deny' ? consecutive + 1 : 0
      recent.push(outcome)
      if (recent.length > config.breakerWindow) recent.shift()
      tripped ||= consecutive >= config.breakerConsecutiveDenials || recent.filter((value) => value === 'deny').length >= config.breakerDenialsInWindow
      return tripped
    },
  }
}
