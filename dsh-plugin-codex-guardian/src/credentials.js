/**
 * Credential acquisition for the codex-auto-review route.
 *
 * Sources, in order (each run re-reads; nothing is cached):
 *   1. `<DSH_HOME>/.credentials.yaml`   — the DSH store owned by dsh-codex-subscription
 *   2. `<homedir>/.dsh/.credentials.yaml` — same store when DSH_HOME is overridden to a scratch home
 *   3. `<homedir>/.codex/auth.json`     — the Codex CLI store
 *
 * This module is READ-ONLY by design. It never refreshes, rewrites, or rotates a
 * token: the subscription plugin owns the refresh rotation and a second writer
 * would invalidate it. An expired token is a hard "not my business" outcome that
 * sends the request back to the human answerer.
 *
 * The access token is never logged, never returned in an error message, and never
 * written anywhere.
 *
 * @module dsh-plugin-codex-guardian/credentials
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Clock skew subtracted from `expires` before treating a token as expired. */
const EXPIRY_SKEW_MS = 30_000

/** The `codex-subscription/accounts:` anchor inside the DSH credential store. */
const ACCOUNTS_MARKER = 'codex-subscription/accounts:'

/**
 * Every credential file this module will look at, in precedence order.
 *
 * `DSH_HOME` is honoured first so a scratch profile can point at its own store,
 * but the real `~/.dsh` store is always kept as a fallback: a disposable profile
 * has no subscription plugin of its own and must still reach the credentials the
 * user's real profile keeps fresh.
 *
 * @param {string} [override] - explicit credential file from plugin config.
 * @returns {string[]} absolute candidate paths, de-duplicated, order preserved.
 */
export function credentialCandidates(override) {
  const home = os.homedir()
  const dshHome = (process.env.DSH_HOME ?? '').trim()
  const list = []
  if (typeof override === 'string' && override.trim() !== '') list.push(path.resolve(override.trim()))
  if (dshHome !== '') list.push(path.join(dshHome, '.credentials.yaml'))
  list.push(path.join(home, '.dsh', '.credentials.yaml'))
  list.push(path.join(home, '.codex', 'auth.json'))
  return [...new Set(list)]
}

/**
 * Read one line-oriented `key: value` scalar out of a block, stripping quotes.
 * @param {string} block - text starting at the accounts marker.
 * @param {string} key - the scalar name to read.
 * @returns {string|undefined} the trimmed, unquoted value.
 */
function grab(block, key) {
  const match = new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm').exec(block)
  if (match === null) return undefined
  let value = match[1].trim()
  if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1)
  else if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
  return value === '' ? undefined : value
}

/**
 * Parse the DSH credential store. Regex-based on purpose: the file's shape is
 * fixed and a YAML dependency would be the only runtime dependency this plugin
 * has.
 *
 * @param {string} text - the whole `.credentials.yaml` file.
 * @returns {{access: string, accountId: string, email?: string, expires?: number}|undefined}
 */
export function parseDshStore(text) {
  const at = text.indexOf(ACCOUNTS_MARKER)
  if (at < 0) return undefined
  const block = text.slice(at)
  const access = grab(block, 'access')
  const accountId = grab(block, 'accountId')
  if (access === undefined || accountId === undefined) return undefined
  const expiresRaw = grab(block, 'expires')
  const expires = expiresRaw === undefined ? undefined : Number(expiresRaw)
  return {
    access,
    accountId,
    email: grab(block, 'email'),
    expires: Number.isFinite(expires) ? expires : undefined,
  }
}

/**
 * Parse the Codex CLI store.
 * @param {string} text - the whole `auth.json` file.
 * @returns {{access: string, accountId: string, email?: string}|undefined}
 */
export function parseCodexAuth(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const tokens = parsed?.tokens
  const access = tokens?.access_token
  const accountId = tokens?.account_id
  if (typeof access !== 'string' || access === '') return undefined
  return {
    access,
    accountId: typeof accountId === 'string' && accountId !== '' ? accountId : undefined,
  }
}

/** @param {string} value */
function looksLikeJwt(value) {
  return value.split('.').length === 3
}

/**
 * Acquire the credential for one review.
 *
 * Returns a discriminated result instead of throwing so callers can log a reason
 * code without ever touching token text.
 *
 * @param {{credentialFile?: string, now?: number}} [options]
 * @returns {{ok: true, access: string, accountId: string, email?: string, expires?: number, source: string}
 *   | {ok: false, reason: string, detail?: string}}
 */
export function readCredential(options = {}) {
  const now = options.now ?? Date.now()
  const problems = []
  for (const file of credentialCandidates(options.credentialFile)) {
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (error) {
      problems.push(`${path.basename(file)}: unreadable (${error?.code ?? 'error'})`)
      continue
    }
    const parsed = file.endsWith('.json') ? parseCodexAuth(text) : parseDshStore(text)
    if (parsed === undefined) {
      problems.push(`${path.basename(file)}: no usable access token`)
      continue
    }
    if (parsed.accountId === undefined) {
      problems.push(`${path.basename(file)}: no account id`)
      continue
    }
    if (parsed.expires !== undefined && now > parsed.expires - EXPIRY_SKEW_MS) {
      problems.push(`${path.basename(file)}: token expired (not refreshing by design)`)
      continue
    }
    return {
      ok: true,
      access: parsed.access,
      accountId: parsed.accountId,
      email: parsed.email,
      expires: parsed.expires,
      source: file,
    }
  }
  return { ok: false, reason: 'no-credential', detail: problems.join('; ') }
}

/**
 * Non-secret description of a credential, safe for logs.
 * @param {{source: string, email?: string, expires?: number}} credential
 * @returns {string}
 */
export function describeCredential(credential) {
  const expiry = credential.expires === undefined ? 'no-expiry' : new Date(credential.expires).toISOString()
  return `${path.basename(credential.source)} account=${credential.accountId ?? 'unknown'} expires=${expiry} jwt=${looksLikeJwt(credential.access)}`
}
