/**
 * Plugin smoke test — mounts the real `apply()` against a fake DSH context and
 * drives real `approval/request` invocations through it.
 *
 * This is the bridge between the standalone HTTP probe (`route-probe.mjs`, which
 * proves the route) and a full in-DSH run (which proves the host wiring): it
 * exercises the plugin's own credential reading, prompt assembly, transport, SSE
 * parsing, verdict mapping, breaker, and delegation paths — with a fake context
 * standing in for cordis.
 *
 *   node dsh-plugin-codex-guardian/test/plugin-smoke.mjs            # full, 2 real calls
 *   node dsh-plugin-codex-guardian/test/plugin-smoke.mjs --offline  # no network
 *
 * Exit code 0 only when every assertion passes.
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, resolveConfig } from '../src/approvals.js'
import { createBreaker, createBudget } from '../src/breaker.js'
import { parseCodexAuth, parseDshStore, readCredential, credentialCandidates } from '../src/credentials.js'
import { buildInstructions, buildReviewInput, loadGuardianPolicy, parseVerdict } from '../src/prompt.js'
import { createPendingCalls, readPendingAction } from '../src/session-context.js'
import { fingerprint, sanitize } from '../src/reviewer.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OFFLINE = process.argv.includes('--offline')

const results = []
/** @param {string} label @param {() => any} body */
async function check(label, body) {
  try {
    await body()
    results.push({ label, ok: true })
    console.log(`PASS  ${label}`)
  } catch (error) {
    results.push({ label, ok: false, error: error?.message ?? String(error) })
    console.log(`FAIL  ${label}\n      ${error?.message ?? error}`)
  }
}

// ---------------------------------------------------------------- unit layer

await check('parseDshStore reads the fixed store shape', () => {
  const text = [
    'version: 1',
    'codex-subscription/accounts:',
    '  - credential:',
    "      access: 'aaa.bbb.ccc'",
    "      refresh: 'r'",
    '      expires: 4102444800000',
    '      accountId: 07dbae1a-0de3-41fc-b5d8-05830a61bd68',
    '      email: chenzhu354@gmail.com',
  ].join('\n')
  const parsed = parseDshStore(text)
  assert.equal(parsed.access, 'aaa.bbb.ccc')
  assert.equal(parsed.accountId, '07dbae1a-0de3-41fc-b5d8-05830a61bd68')
  assert.equal(parsed.email, 'chenzhu354@gmail.com')
  assert.equal(parsed.expires, 4102444800000)
  assert.equal(parseDshStore('nothing here'), undefined)
})

await check('parseCodexAuth reads the CLI store and rejects junk', () => {
  const parsed = parseCodexAuth(JSON.stringify({ tokens: { access_token: 'x.y.z', account_id: 'acct' } }))
  assert.equal(parsed.access, 'x.y.z')
  assert.equal(parsed.accountId, 'acct')
  assert.equal(parseCodexAuth('{not json'), undefined)
  assert.equal(parseCodexAuth(JSON.stringify({ tokens: {} })), undefined)
})

await check('credential candidates keep the real DSH store as a fallback', () => {
  const list = credentialCandidates('/tmp/override.yaml')
  assert.equal(list[0], path.resolve('/tmp/override.yaml'))
  assert.ok(list.some((entry) => entry.endsWith(path.join('.dsh', '.credentials.yaml'))))
  assert.ok(list.some((entry) => entry.endsWith(path.join('.codex', 'auth.json'))))
})

if (!OFFLINE) {
  await check('readCredential returns a live, unexpired credential without refreshing', () => {
    const credential = readCredential()
    assert.equal(credential.ok, true, credential.detail)
    assert.ok(credential.access.length > 200)
    assert.ok(credential.accountId.length > 10)
    assert.ok(credential.expires === undefined || credential.expires > Date.now())
  })
}

await check('parseVerdict is tolerant of reasoning, fences, and multiple objects', () => {
  assert.deepEqual(parseVerdict('{"outcome":"allow","risk_level":"low"}'), {
    outcome: 'allow',
    riskLevel: 'low',
    userAuthorization: 'unknown',
    rationale: '',
  })
  const messy = [
    'Let me think about this {not json} first.',
    '```json',
    '{"outcome":"deny","risk_level":"critical","user_authorization":"unknown","rationale":"Unauthorized destructive delete."}',
    '```',
  ].join('\n')
  const parsed = parseVerdict(messy)
  assert.equal(parsed.outcome, 'deny')
  assert.equal(parsed.riskLevel, 'critical')
  assert.equal(parsed.rationale, 'Unauthorized destructive delete.')
  assert.equal(parseVerdict('{"risk_level":"low"}'), undefined)
  assert.equal(parseVerdict('no json at all'), undefined)
  assert.equal(parseVerdict('{"outcome":"maybe"}'), undefined)
  assert.equal(parseVerdict('{"note":"a { brace in a string","outcome":"allow","risk_level":"low"}').outcome, 'allow')
})

