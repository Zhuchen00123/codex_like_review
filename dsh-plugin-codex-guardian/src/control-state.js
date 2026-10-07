import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'

export const EDITABLE = {
  reviewEnabled: true, reviewerSource: 'codex', reviewModel: 'codex-auto-review', reviewProvider: '', reasoningEffort: 'default',
  timeoutMs: 20_000, totalTimeoutMs: 28_000, retries: 1, maxReviewsPerHour: 120,
  usageGuard: false, usageStopPercent: 90, breakerConsecutiveDenials: 3, breakerWindow: 50, breakerDenialsInWindow: 10,
  allowInvestigation: true,
}
const INTEGER_LIMITS = { timeoutMs: [1, 120000], totalTimeoutMs: [1, 180000], retries: [0, 1], maxReviewsPerHour: [1, 10000], usageStopPercent: [1, 100], breakerConsecutiveDenials: [1, 100], breakerWindow: [1, 1000], breakerDenialsInWindow: [1, 1000] }
export function validateSettings(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('invalid-settings')
  const result = {}
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(EDITABLE, key)) throw new Error(`unknown-setting:${key}`)
    if (INTEGER_LIMITS[key]) {
      const [min, max] = INTEGER_LIMITS[key]
      if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`invalid-setting:${key}`)
    } else if (typeof EDITABLE[key] === 'boolean') {
      if (typeof value !== 'boolean') throw new Error(`invalid-setting:${key}`)
    } else if (typeof value !== 'string' || value.length > 160) throw new Error(`invalid-setting:${key}`)
    result[key] = value
  }
  if (result.reviewerSource !== undefined && !['codex', 'dsh'].includes(result.reviewerSource)) throw new Error('invalid-setting:reviewerSource')
  for (const key of ['reviewModel', 'reviewProvider']) if (result[key] !== undefined && result[key] !== '' && !/^[A-Za-z0-9_.:/-]+$/.test(result[key])) throw new Error(`invalid-setting:${key}`)
  if (result.reviewModel === '') throw new Error('invalid-setting:reviewModel')
  if (result.reasoningEffort !== undefined && !['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(result.reasoningEffort)) throw new Error('invalid-setting:reasoningEffort')
  return result
}
function validateRoute(values) {
  if (values.reviewerSource === 'dsh' && !values.reviewProvider) throw new Error('provider-required')
  if (values.breakerDenialsInWindow > values.breakerWindow) throw new Error('invalid-breaker-window')
}
function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  try { fs.writeFileSync(tmp, JSON.stringify(data, null, 2)+'\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(tmp, file) }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) }
}
export function createControlState(base, options = {}) {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const file = options.file ?? path.join(home, 'guardian', 'settings.json')
  const historyFile = options.historyFile ?? path.join(path.dirname(file), 'reviews.json')
  let revision = 0, recent = [], overrides = {}, warning = null
  try { if (fs.existsSync(file)) { const stored = JSON.parse(fs.readFileSync(file, 'utf8')); overrides = validateSettings(stored.values); validateRoute({ ...EDITABLE, ...base, ...overrides }); revision = Number.isSafeInteger(stored.revision) && stored.revision >= 0 ? stored.revision : 0 } } catch { overrides = {}; revision = 0; warning = 'stored-settings-invalid' }
  try { if (fs.existsSync(historyFile)) recent = JSON.parse(fs.readFileSync(historyFile, 'utf8')).slice(-200).map(cleanRecord) } catch { recent = [] }
  const current = { ...EDITABLE, ...base, ...overrides }
  validateSettings(Object.fromEntries(Object.keys(EDITABLE).map((key) => [key, current[key]])))
  validateRoute(current)
  function view() { return { settings: Object.fromEntries(Object.keys(EDITABLE).map((key) => [key, current[key]])), revision, warning, recent: [...recent].reverse(), counters: { allow: recent.filter((v) => v.outcome === 'allow').length, deny: recent.filter((v) => v.outcome === 'deny').length, unavailable: recent.filter((v) => v.outcome === 'unavailable').length }, historyLimit: 200 } }
  return {
    current, view,
    save(patch, expectedRevision) {
      if (expectedRevision !== revision) throw new Error('settings-conflict')
      const values = { ...Object.fromEntries(Object.keys(EDITABLE).map((key) => [key, current[key]])), ...validateSettings(patch) }
      validateRoute(values)
      // Commit to disk before publishing a new route. Never mutate a running request's snapshot.
      atomicWrite(file, { revision: revision+1, values })
      Object.assign(current, values); revision++; warning = null
      return view()
    },
    record(record) {
      recent.push(cleanRecord({ ...record, time: new Date().toISOString() })); recent = recent.slice(-200)
      try { atomicWrite(historyFile, recent) } catch { warning = 'history-write-failed' }
    },
    clearHistory() { atomicWrite(historyFile, []); recent = []; return view() },
  }
}
function cleanRecord(record) {
  // Explicit allowlist: tool arguments, message text, model reasoning and credentials never enter audit storage.
  const clean = {}
  for (const key of ['time', 'fingerprint', 'tool', 'outcome', 'risk', 'source', 'requestedModel', 'model', 'reason', 'elapsedMs', 'totalTokens', 'investigationCalls']) {
    const value = record?.[key]
    clean[key] = typeof value === 'string' ? value.slice(0, 160) : typeof value === 'number' && Number.isFinite(value) ? value : null
  }
  return clean
}
