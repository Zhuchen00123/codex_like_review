import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createInvestigator } from '../src/investigation.js'
import { createReviewer } from '../src/reviewer.js'
import { createHostReviewer } from '../src/host-reviewer.js'
import { resolveConfig } from '../src/index.js'
import { loadGuardianPolicy } from '../src/prompt.js'
function setup(t) {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.guardian-control-test-')), cwd = path.join(root, 'workspace')
  fs.mkdirSync(cwd); fs.writeFileSync(path.join(cwd, 'safe.txt'), 'safe evidence'); fs.writeFileSync(path.join(cwd, '.env'), 'secret value')
  const action = { toolName: 'bash', argsText: '{}', context: { transcript: [], environment: { cwd }, planned_action: { arguments: {} } } }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, cwd, action, investigator: createInvestigator(action) }
}
const inspect = (tool, operation, target) => tool.execute('guardian_inspect', JSON.stringify({ operation, path: target }))
const verdict = '{"outcome":"allow","risk_level":"low","user_authorization":"high","rationale":"verified"}'
test('inspection permits scoped reads and metadata, rejects arbitrary execution and secrets', async (t) => {
  const { investigator, action } = setup(t)
  assert.equal((await inspect(investigator, 'read', 'safe.txt')).text, 'safe evidence')
  assert.equal((await inspect(investigator, 'stat', 'safe.txt')).kind, 'file')
  assert.equal((await inspect(investigator, 'list', '.')).total, 2)
  assert.equal((await inspect(investigator, 'read', '.env')).error, 'protected-content')
  assert.equal((await inspect(investigator, 'read', '../outside.txt')).error, 'outside-investigation-scope')
  await assert.rejects(() => inspect(investigator, 'execute', 'git status'), /invalid-inspection/)
  assert.equal(createInvestigator(action, { allowInvestigation: false }), undefined)
})
test('explicit action paths can be inspected; directory links cannot escape workspace', async (t) => {
  const { root, cwd, action } = setup(t), outside = path.join(root, 'outside')
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'data.txt'), 'outside')
  fs.symlinkSync(outside, path.join(cwd, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal((await inspect(createInvestigator(action), 'read', 'escape/data.txt')).error, 'outside-investigation-scope')
  action.context.planned_action.arguments = { file_path: path.join(outside, 'data.txt') }
  assert.equal((await inspect(createInvestigator(action), 'read', path.join(outside, 'data.txt'))).text, 'outside')
})
test('inspection output and calls are bounded and abort cancels further inspection', async (t) => {
  const { cwd, investigator } = setup(t); fs.writeFileSync(path.join(cwd, 'big.txt'), 'a'.repeat(10000))
  const result = await inspect(investigator, 'read', 'big.txt'); assert.equal(result.truncated, true); assert.equal(result.text.length, 8192)
  for (let i = 0; i < 5; i++) await inspect(investigator, 'stat', 'safe.txt')
  await assert.rejects(() => inspect(investigator, 'stat', 'safe.txt'), /investigation-limit/)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(() => investigator.execute('guardian_inspect', '{}', controller.signal), /aborted/)
})
function response(output = [], text = '') {
  return (text ? 'data: '+JSON.stringify({ type: 'response.output_text.delta', delta: text })+'\n\n' : '')+'data: '+JSON.stringify({ type: 'response.completed', response: { model: 'codex-auto-review', output, usage: { total_tokens: 10 } } })+'\n\n'
}
test('Codex tool round reads evidence then returns verdict without executing planned action', async (t) => {
  const { action } = setup(t), requests = []
  const call = { type: 'function_call', call_id: 'inspect-1', name: 'guardian_inspect', arguments: '{"operation":"read","path":"safe.txt"}' }
  const reviewer = createReviewer({ ...resolveConfig({ retries: 0 }), policyBundle: loadGuardianPolicy() }, {}, {
    readCredential: () => ({ ok: true, access: 'test', accountId: 'test' }),
    transport: { request: async (req) => { requests.push(JSON.parse(req.body)); return { status: 200, headers: {}, body: requests.length === 1 ? response([call]) : response([], verdict) } } },
  })
  const result = await reviewer.review(action)
  assert.equal(result.status, 'verdict'); assert.equal(result.meta.investigationCalls, 1); assert.equal(result.meta.totalTokens, 20)
  assert.equal(requests[0].tools[0].name, 'guardian_inspect')
  const evidence = JSON.parse(requests[1].input.at(-1).output)
  assert.equal(evidence.role, 'untrusted-evidence'); assert.equal(evidence.result.text, 'safe evidence')
})
test('Codex cannot execute unregistered tools or accept mixed tool/verdict output', async (t) => {
  const { action } = setup(t)
  for (const [name, text] of [['bash', ''], ['guardian_inspect', verdict]]) {
    const reviewer = createReviewer({ ...resolveConfig({ retries: 0 }), policyBundle: loadGuardianPolicy() }, {}, {
      readCredential: () => ({ ok: true, access: 'test', accountId: 'test' }),
      transport: { request: async () => ({ status: 200, headers: {}, body: response([{ type: 'function_call', call_id: 'bad', name, arguments: '{"operation":"stat","path":"."}' }], text) }) },
    })
    assert.equal((await reviewer.review(action)).status, 'unavailable')
  }
})
test('DSH model uses the same bounded inspection capabilities and resumes with untrusted evidence', async (t) => {
  const { action } = setup(t); let rounds = 0, evidence
  const reviewer = createHostReviewer({ ...resolveConfig(), policyBundle: loadGuardianPolicy(), reviewProvider: 'test', reviewModel: 'test' }, { async *stream(options) {
    assert.equal(options.tools.length, 1)
    if (++rounds === 1) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'inspect', name: 'guardian_inspect', arguments: '{"operation":"stat","path":"safe.txt"}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      evidence = JSON.parse(options.messages.at(-1).content[0].text)
      yield { type: 'text-delta', text: verdict }; yield { type: 'finish', reason: { kind: 'stop' } }
    }
  } })
  const result = await reviewer.review(action)
  assert.equal(result.status, 'verdict'); assert.equal(result.meta.investigationCalls, 1); assert.equal(evidence.result.kind, 'file')
})