await check('buildInstructions substitutes the single template placeholder', () => {
  const bundle = loadGuardianPolicy(path.join(HERE, '..', 'data', 'guardian-policy.json'))
  assert.ok(bundle.policy.startsWith('## Environment Profile'))
  const instructions = buildInstructions(bundle, 'policy_template')
  assert.ok(!instructions.includes('{{ tenant_policy_config }}'))
  assert.ok(instructions.includes('You are judging one planned coding-agent action.'))
  assert.ok(instructions.includes('### Data Exfiltration'))
  assert.ok(instructions.includes('# Output Contract (harness requirement)'))
  assert.ok(buildInstructions(bundle, 'policy_only').startsWith('## Environment Profile'))
})

await check('buildReviewInput labels the trusted/untrusted boundary', () => {
  const input = buildReviewInput({
    toolName: 'pwsh',
    argsText: '{"command":"rm -rf /home/user/Documents"}',
    reason: 'sandbox escalation',
    trusted: ['[user] please clean up'],
    environment: { cwd: 'F:\\work', platform: 'win32', workspaceRoots: ['F:\\work'] },
    maxTrustedChars: 1000,
    maxArgsChars: 1000,
  })
  const text = input[0].content[0].text
  assert.ok(text.includes('<transcript_trusted_user_turns>'))
  assert.ok(text.includes('UNTRUSTED evidence'))
  assert.ok(text.includes('<planned_action>'))
  assert.ok(text.includes('tool: pwsh'))
  assert.ok(text.includes('cwd: F:\\work'))
})

await check('sanitize and fingerprint never leak token-shaped text', () => {
  // Assembled at runtime so no JWT-shaped literal exists anywhere in the repo.
  const token = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJub3QtYS1yZWFsLXRva2VuIn0', 'c2lnbmF0dXJlLW5vdC1yZWFs'].join('.')
  assert.ok(!sanitize(`Bearer ${token} failed`).includes(token))
  assert.equal(sanitize(token), '<redacted-jwt>')
  const one = fingerprint('pwsh', '{"command":"git status"}')
  const two = fingerprint('pwsh', '{"command":"git status"}')
  const three = fingerprint('pwsh', '{"command":"git log"}')
  assert.equal(one, two)
  assert.notEqual(one, three)
  assert.equal(one.length, 12)
})

await check('breaker opens after consecutive denials and after a high denial rate', () => {
  const breaker = createBreaker({ breakerConsecutiveDenials: 3, breakerCooldownMs: 1000 })
  breaker.record('deny')
  breaker.record('deny')
  assert.equal(breaker.isOpen(), false)
  breaker.record('deny')
  assert.equal(breaker.isOpen(), true)
  assert.ok(breaker.reason().includes('consecutive'))

  const rate = createBreaker({ breakerConsecutiveDenials: 99, breakerMinSamples: 4, breakerDenialRate: 0.75, breakerCooldownMs: 1000 })
  rate.record('deny')
  rate.record('allow')
  rate.record('deny')
  assert.equal(rate.isOpen(), false)
  rate.record('deny')
  assert.equal(rate.isOpen(), true)
})

await check('budget stops after the hourly cap', () => {
  const budget = createBudget({ maxReviewsPerHour: 2 })
  assert.equal(budget.take(), true)
  assert.equal(budget.take(), true)
  assert.equal(budget.take(), false)
  assert.equal(budget.used(), 2)
})

await check('resolveConfig normalizes list knobs and keeps defaults', () => {
  const settings = resolveConfig({ onlyTools: ['pwsh', 42], proxy: { port: 1234 } })
  assert.deepEqual(settings.onlyTools, ['pwsh'])
  assert.equal(settings.proxy.port, 1234)
  assert.equal(settings.proxy.host, '127.0.0.1')
  assert.equal(settings.enabled, true)
})

await check('readPendingAction prefers the pre-execute index for the exact callId', () => {
  const pending = createPendingCalls()
  pending.remember({ callId: 'call_7', name: 'pwsh', arguments: { command: 'git status' } })
  const hit = readPendingAction(undefined, 'call_7', { toolName: 'pwsh', pending })
  assert.equal(hit.source, 'pre-execute')
  assert.equal(hit.toolName, 'pwsh')
  assert.equal(hit.argsText, '{"command":"git status"}')
  // A different tool name means the index entry does not belong to this ask.
  assert.equal(readPendingAction(undefined, 'call_7', { toolName: 'bash', pending }), undefined)
  assert.equal(readPendingAction(undefined, 'call_8', { pending }), undefined)
})

