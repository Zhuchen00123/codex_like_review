/** Deterministic host integration test. The only tool body returns a constant. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mountAutoReview, resolveConfig } from '../src/index.js'

export const name = 'guardian-host-probe'
export const inject = ['approval', 'permissionPresets', 'sessions', 'tools', 'agents']

export function apply(ctx) {
  // This is a dedicated, isolated test process, never a production profile.
  return run(ctx).then(() => { setTimeout(() => process.exit(0), 100) }, (error) => {
    console.error('[guardian-host] FAIL', error)
    setTimeout(() => process.exit(1), 100)
    throw error
  })
}

async function run(ctx) {
  console.log('[guardian-host] test plugin mounted')
  let result = { status: 'verdict', verdict: { outcome: 'allow', riskLevel: 'low', userAuthorization: 'high', rationale: '' }, meta: { model: 'test-double' } }
  let bodies = 0, reviews = 0, humanAsks = 0
  const disposeAuto = mountAutoReview(ctx, resolveConfig(), { review: async () => { reviews++; return result } })
  const tool = {
    name: 'guardian_host_probe', description: 'Return a constant; has no filesystem or network effects.',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (args, value) => [{ type: 'text', text: value }] },
    execute: async () => { bodies++; return 'PROBE_EXECUTED' },
  }
  const unregister = ctx.tools.register(tool)
  const handle = await ctx.agents.create({ sessionId: `session-${randomUUID()}`, meta: { cwd: process.cwd() } })
  const agent = handle.agent, session = agent.session
  ctx.permissionPresets.set(session, 'auto')
  session.append('user/message', { role: 'user', source: { kind: 'user', rpcId: 'guardian-host-test' }, content: [{ type: 'text', text: 'Run the harmless guardian_host_probe.' }] }, { surfaceOp: 'append' })
  session.append('turn/start', { turn: 1 })
  const header = { config: { provider: 'deepseek', model: 'deepseek-chat' }, tools: [{ name: tool.name, description: tool.description, parameters: tool.parameters }] }
  session.append('request/header', { header, reason: 'initial' })
  const execute = async (step, toolName = tool.name, args = {}) => {
    const callId = `guardian-test-${step}`
    session.append('step/start', { turn: 1, step })
    session.append('assistant/message', { turn: 1, step, message: { role: 'assistant', content: [{ type: 'tool-call', id: callId, name: toolName, arguments: JSON.stringify(args) }] }, stream: [] }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step, callId, name: toolName, arguments: JSON.stringify(args) })
    const output = await ctx.tools.execute({ callId, name: toolName, arguments: args, agent, signal: new AbortController().signal })
    session.append('step/end', { turn: 1, step, reason: 'test' })
    return output
  }
  try {
    const allowed = await execute(1)
    assert.equal(allowed.isError, false); assert.equal(bodies, 1); assert.equal(reviews, 1)
    console.log('[guardian-host] allow: tool body executed once')
    result = { status: 'verdict', verdict: { outcome: 'deny', riskLevel: 'high', userAuthorization: 'unknown', rationale: 'Test denial' } }
    const rejected = await execute(2)
    assert.equal(rejected.isError, true); assert.equal(bodies, 1); assert.equal(reviews, 2)
    assert.match(JSON.stringify(rejected.content), /policy circumvention/)
    console.log('[guardian-host] deny: tool body did not execute; rationale returned')
    result = { status: 'unavailable', reason: 'test-offline' }
    const answerer = ctx.on('approval/request', () => { humanAsks++; return 'allowed-once' })
    const human = await execute(3)
    if (human.isError) console.log('[guardian-host] fallback diagnostic', JSON.stringify(human.content), 'asks=', humanAsks)
    assert.equal(human.isError, false); assert.equal(humanAsks, 1); assert.equal(bodies, 2)
    assert.ok(session.snapshotEvents().some((event) => event.type === 'approval/decided' && event.data.outcome === 'allowed-once'))
    answerer()
    console.log('[guardian-host] unavailable: real approval service invoked answerer and persisted decision')
    result = { status: 'verdict', verdict: { outcome: 'allow', riskLevel: 'low', userAuthorization: 'high', rationale: '' } }
    const ptcAllowed = await execute(4, 'run_code', { code: 'return await tools.guardian_host_probe({})', description: 'Run the harmless probe via PTC' })
    if (ptcAllowed.isError) console.log('[guardian-host] PTC diagnostic', JSON.stringify(ptcAllowed.content))
    assert.equal(ptcAllowed.isError, false); assert.equal(bodies, 3); assert.equal(reviews, 4)
    result = { status: 'verdict', verdict: { outcome: 'deny', riskLevel: 'high', userAuthorization: 'unknown', rationale: 'Test PTC denial' } }
    const ptcDenied = await execute(5, 'run_code', { code: 'return await tools.guardian_host_probe({})', description: 'Run the harmless probe via PTC' })
    assert.equal(ptcDenied.isError, true); assert.equal(bodies, 3); assert.equal(reviews, 5)
    console.log('[guardian-host] PTC: inner allow executed; inner deny blocked; outer transport was not double-reviewed')
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await disposeAuto()
    assert.equal(ctx.permissionPresets.current(session), 'workspace-write')
    assert.ok(!ctx.permissionPresets.names.includes('auto'))
    console.log('[guardian-host] unload: workspace-write restored; Auto removed; PASS')
  } finally {
    await disposeAuto(); unregister(); await handle.dispose()
  }
}
