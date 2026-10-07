import test from 'node:test'
import assert from 'node:assert/strict'
import { mountCodexLikeReview, REVIEW_PRESET } from '../src/codexlike-review.js'
import { resolveConfig } from '../src/index.js'
import { createDenials } from '../src/denials.js'
import { buildExecutionContext } from '../src/review-context.js'
import { buildInstructions, loadGuardianPolicy } from '../src/prompt.js'
import { fixture, harness } from './fixtures.mjs'
const allow = { status: 'verdict', verdict: { outcome: 'allow', riskLevel: 'low', userAuthorization: 'high', rationale: 'authorized' } }
const deny = { status: 'verdict', verdict: { outcome: 'deny', riskLevel: 'high', userAuthorization: 'low', rationale: 'target is not authorized' } }
function mounted(result = allow, config = {}) {
  const f = fixture(), ctx = harness(f), calls = [], denials = createDenials()
  ctx.preset.set(f.session, REVIEW_PRESET)
  ctx.permissionPresets.presets = { 'workspace-write': { sandbox: 'workspace-write', approval: 'ask' } }
  ctx.permissionPresets.emitCatalogChanged = () => {}
  const dispose = mountCodexLikeReview(ctx, resolveConfig(config), { async review(action) { calls.push(action); return typeof result === 'function' ? result(action) : result } }, { denials })
  const gate = ctx.listeners.get('tools/pre-execute').handler
  const approval = (next = () => 'unavailable', req = {}) => ctx.listeners.get('approval/request').handler({ agent: f.agent, toolName: f.exec.name, callId: f.exec.callId, signal: f.exec.signal, reason: 'one-call escalation', ...req }, next)
  return { f, ctx, gate, approval, calls, denials, dispose }
}
test('named mode retains workspace confinement and reviews only existing approval requests', async () => {
  const m = mounted()
  assert.deepEqual(m.ctx.permissionPresets.presets[REVIEW_PRESET].sandbox, 'workspace-write')
  assert.equal(m.ctx.permissionPresets.owner, undefined)
  assert.equal((await m.gate(m.f.exec, () => ({ kind: 'allow' }))).kind, 'allow')
  assert.equal(m.calls.length, 0)
  assert.equal(await m.approval(), 'allowed-once'); assert.equal(m.calls.length, 1)
  assert.match(m.calls[0].context.environment.execution_access, /workspace-write/)
  assert.equal(await m.approval(), 'rejected')
  await m.dispose(); assert.equal(m.ctx.permissionPresets.presets[REVIEW_PRESET], undefined)
})
test('pre-execute host deny is preserved and no reviewer is called', async () => {
  const m = mounted()
  assert.equal((await m.gate(m.f.exec, () => ({ kind: 'deny' }))).kind, 'deny'); assert.equal(m.calls.length, 0)
  await m.dispose()
})
test('approval requests outside the mode or without exact execution delegate to human', async () => {
  const m = mounted(); let human = 0
  assert.equal(await m.approval(() => { human++; return 'allowed-once' }), 'allowed-once')
  await m.gate(m.f.exec, () => ({ kind: 'allow' }))
  assert.equal(await m.approval(() => { human++; return 'rejected' }, { toolName: 'other' }), 'rejected')
  m.ctx.preset.set(m.f.session, 'workspace-write')
  await m.approval(() => { human++; return 'rejected' })
  assert.equal(human, 3); assert.equal(m.calls.length, 0); await m.dispose()
})
test('review deny is final and adds rationale/anti-workaround feedback to failed result', async () => {
  const m = mounted(deny); await m.gate(m.f.exec, () => ({ kind: 'ask' }))
  assert.equal(await m.approval(() => { throw new Error('no human fallback on deny') }), 'rejected')
  const feedback = await m.ctx.listeners.get('tools/post-execute').handler(m.f.exec, { isError: true }, () => ({ kind: 'accept' }))
  assert.equal(feedback.kind, 'block'); assert.match(feedback.feedback[0].text, /target is not authorized.*policy circumvention/)
  assert.equal(m.denials.list().length, 1)
  m.ctx.listeners.get('tools/result').handler(m.f.exec)
  assert.equal(await m.approval(() => 'unavailable'), 'unavailable')
  await m.dispose()
})
test('reviewer failure, pause and context mismatch use native manual approval', async () => {
  for (const config of [{}, { reviewEnabled: false }, { maxArgsChars: 1 }]) {
    const m = mounted({ status: 'unavailable', reason: 'transport' }, config)
    await m.gate(m.f.exec, () => ({ kind: 'allow' }))
    assert.equal(await m.approval(() => 'allowed-once'), 'allowed-once')
    await m.dispose()
  }
})
test('high with medium authorization follows template threshold; critical allow cannot grant', async () => {
  for (const [risk, authorization, expected] of [['high', 'medium', 'allowed-once'], ['high', 'low', 'unavailable'], ['critical', 'high', 'unavailable']]) {
    const m = mounted({ ...allow, verdict: { ...allow.verdict, riskLevel: risk, userAuthorization: authorization } })
    await m.gate(m.f.exec, () => ({ kind: 'allow' })); assert.equal(await m.approval(), expected); await m.dispose()
  }
})
test('one retry remains reviewed and cannot override another model denial', async () => {
  const m = mounted((action) => action.context.explicit_user_override ? deny : deny)
  const action = buildExecutionContext(m.f.exec, resolveConfig())
  const id = m.denials.record(action, m.f.session.id, deny.verdict); m.denials.approve(id)
  await m.gate(m.f.exec, () => ({ kind: 'allow' })); assert.equal(await m.approval(), 'rejected')
  assert.ok(m.calls[0].context.explicit_user_override); assert.equal(m.denials.list().some((v) => v.id === id), false)
  await m.dispose()
})
test('retry approval is bound to args/cwd/session/authorization, canonicalizes key order and is one-shot', () => {
  const store = createDenials(), f = fixture({ args: { a: 1, b: 2 } }), original = buildExecutionContext(f.exec, resolveConfig())
  const id = store.record(original, 'one', deny.verdict); store.approve(id)
  for (const changed of [
    { ...original, context: { ...original.context, environment: { cwd: 'other' } } },
    { ...original, context: { ...original.context, planned_action: { ...original.context.planned_action, arguments: { a: 2, b: 2 } } } },
    { ...original, context: { ...original.context, planned_action: { ...original.context.planned_action, description: 'Changed tool effects' } } },
    { ...original, context: { ...original.context, transcript: [...original.context.transcript, { role: 'human-instruction', text: 'do not delete' }] } },
  ]) assert.equal(store.consume(changed, 'one'), undefined)
  assert.equal(store.consume(original, 'two'), undefined)
  const reordered = { ...original, context: { ...original.context, planned_action: { ...original.context.planned_action, arguments: { b: 2, a: 1 } } } }
  assert.ok(store.consume(reordered, 'one')); assert.equal(store.consume(original, 'one'), undefined)
})
test('denials expire, per-session count is ten, and unapproved actions do not grant', () => {
  let now = 0; const store = createDenials(() => now), f = fixture(), action = buildExecutionContext(f.exec, resolveConfig())
  for (let i = 0; i < 12; i++) store.record(action, 'one', deny.verdict)
  assert.equal(store.list().length, 10); assert.equal(store.consume(action, 'one'), undefined)
  const id = store.list()[0].id; store.approve(id); assert.throws(() => store.approve(id), /already-approved/)
  now = 600001; assert.equal(store.list().length, 0); assert.throws(() => store.detail(id), /expired/)
})
test('browser specialized rules and exact retry marker are added only when relevant', () => {
  const policy = loadGuardianPolicy(), ordinary = buildInstructions(policy, 'policy_template', { toolName: 'bash', argsText: '{}' })
  assert.ok(!ordinary.includes('# Computer and Browser Use'))
  const browser = buildInstructions(policy, 'policy_template', { toolName: 'cua_repl', argsText: '{}', context: { explicit_user_override: {} } })
  assert.ok(browser.includes('# Computer and Browser Use')); assert.ok(browser.includes('# Explicit user retry approval'))
})
test('a bare human retry message resumes the approved action; an extra restriction invalidates it', () => {
  const store = createDenials(), f = fixture(), action = buildExecutionContext(f.exec, resolveConfig())
  const id = store.record(action, 'one', deny.verdict); store.approve(id)
  const resume = { ...action, context: { ...action.context, transcript: [...action.context.transcript, { role: 'human-instruction', source: 'user', text: '重试' }] } }
  const restricted = { ...resume, context: { ...resume.context, transcript: [...resume.context.transcript, { role: 'human-instruction', text: '重试，但不要修改任何文件' }] } }
  assert.equal(store.consume(restricted, 'one'), undefined); assert.ok(store.consume(resume, 'one'))
})
test('mode registration preserves the configured table and excludes live mode from future defaults', async () => {
  const f = fixture(), ctx = harness(f), configured = { 'workspace-write': { sandbox: 'workspace-write', approval: 'ask' } }
  ctx.preset.set(f.session, REVIEW_PRESET); ctx.permissionPresets.presets = configured; ctx.permissionPresets.emitCatalogChanged = () => {}
  ctx.permissionPresets.catalog = function () { const options = Object.keys(this.presets).map((value) => ({ value })); return { options, defaultOptions: options } }
  const originalCatalog = ctx.permissionPresets.catalog
  const dispose = mountCodexLikeReview(ctx, resolveConfig(), { review: () => allow })
  assert.equal(configured[REVIEW_PRESET], undefined)
  assert.ok(ctx.permissionPresets.catalog().options.some((v) => v.value === REVIEW_PRESET))
  assert.ok(!ctx.permissionPresets.catalog().defaultOptions.some((v) => v.value === REVIEW_PRESET))
  await dispose(); assert.equal(ctx.permissionPresets.catalog, originalCatalog)
})
test('legacy Auto session restore is migrated before host initialization and retains never restrictions', async () => {
  const m = mounted(), old = fixture().session
  m.ctx.permissionPresets.permissionState = (session) => ({ preset: m.ctx.preset.get(session) })
  m.ctx.preset.set(old, 'auto'); m.ctx.policies.set(old, 'never')
  m.ctx.listeners.get('session/created').handler(old)
  assert.equal(m.ctx.preset.get(old), REVIEW_PRESET)
  assert.equal(old.events.at(-1).data.policy, 'never')
  await m.dispose()
})
test('unload cancels pending review and restores workspace without leaving a mode', async () => {
  const began = Promise.withResolvers(), m = mounted(() => { began.resolve(); return new Promise(() => {}) })
  await m.gate(m.f.exec, () => ({ kind: 'allow' })); const request = m.approval()
  await began.promise; await m.dispose()
  assert.equal(await request, 'cancelled'); assert.equal(m.ctx.preset.get(m.f.session), 'workspace-write'); assert.equal(m.ctx.listeners.size, 0)
})