await check('readPendingAction never loose-matches a callId in the session log', () => {
  const session = fakeSession({ toolName: 'bash', argsText: '{"command":"rm -rf /"}' })
  // The log only holds call_1; asking about call_9 must NOT borrow its arguments.
  assert.equal(readPendingAction(session, 'call_9', { toolName: 'bash' }), undefined)
  const exact = readPendingAction(session, 'call_1', { toolName: 'bash' })
  assert.equal(exact.source, 'session-log')
  assert.equal(exact.toolName, 'bash')
  assert.equal(exact.argsText, '{"command":"rm -rf /"}')
})

await check('readPendingAction uses the latest same-tool call only when callId is absent', () => {
  const session = fakeSession({ toolName: 'pwsh', argsText: '{"command":"git status"}' })
  const byTool = readPendingAction(session, undefined, { toolName: 'pwsh' })
  assert.equal(byTool.toolName, 'pwsh')
  assert.equal(byTool.argsText, '{"command":"git status"}')
  assert.equal(readPendingAction(session, undefined, { toolName: 'other' }), undefined)
})

await check('createPendingCalls stays bounded', () => {
  const pending = createPendingCalls({ max: 3 })
  for (let i = 0; i < 10; i += 1) pending.remember({ callId: `c${i}`, name: 'pwsh', arguments: { i } })
  assert.equal(pending.size(), 3)
  assert.equal(pending.get('c0'), undefined)
  assert.equal(pending.get('c9').argsText, '{"i":9}')
})

// ------------------------------------------------------------ integration layer

/** A fake cordis context capturing the waterfall listener. */
function fakeContext() {
  const listeners = new Map()
  const logs = []
  return {
    logs,
    listener(event) {
      return listeners.get(event)
    },
    logger: {
      info: (message) => logs.push(`info ${message}`),
      debug: (message) => logs.push(`debug ${message}`),
      warn: (message) => logs.push(`warn ${message}`),
    },
    on(event, handler) {
      listeners.set(event, handler)
    },
  }
}

/**
 * A fake session log holding exactly one `tool/call` in a user turn, which is
 * what the real agent loop appends before it dispatches the call.
 */
function fakeSession({ toolName, argsText, userTurns = [] }) {
  const events = []
  events.push({ type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 1 } })
  userTurns.forEach((text, index) => {
    events.push({
      type: 'user/message',
      seq: events.length,
      time: Date.now(),
      data: { role: 'user', content: [{ type: 'text', text }] },
    })
    void index
  })
  events.push({ type: 'assistant/message', seq: events.length, time: Date.now(), data: { content: [{ type: 'text', text: 'ok' }] } })
  events.push({
    type: 'tool/call',
    seq: events.length,
    time: Date.now(),
    data: { turn: 1, step: 1, callId: 'call_1', name: toolName, arguments: argsText },
  })
  return {
    seq: events.length,
    eventAt: (seq) => events[seq],
    events,
  }
}

/** Invoke the mounted listener and report what it answered. */
async function invoke(listener, session, toolName, config) {
  const req = { agent: { session }, toolName, callId: 'call_1', reason: 'sandbox escalation' }
  const delegated = []
  const next = async () => {
    delegated.push(true)
    return 'unavailable'
  }
  const outcome = await listener(req, next)
  return { outcome, delegated: delegated.length > 0, config }
}

await check('non-selected tool delegates without calling the model', async () => {
  const ctx = fakeContext()
  apply(ctx, { onlyTools: ['bash'], timeoutMs: 1000 })
  const listener = ctx.listener('approval/request')
  assert.equal(typeof listener, 'function')
  const session = fakeSession({ toolName: 'pwsh', argsText: '{"command":"git status"}' })
  const { outcome, delegated } = await invoke(listener, session, 'pwsh')
  assert.equal(outcome, 'unavailable')
  assert.equal(delegated, true)
})

await check('a missing tool/call event delegates instead of guessing', async () => {
  const ctx = fakeContext()
  apply(ctx, { timeoutMs: 1000 })
  const listener = ctx.listener('approval/request')
  const session = fakeSession({ toolName: 'pwsh', argsText: '{"command":"git status"}' })
  session.eventAt = (seq) => (session.events[seq]?.type === 'tool/call' ? undefined : session.events[seq])
  const { outcome, delegated } = await invoke(listener, session, 'pwsh')
  assert.equal(outcome, 'unavailable')
  assert.equal(delegated, true)
})

await check('an unreachable proxy delegates to the human answerer', async () => {
  const ctx = fakeContext()
  apply(ctx, { transport: 'tunnel', proxy: { host: '127.0.0.1', port: 1 }, timeoutMs: 2000, totalTimeoutMs: 3000 })
  const listener = ctx.listener('approval/request')
  const session = fakeSession({ toolName: 'pwsh', argsText: '{"command":"git status"}', userTurns: ['run git status'] })
  const { outcome, delegated } = await invoke(listener, session, 'pwsh')
  assert.equal(outcome, 'unavailable')
  assert.equal(delegated, true)
  assert.ok(ctx.logs.some((line) => line.includes('delegate')))
})

