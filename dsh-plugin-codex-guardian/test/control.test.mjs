import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createControlState, EDITABLE, validateSettings } from '../src/control-state.js'
import { createHostReviewer } from '../src/host-reviewer.js'
import { createBudget } from '../src/breaker.js'
import { loadGuardianPolicy } from '../src/prompt.js'
import { createReviewer } from '../src/reviewer.js'
import { resolveConfig } from '../src/index.js'
import { mountAutoReview } from '../src/auto-review.js'
import { fixture, harness } from './fixtures.mjs'
import { listReviewModels } from '../src/model-catalog.js'
function state(t) {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.guardian-control-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const options = { file: path.join(dir, 'settings.json') }
  return { dir, options, store: createControlState(resolveConfig(), options) }
}
test('settings persist across restart and reject stale edits without mutation', (t) => {
  const { store, options } = state(t), reference = store.current, snapshot = { ...reference }
  store.save({ reviewerSource: 'dsh', reviewProvider: 'local', reviewModel: 'test-model' }, 0)
  assert.equal(reference.reviewModel, 'test-model'); assert.equal(snapshot.reviewModel, 'codex-auto-review')
  assert.equal(createControlState(resolveConfig(), options).current.reviewModel, 'test-model')
  assert.throws(() => store.save({ reviewModel: 'stale' }, 0), /settings-conflict/)
  assert.equal(store.view().revision, 1)
})
test('settings reject secret/path/unknown keys and invalid routes or limits', (t) => {
  const { store } = state(t)
  for (const patch of [{ token: 'secret' }, { policyFile: 'evil' }, { timeoutMs: 0 }, { reviewEnabled: 'true' }, { reviewModel: '' }, { reviewerSource: '' }, { reasoningEffort: '' }, { reviewerSource: 'dsh' }, { breakerWindow: 1 }, { reviewModel: 'model\nBearer key' }]) assert.throws(() => store.save(patch, 0))
  assert.equal(store.view().revision, 0); assert.equal(store.current.reviewModel, EDITABLE.reviewModel)
  assert.throws(() => validateSettings([]))
})
test('failed persistence does not publish settings', (t) => {
  const { store, options } = state(t)
  fs.mkdirSync(options.file)
  assert.throws(() => store.save({ reviewModel: 'new-model' }, 0))
  assert.equal(store.current.reviewModel, 'codex-auto-review'); assert.equal(store.view().revision, 0)
})
test('invalid stored routes fall back to defaults with visible warning', (t) => {
  const { options } = state(t)
  fs.writeFileSync(options.file, JSON.stringify({ revision: 4, values: { reviewerSource: 'dsh', reviewProvider: '' } }))
  const loaded = createControlState(resolveConfig(), options)
  assert.equal(loaded.current.reviewerSource, 'codex'); assert.equal(loaded.view().warning, 'stored-settings-invalid')
})
test('audit storage is bounded, persists and excludes arguments, credentials and rationale', (t) => {
  const { store, options, dir } = state(t)
  for (let i = 0; i < 205; i++) store.record({ tool: 'bash', outcome: 'allow', argsText: 'TOPSECRET', accessToken: 'TOPSECRET', rationale: 'TOPSECRET' })
  const raw = fs.readFileSync(path.join(dir, 'reviews.json'), 'utf8')
  assert.ok(!raw.includes('TOPSECRET')); assert.equal(store.view().recent.length, 200)
  assert.equal(createControlState(resolveConfig(), options).view().counters.allow, 200)
  store.clearHistory(); assert.equal(store.view().recent.length, 0)
})
test('hourly budget follows updated settings without resetting usage', () => {
  const config = { maxReviewsPerHour: 1 }, budget = createBudget(config)
  assert.equal(budget.take(), true); assert.equal(budget.take(), false)
  config.maxReviewsPerHour = 2; assert.equal(budget.take(), true); assert.equal(budget.used(), 2)
})
test('model catalog keeps Guardian and registered providers with empty or failed catalogs', async () => {
  const result = await listReviewModels(resolveConfig(), { listProviders: () => [{ id: 'empty', name: 'Empty' }, { id: 'broken', name: 'Broken' }], listModels: async (id) => { if (id === 'broken') throw new Error('catalog unavailable'); return [] } }, false)
  assert.ok(result.models.some((v) => v.id === 'codex-auto-review'))
  assert.deepEqual(result.providers.map((v) => v.id), ['empty', 'broken']); assert.equal(result.dshStatus, 'partial')
})
test('paused Auto asks a human without model calls and records safe metadata', async () => {
  const f = fixture(), ctx = harness(f), records = []
  const dispose = mountAutoReview(ctx, resolveConfig({ reviewEnabled: false }), { review() { throw new Error('must not call') } }, { onDecision: (entry) => records.push(entry) })
  const result = await ctx.listeners.get('tools/pre-execute').handler(f.exec, () => ({ kind: 'allow' }))
  assert.equal(result.kind, 'ask'); assert.equal(records[0].reason, 'paused'); assert.equal(records[0].outcome, 'unavailable'); assert.ok(ctx.permissionPresets.owner)
  await dispose()
})
test('configuration changes apply to next request and preserve in-flight route snapshot', async () => {
  const f = fixture(), ctx = harness(f), config = resolveConfig(), arrived = Promise.withResolvers(), release = Promise.withResolvers(), routes = []
  let calls = 0
  const dispose = mountAutoReview(ctx, config, { async review(action) {
    calls++; routes.push(action.reviewConfig.reviewModel)
    if (calls === 1) { arrived.resolve(); await release.promise; assert.equal(action.reviewConfig.reviewModel, 'codex-auto-review') }
    return { status: 'verdict', verdict: { outcome: 'allow', riskLevel: 'low', userAuthorization: 'high' } }
  } })
  const gate = ctx.listeners.get('tools/pre-execute').handler
  const pending = gate(f.exec, () => ({ kind: 'allow' })); await arrived.promise
  config.reviewModel = 'next-model'; release.resolve(); assert.equal((await pending).kind, 'allow')
  assert.equal((await gate(f.exec, () => ({ kind: 'allow' }))).kind, 'allow'); assert.deepEqual(routes, ['codex-auto-review', 'next-model'])
  await dispose()
})
const verdict = '{"outcome":"allow","risk_level":"low","user_authorization":"high","rationale":"authorized"}'
const action = { toolName: 'bash', argsText: '{}', trusted: ['Inspect status'], environment: {} }
function host(chunks, capture = () => {}) {
  return createHostReviewer({ ...resolveConfig(), policyBundle: loadGuardianPolicy(), reviewProvider: 'test-provider', reviewModel: 'test-model' }, { async *stream(options) { capture(options); for (const chunk of chunks) yield chunk } })
}
test('DSH route uses selected provider/model with no executable tools', async () => {
  let request
  const result = await host([{ type: 'text-delta', text: verdict }, { type: 'usage', usage: { totalTokens: 10 } }, { type: 'finish', reason: { kind: 'stop' } }], (options) => { request = options }).review(action)
  assert.equal(result.status, 'verdict'); assert.equal(result.meta.model, 'test-model'); assert.equal(result.meta.totalTokens, 10)
  assert.equal(request.provider, 'test-provider'); assert.equal(request.tools, undefined); assert.ok(request.system.includes('Output Contract'))
})
test('DSH accepts finalized text-only blocks and rejects mismatches with streamed text', async () => {
  const end = { type: 'finish', reason: { kind: 'stop' } }, block = { type: 'block-end', block: { type: 'text', text: verdict } }
  assert.equal((await host([block, end]).review(action)).status, 'verdict')
  assert.equal((await host([{ type: 'text-delta', text: verdict }, block, end]).review(action)).status, 'verdict')
  assert.equal((await host([{ type: 'text-delta', text: 'different' }, block, end]).review(action)).reason, 'conflicting-output')
})
test('DSH missing finish, error finish, tool-call blocks, conflicting JSON and late data cannot approve', async () => {
  const text = { type: 'text-delta', text: verdict }, end = { type: 'finish', reason: { kind: 'stop' } }
  for (const chunks of [[text], [text, { type: 'finish', reason: { kind: 'error' } }], [text, { type: 'block-start', blockType: 'tool-call' }, end], [text, { type: 'block-end', block: { type: 'tool-call' } }, end], [text, end, text], [{ type: 'text-delta', text: verdict+verdict }, end]]) assert.equal((await host(chunks).review(action)).status, 'unavailable')
})
test('Codex custom model and reasoning are transmitted and exact returned model is required', async () => {
  let request
  const delta = `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: verdict })}\n\n`
  const instance = createReviewer({ ...resolveConfig({ reviewModel: 'custom-model', reasoningEffort: 'high', retries: 0 }), policyBundle: loadGuardianPolicy() }, {}, {
    readCredential: () => ({ ok: true, access: 'test-only', accountId: 'test' }),
    transport: { request: async (options) => { request = JSON.parse(options.body); return { status: 200, headers: {}, body: delta+`data: ${JSON.stringify({ type: 'response.completed', response: { model: 'custom-model' } })}\n\n` } } },
  })
  assert.equal((await instance.review(action)).status, 'verdict'); assert.equal(request.model, 'custom-model'); assert.deepEqual(request.reasoning, { effort: 'high' })
})
