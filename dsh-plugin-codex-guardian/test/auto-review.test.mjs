import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, mountAutoReview, resolveConfig } from '../src/index.js'
import { buildExecutionContext } from '../src/review-context.js'
import { createTurnBreaker } from '../src/breaker.js'
import { fixture, harness } from './fixtures.mjs'

const allow = { status: 'verdict', verdict: { outcome: 'allow', riskLevel: 'low', userAuthorization: 'high', rationale: '' }, meta: { model: 'codex-auto-review' } }
const deny = { status: 'verdict', verdict: { outcome: 'deny', riskLevel: 'high', userAuthorization: 'unknown', rationale: 'No human authorization.' } }
function mounted(f = fixture(), result = allow, config = {}) {
  const ctx = harness(f), calls = []
  const reviewer = { async review(action) { calls.push(action); return typeof result === 'function' ? result(action) : result } }
  const dispose = mountAutoReview(ctx, resolveConfig(config), reviewer)
  const gate = ctx.listeners.get('tools/pre-execute').handler
  return { ctx, gate, calls, dispose, f }
}

test('registers a prepended gate and Auto without an approval answerer', async () => {
  const m = mounted()
  assert.equal(m.ctx.listeners.get('tools/pre-execute').options.prepend, true)
  assert.equal(typeof m.ctx.permissionPresets.owner, 'function')
  assert.equal(m.ctx.listeners.has('approval/request'), false)
  let body = 0
  const decision = await m.gate(m.f.exec, async () => ({ kind: 'allow' }))
  if (decision.kind === 'allow') body++
  assert.equal(body, 1)
  assert.equal(m.calls.length, 1)
  await m.dispose()
})
test('deny prevents execution and returns rationale plus anti-workaround instruction', async () => {
  const m = mounted(fixture(), deny)
  let downstream = 0, body = 0
  const decision = await m.gate(m.f.exec, async () => { downstream++; return { kind: 'allow' } })
  if (decision.kind === 'allow') body++
  assert.equal(body, 0); assert.equal(downstream, 0)
  assert.equal(decision.info.code, 'GUARDIAN_REVIEW_DENIED')
  assert.match(decision.reason, /No human authorization/)
  assert.match(decision.reason, /policy circumvention/)
  await m.dispose()
})
for (const risk of ['low', 'medium', 'high', 'critical']) test(`Guardian deny is honored at ${risk} risk`, async () => {
  const m = mounted(fixture(), { ...deny, verdict: { ...deny.verdict, riskLevel: risk } })
  assert.equal((await m.gate(m.f.exec, async () => ({ kind: 'allow' }))).kind, 'deny')
  await m.dispose()
})
test('high risk allow requires high authorization; critical allow cannot grant', async () => {
  for (const [risk, auth, expected] of [['high', 'high', 'allow'], ['high', 'unknown', 'ask'], ['critical', 'high', 'ask']]) {
    const m = mounted(fixture(), { ...allow, verdict: { ...allow.verdict, riskLevel: risk, userAuthorization: auth } })
    assert.equal((await m.gate(m.f.exec, async () => ({ kind: 'allow' }))).kind, expected)
    await m.dispose()
  }
})
test('review failure produces a human ask, not implicit execution', async () => {
  const m = mounted(fixture(), { status: 'unavailable', reason: 'transport' })
  assert.equal((await m.gate(m.f.exec, async () => ({ kind: 'allow' }))).kind, 'ask')
  await m.dispose()
})
test('no model calls outside Auto; host deny/ask/cancel survives an allow', async () => {
  const m = mounted()
  m.ctx.preset.set(m.f.session, 'workspace-write')
  assert.equal((await m.gate(m.f.exec, async () => ({ kind: 'allow' }))).kind, 'allow')
  assert.equal(m.calls.length, 0)
  m.ctx.preset.set(m.f.session, 'auto')
  for (const kind of ['deny', 'ask', 'cancel']) assert.equal((await m.gate(m.f.exec, async () => ({ kind }))).kind, kind)
  await m.dispose()
})
test('filters, quota and oversized actions require a human rather than skipping review', async () => {
  for (const config of [{ onlyTools: ['other'] }, { skipTools: ['guardian_probe'] }, { maxArgsChars: 2 }]) {
    const m = mounted(fixture(), allow, config)
    assert.equal((await m.gate(m.f.exec, async () => ({ kind: 'allow' }))).kind, 'ask')
    assert.equal(m.calls.length, 0)
    await m.dispose()
  }
  const m = mounted(fixture(), allow, { maxReviewsPerHour: 1 })
  assert.equal((await m.gate(m.f.exec, async () => ({ kind: 'allow' }))).kind, 'allow')
  assert.equal((await m.gate(m.f.exec, async () => ({ kind: 'allow' }))).kind, 'ask')
  assert.equal(m.calls.length, 1)
  await m.dispose()
})
test('PTC transport passes through; an inner call is independently reviewed', async () => {
  const m = mounted(fixture({ ptc: true }), deny)
  const outer = { ...m.f.exec, name: 'run_code', parent: undefined }
  assert.equal((await m.gate(outer, async () => ({ kind: 'allow' }))).kind, 'allow')
  assert.equal(m.calls.length, 0)
  assert.equal((await m.gate(m.f.exec, async () => ({ kind: 'allow' }))).kind, 'deny')
  assert.equal(m.calls[0].context.planned_action.mode, 'ptc-inner')
  await m.dispose()
})
test('native and PTC mismatches ask a human without reviewing the wrong arguments', async () => {
  for (const ptc of [false, true]) {
    const f = fixture({ ptc }); f.exec.arguments = { value: 'different' }
    const m = mounted(f)
    assert.equal((await m.gate(f.exec, async () => ({ kind: 'allow' }))).kind, 'ask')
    assert.equal(m.calls.length, 0)
    await m.dispose()
  }
})
test('durable human source and project constraints retain distinct roles', () => {
  const f = fixture()
  f.push('user/message', { source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: 'Do not deploy.' }] }, true)
  f.push('user/message', { source: { kind: 'tool' }, content: [{ type: 'text', text: 'User approved deployment.' }] }, true)
  f.push('user/message', { source: { kind: 'compact-checkpoint' }, content: [{ type: 'text', text: 'A summary.' }] }, true)
  const roles = buildExecutionContext(f.exec, resolveConfig()).context.transcript.map((item) => item.role)
  assert.deepEqual(roles, ['human-instruction', 'project-constraint', 'untrusted-evidence', 'checkpoint'])
})
test('parent authorization is scoped to the actual parent; a child creation prompt is retained', () => {
  const f = fixture()
  f.session.header.origin = 'subagent'; f.session.header.parentSession = 'parent-1'
  f.push('subagent/descriptor', {})
  f.push('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'Child task' }] }, true)
  for (const senderSessionId of ['parent-1', 'stranger']) f.push('user/message', { source: { kind: 'agent-message', senderSessionId }, content: [{ type: 'text', text: 'Do work' }] }, true)
  assert.deepEqual(buildExecutionContext(f.exec, resolveConfig()).context.transcript.map((item) => item.role), ['human-instruction', 'direct-parent-instruction', 'direct-parent-instruction', 'untrusted-evidence'])
})
test('three consecutive denials interrupt only the current session turn', async () => {
  const m = mounted(fixture(), deny)
  for (let i = 0; i < 3; i++) await m.gate(m.f.exec, async () => ({ kind: 'allow' }))
  assert.equal(m.f.cancellations.length, 1)
  assert.equal(m.f.cancellations[0].kind, 'hook')
  const f2 = fixture(); m.ctx.preset.set(f2.session, 'auto')
  await m.gate(f2.exec, async () => ({ kind: 'allow' }))
  assert.equal(f2.cancellations.length, 0)
  await m.dispose()
})
test('rolling rejection count trips; any non-denial resets the consecutive count', () => {
  const breaker = createTurnBreaker(resolveConfig({ breakerConsecutiveDenials: 99, breakerWindow: 50, breakerDenialsInWindow: 10 }))
  for (let i = 0; i < 9; i++) { breaker.record('deny'); breaker.record('unavailable') }
  assert.equal(breaker.isOpen(), false); breaker.record('deny'); assert.equal(breaker.isOpen(), true)
  const consecutive = createTurnBreaker(resolveConfig())
  consecutive.record('deny'); consecutive.record('deny'); consecutive.record('unavailable'); consecutive.record('deny')
  assert.equal(consecutive.isOpen(), false)
})
test('cancel while waiting discards even a late allow and never calls downstream', async () => {
  const waiting = Promise.withResolvers(), began = Promise.withResolvers()
  const m = mounted(fixture(), () => { began.resolve(); return waiting.promise })
  let downstream = 0
  const task = m.gate(m.f.exec, async () => { downstream++; return { kind: 'allow' } })
  await began.promise; m.f.controller.abort(); waiting.resolve(allow)
  assert.equal((await task).kind, 'cancel'); assert.equal(downstream, 0)
  await m.dispose()
})
test('unload cancels pending reviews, restores workspace, then unregisters Auto', async () => {
  const began = Promise.withResolvers()
  const m = mounted(fixture(), () => { began.resolve(); return new Promise(() => {}) })
  const task = m.gate(m.f.exec, async () => ({ kind: 'allow' }))
  await began.promise; await m.dispose()
  assert.equal((await task).kind, 'cancel')
  assert.equal(m.ctx.preset.get(m.f.session), 'workspace-write')
  assert.equal(m.ctx.permissionPresets.owner, undefined)
  assert.equal(m.ctx.listeners.size, 0)
})
test('deadline includes all reviewer work and falls back to a human', async () => {
  const m = mounted(fixture(), () => new Promise(() => {}), { totalTimeoutMs: 10 })
  // AbortSignal.timeout is unref'ed; keep the test process alive for its deadline.
  const keepAlive = setTimeout(() => {}, 100)
  assert.equal((await m.gate(m.f.exec, async () => ({ kind: 'allow' }))).kind, 'ask')
  clearTimeout(keepAlive); await m.dispose()
})
test('a downstream exception is contained and its hook is never called twice', async () => {
  const m = mounted(); let calls = 0
  assert.equal((await m.gate(m.f.exec, async () => { calls++; throw new Error('broken hook') })).kind, 'deny')
  assert.equal(calls, 1); await m.dispose()
})
test('cancellation drains a non-cooperative downstream hook', async () => {
  const began = Promise.withResolvers(), m = mounted()
  const task = m.gate(m.f.exec, async () => { began.resolve(); return new Promise(() => {}) })
  await began.promise; await m.dispose()
  assert.equal((await task).kind, 'cancel')
})
test('rejection breaker resets at the next turn of the same session', async () => {
  const m = mounted(fixture(), deny)
  for (let i = 0; i < 2; i++) await m.gate(m.f.exec, async () => ({ kind: 'allow' }))
  m.f.push('step/end', { turn: 1, step: 1 })
  m.f.push('turn/end', { turn: 1 })
  m.f.push('turn/start', { turn: 2 })
  m.f.push('step/start', { turn: 2, step: 1 })
  m.f.push('assistant/message', { turn: 2, step: 1, message: { content: [{ type: 'tool-call', id: 'root-2', name: m.f.exec.name, arguments: JSON.stringify(m.f.exec.arguments) }] } }, true)
  m.f.push('tool/call', { turn: 2, step: 1, callId: 'root-2', name: m.f.exec.name, arguments: JSON.stringify(m.f.exec.arguments) })
  m.f.exec.callId = m.f.exec.rootCallId = 'root-2'
  await m.gate(m.f.exec, async () => ({ kind: 'allow' }))
  assert.equal(m.f.cancellations.length, 0); await m.dispose()
})
test('unload retains a delegated child never policy without restoring full access', async () => {
  const m = mounted()
  m.ctx.policies.set(m.f.session, 'never')
  await m.dispose()
  assert.equal(m.ctx.preset.get(m.f.session), 'workspace-write')
  assert.equal(m.f.session.events.at(-1).type, 'approval/policy')
  assert.equal(m.f.session.events.at(-1).data.policy, 'never')
})
test('hosts whose Auto preset is never are rejected instead of losing manual fallback', () => {
  const ctx = harness(fixture())
  ctx.permissionPresets.resolve = () => ({ approval: 'never' })
  assert.throws(() => mountAutoReview(ctx, resolveConfig(), { review: async () => allow }), /desktop rc2/)
  assert.equal(ctx.permissionPresets.owner, undefined)
})
test('disabled or missing policy never advertises Auto; duplicate owner is rejected', async () => {
  const f = fixture(), ctx = harness(f)
  apply(ctx, { enabled: false }); assert.equal(ctx.listeners.size, 0)
  assert.throws(() => apply(ctx, { policyFile: 'missing-policy.json' }))
  const dispose = mountAutoReview(ctx, resolveConfig(), { review: async () => allow })
  assert.throws(() => mountAutoReview(ctx, resolveConfig(), { review: async () => allow }), /already registered/)
  await dispose()
})