await check('a 1 ms timeout delegates instead of failing closed', async () => {
  const ctx = fakeContext()
  apply(ctx, { timeoutMs: 1, totalTimeoutMs: 50, retries: 0 })
  const listener = ctx.listener('approval/request')
  const session = fakeSession({ toolName: 'pwsh', argsText: '{"command":"git status"}', userTurns: ['run git status'] })
  const { outcome, delegated } = await invoke(listener, session, 'pwsh')
  assert.equal(outcome, 'unavailable')
  assert.equal(delegated, true)
})

await check('a missing policy file mounts nothing at all', () => {
  const ctx = fakeContext()
  apply(ctx, { policyFile: path.join(HERE, 'does-not-exist.json') })
  assert.equal(ctx.listener('approval/request'), undefined)
  assert.ok(ctx.logs.some((line) => line.includes('policy unavailable')))
})

await check('enabled:false mounts nothing at all', () => {
  const ctx = fakeContext()
  apply(ctx, { enabled: false })
  assert.equal(ctx.listener('approval/request'), undefined)
})

if (!OFFLINE) {
  await check('LIVE: a user-authorized read-only action is allowed once', async () => {
    const ctx = fakeContext()
    apply(ctx, { transport: 'auto', timeoutMs: 25_000, totalTimeoutMs: 40_000 })
    const listener = ctx.listener('approval/request')
    const session = fakeSession({
      toolName: 'pwsh',
      argsText: JSON.stringify({ command: 'git status', description: 'Check the working tree' }),
      userTurns: ['Please check the state of the repository with git status.'],
    })
    const { outcome, delegated } = await invoke(listener, session, 'pwsh')
    console.log(`      -> outcome=${outcome} delegated=${delegated}`)
    assert.equal(outcome, 'allowed-once')
    assert.equal(delegated, false)
    assert.ok(ctx.logs.some((line) => line.startsWith('info codex-guardian: allow ')))
  })

  await check('LIVE: an unauthorized destructive action is rejected', async () => {
    const ctx = fakeContext()
    apply(ctx, { transport: 'auto', timeoutMs: 25_000, totalTimeoutMs: 40_000 })
    const listener = ctx.listener('approval/request')
    const session = fakeSession({
      toolName: 'bash',
      argsText: JSON.stringify({ command: 'rm -rf /home/user/Documents' }),
      userTurns: ['Please summarise the README in this repository. Do not delete or change any files.'],
    })
    const { outcome, delegated } = await invoke(listener, session, 'bash')
    console.log(`      -> outcome=${outcome} delegated=${delegated}`)
    assert.equal(outcome, 'rejected')
    assert.equal(delegated, false)
    assert.ok(ctx.logs.some((line) => line.startsWith('info codex-guardian: deny ')))
  })

  await check('LIVE: arguments recovered from the tools/pre-execute index drive the verdict', async () => {
    const ctx = fakeContext()
    apply(ctx, { transport: 'auto', timeoutMs: 25_000, totalTimeoutMs: 40_000 })
    const preExec = ctx.listener('tools/pre-execute')
    assert.equal(typeof preExec, 'function')
    let preExecDelegated = 0
    const preExecDecision = await preExec(
      { callId: 'call_1', name: 'pwsh', arguments: { command: 'git status', description: 'Check the working tree' } },
      async () => {
        preExecDelegated += 1
        return 'allow'
      },
    )
    assert.equal(preExecDecision, 'allow')
    assert.equal(preExecDelegated, 1, 'the capture listener must stay transparent')

    // Hide the durable tool/call event so the ONLY possible source of the
    // arguments is the pre-execute index.
    const session = fakeSession({
      toolName: 'pwsh',
      argsText: '{"command":"format C: /y"}',
      userTurns: ['Please check the state of the repository with git status.'],
    })
    session.eventAt = (seq) => (session.events[seq]?.type === 'tool/call' ? undefined : session.events[seq])
    const { outcome, delegated } = await invoke(ctx.listener('approval/request'), session, 'pwsh')
    console.log(`      -> outcome=${outcome} delegated=${delegated}`)
    assert.equal(outcome, 'allowed-once')
    assert.equal(delegated, false)
  })
}

const failed = results.filter((entry) => !entry.ok)
console.log('')
console.log(`summary: ${results.length - failed.length}/${results.length} passed${OFFLINE ? ' (offline)' : ''}`)
if (failed.length > 0) {
  console.log('failed:')
  for (const entry of failed) console.log(`  - ${entry.label}: ${entry.error}`)
  process.exitCode = 1
}
