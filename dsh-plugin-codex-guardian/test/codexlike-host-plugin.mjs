/** Original ToolRuntime, approval and fs sandbox. Only disposable test files are written. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mountCodexLikeReview, resolveConfig, REVIEW_PRESET } from '../src/index.js'
import { createDenials } from '../src/denials.js'
import { createControlState } from '../src/control-state.js'
import { createBudget } from '../src/breaker.js'
import { installControlService } from '../src/control-service.js'
export const inject = ['approval', 'permissionPresets', 'sessions', 'tools', 'agents', 'fs', 'systemPrompt']
export function apply(ctx) {
  return run(ctx).then(() => { setTimeout(() => process.exit(0), 100) }, (error) => { console.error('[codexlike-host] FAIL', error); setTimeout(() => process.exit(1), 100); throw error })
}
async function run(ctx) {
  const root = path.resolve('.dsh-guardian-deploy/host-sandbox'), cwd = path.join(root, 'workspace')
  fs.mkdirSync(cwd, { recursive: true })
  let result = { status: 'verdict', verdict: { outcome: 'allow', riskLevel: 'low', userAuthorization: 'high', rationale: 'test approval' } }
  let reviews = 0, bodies = 0, askProbe = false, manualEnabled = false, human = 0
  const humanAnswer = ctx.on('approval/request', (_req, next) => { if (!manualEnabled) return next(); human++; return 'allowed-once' }, { prepend: true })
  const settings = resolveConfig(), denials = createDenials(), budget = createBudget(settings)
  const state = createControlState(settings), uiQa = process.argv.includes('--ui-qa')
  let lastAction
  const reviewer = { review: async (action) => { reviews++; lastAction = action; return { ...result, meta: { model: 'host-test-double' } } } }
  if (uiQa) await installControlService(ctx, state, reviewer, budget, denials)
  const dispose = mountCodexLikeReview(ctx, settings, reviewer, { denials, budget, onDecision: (row) => state.record(row) })
  const probe = { name: 'codexlike_host_probe', description: 'Harmless constant-returning test tool.', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_, v) => [{ type: 'text', text: v }] }, execute: () => { bodies++; return 'OK' } }
  const unregister = ctx.tools.register(probe)
  const hostPolicy = ctx.on('tools/pre-execute', (exec, next) => askProbe && exec.name === probe.name ? { kind: 'ask', reason: 'test tool annotation requires approval' } : next())
  const handle = await ctx.agents.create({ sessionId: `session-${randomUUID()}`, meta: { cwd } }), agent = handle.agent, session = agent.session
  const unregisterScoped = agent.ctx.tools.register(probe)
  // A bare programmatic agent has no desktop tool preset. Mount the original
  // fs tool suite in this test agent's scope, as an agent preset would.
  const fsTools = createRequire(ctx.profileContext.installAnchor)('@deepseek-ai/dsh-tool-fs')
  await agent.ctx.plugin(fsTools).await()
  ctx.permissionPresets.set(session, REVIEW_PRESET)
  session.append('user/message', { role: 'user', source: { kind: 'user', rpcId: 'codexlike-host-test' }, content: [{ type: 'text', text: 'Run the harmless probe and write only disposable files under the host-sandbox test folder.' }] }, { surfaceOp: 'append' })
  session.append('turn/start', { turn: 1 })
  session.append('request/header', { header: { config: { provider: 'deepseek', model: 'deepseek-chat' }, tools: agent.ctx.tools.schemas(agent) }, reason: 'initial' })
  let step = 0
  async function execute(name = probe.name, args = {}) {
    step++; const callId = `codexlike-host-${step}`
    session.append('step/start', { turn: 1, step })
    session.append('assistant/message', { turn: 1, step, message: { role: 'assistant', content: [{ type: 'tool-call', id: callId, name, arguments: JSON.stringify(args) }] }, stream: [] }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step, callId, name, arguments: JSON.stringify(args) })
    const output = await agent.ctx.tools.execute({ name, arguments: args, callId, agent, signal: new AbortController().signal })
    session.append('step/end', { turn: 1, step, reason: 'test' }); return output
  }
  try {
    const ordinary = await execute(); assert.equal(ordinary.isError, false, JSON.stringify(ordinary.content)); assert.equal(reviews, 0)
    console.log('[codexlike-host] ordinary tool ran inside mode without review')
    askProbe = true
    assert.equal((await execute()).isError, false); assert.equal(reviews, 1)
    result = { status: 'verdict', verdict: { outcome: 'deny', riskLevel: 'high', userAuthorization: 'low', rationale: 'controlled denial' } }
    const denied = await execute(); assert.equal(denied.isError, true); assert.equal(bodies, 2)
    assert.match(JSON.stringify(denied.content), /controlled denial.*policy circumvention/)
    console.log('[codexlike-host] approval denial prevented body and returned policy feedback')
    result = { status: 'unavailable', reason: 'controlled failure' }
    manualEnabled = true
    assert.equal((await execute()).isError, false); assert.equal(human, 1); manualEnabled = false
    result = { status: 'verdict', verdict: { outcome: 'allow', riskLevel: 'low', userAuthorization: 'high', rationale: '' } }
    const ptc = await execute('run_code', { code: 'return await tools.codexlike_host_probe({})', description: 'Test inner approved call' })
    assert.equal(ptc.isError, false); assert.equal(reviews, 4)
    console.log('[codexlike-host] native manual fallback and PTC inner approval passed')
    const target = path.join(root, `outside-${randomUUID()}.txt`)
    await execute('read', { file_path: target }) // establishes absence for guarded creation
    const before = reviews
    const blocked = await execute('write', { file_path: target, content: 'DISPOSABLE' })
    assert.equal(blocked.isError, true); assert.match(JSON.stringify(blocked.content), /sandbox/); assert.equal(reviews, before); assert.equal(fs.existsSync(target), false)
    const escalated = await execute('write', { file_path: target, content: 'DISPOSABLE', sandbox_permissions: 'danger-full-access', justification: 'Write this one disposable test artifact outside the narrow test cwd.' })
    assert.equal(escalated.isError, false, JSON.stringify(escalated.content)); assert.equal(reviews, before+1)
    assert.equal(fs.readFileSync(target, 'utf8'), 'DISPOSABLE'); fs.unlinkSync(target)
    assert.equal(ctx.permissionPresets.resolve(REVIEW_PRESET).sandbox, 'workspace-write')
    console.log('[codexlike-host] actual fs sandbox blocked outside write; only reviewed one-call escalation wrote the file')
    if (uiQa) {
      console.log('[codexlike-host] UI QA ready: select the synthetic probe denial and approve one retry')
      await new Promise((resolve) => { const timer = setInterval(() => { if (denials.list().some((v) => v.approved)) { clearInterval(timer); resolve() } }, 200) })
      assert.equal((await execute()).isError, false); assert.ok(lastAction.context.explicit_user_override)
      assert.equal(denials.list().length, 0)
      console.log('[codexlike-host] authenticated control-page approval was consumed by exactly one reviewed retry; PASS')
      await new Promise((resolve) => setTimeout(resolve, 60000))
    }
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await dispose(); assert.equal(ctx.permissionPresets.current(session), 'workspace-write')
    assert.ok(!ctx.permissionPresets.names.includes(REVIEW_PRESET))
    console.log('[codexlike-host] unload restored workspace-write; PASS')
  } finally { await dispose(); humanAnswer(); hostPolicy(); unregisterScoped(); unregister(); await handle.dispose() }
}
