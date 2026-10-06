export function fixture({ ptc = false, source = { kind: 'user', rpcId: 'human-1' }, text = 'Please run this project test.', args = { value: 'probe' } } = {}) {
  const schema = { name: 'guardian_probe', description: 'A harmless probe returning its value.', parameters: { type: 'object', properties: { value: { type: 'string' } } } }
  const rootName = ptc ? 'run_code' : schema.name
  const rootArgs = ptc ? { code: 'tools.guardian_probe({value:"probe"})' } : args
  const events = []
  const push = (type, data, visible = false) => {
    const event = { type, data, seq: events.length }
    events.push(event)
    if (visible) surface.nodes.push(event.seq)
    return event
  }
  const surface = { nodes: [] }
  push('user/message', { source, content: [{ type: 'text', text }] }, true)
  push('turn/start', { turn: 1 })
  push('step/start', { turn: 1, step: 1 })
  push('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'tool-call', id: 'root-1', name: rootName, arguments: JSON.stringify(rootArgs) }] } }, true)
  push('tool/call', { turn: 1, step: 1, callId: 'root-1', name: rootName, arguments: JSON.stringify(rootArgs) })
  if (ptc) push('tool/ptc-dispatch-start', { subCallId: 'inner-1', parentCallId: 'root-1', rootCallId: 'root-1', name: schema.name, arguments: args })
  const session = {
    id: 'session-probe', header: { cwd: process.cwd() }, surface, events,
    snapshotEvents: () => events, eventAt: (seq) => events[seq],
    get seq() { return events.length },
    requestHeader: () => ({ tools: [schema] }),
    append: (type, data) => push(type, data), isOwnSeq: () => true,
  }
  const controller = new AbortController()
  const cancellations = []
  const agent = { session, cancel(cause) { cancellations.push(cause); controller.abort() } }
  const exec = { name: schema.name, arguments: args, callId: ptc ? 'inner-1' : 'root-1', rootCallId: 'root-1', agent, signal: controller.signal, ...(ptc ? { parent: Symbol('parent'), schema } : {}) }
  return { session, agent, exec, schema, push, controller, cancellations }
}

export function harness(f) {
  const listeners = new Map(), logs = [], policies = new Map(), preset = new Map([[f.session, 'auto']])
  let owner
  const ctx = {
    logs, listeners, preset, policies,
    logger: { info: (line) => logs.push(line) },
    on(event, handler, options) {
      listeners.set(event, { handler, options })
      return () => listeners.delete(event)
    },
    effect(generator) {
      const disposers = []
      try { for (const dispose of generator()) if (typeof dispose === 'function') disposers.push(dispose) }
      catch (error) { for (const dispose of disposers.reverse()) dispose(); throw error }
      return async () => { for (const dispose of disposers.reverse()) await dispose() }
    },
    sessions: { list: () => [...preset.keys()] }, agents: { get: () => f.agent },
    approval: { overrideOf: (session) => policies.get(session) },
    permissionPresets: {
      current: (session) => preset.get(session) ?? 'workspace-write',
      set: (session, value) => { preset.set(session, value); policies.set(session, 'ask') },
      registerAuto(admit) {
        if (owner) throw new Error('Auto already registered')
        owner = admit
        return () => { owner = undefined }
      },
      get owner() { return owner },
    },
  }
  return ctx
}
