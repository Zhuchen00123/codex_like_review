/** Exact-action, one-retry user approval. Payloads stay in memory, never audit files. */
import { createHash, randomUUID } from 'node:crypto'
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
// A UI-directed bare retry message resumes the task without changing its scope.
// Any other human message (especially new restrictions) invalidates the grant.
const resumeOnly = (row) => row.role === 'human-instruction' && /^(?:请)?(?:重试(?:一次|刚才批准的(?:动作|操作))?|继续(?:执行)?|retry(?: once| the approved action)?|continue)[。.!！]?$/i.test(row.text.trim().normalize('NFKC'))
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  return value
}
export function actionIdentity(action, sessionId) {
  return digest({ sessionId, cwd: action.context.environment.cwd, tool: action.toolName, args: canonical(action.context.planned_action.arguments),
    schema: canonical({ description: action.context.planned_action.description, parameters: action.context.planned_action.parameters, mode: action.context.planned_action.mode }),
    scope: action.context.transcript.filter((v) => ['human-instruction', 'direct-parent-instruction', 'project-constraint'].includes(v.role) && !resumeOnly(v)) })
}
export function createDenials(clock = () => Date.now()) {
  const records = new Map(), lifetime = 10*60_000
  function prune() { for (const [id, row] of records) if (clock()-row.created > lifetime) records.delete(id) }
  return {
    record(action, sessionId, verdict) {
      prune()
      const row = { id: randomUUID(), sessionId, created: clock(), identity: actionIdentity(action, sessionId), tool: action.toolName,
        cwd: action.context.environment.cwd, arguments: structuredClone(action.context.planned_action.arguments), risk: verdict.riskLevel, rationale: verdict.rationale, approved: false }
      records.set(row.id, row)
      const own = [...records.values()].filter((v) => v.sessionId === sessionId)
      for (const stale of own.slice(0, -10)) records.delete(stale.id)
      // Also bound inactive-session memory in long-running hosts.
      while (records.size > 100) records.delete(records.keys().next().value)
      return row.id
    },
    list() { prune(); return [...records.values()].reverse().map(({ id, sessionId, created, tool, cwd, risk, rationale, approved }) => ({ id, sessionId, created, tool, cwd, risk, rationale, approved })) },
    detail(id) { prune(); const row = records.get(id); if (!row) throw new Error('denial-expired'); return structuredClone(row) },
    approve(id) { prune(); const row = records.get(id); if (!row) throw new Error('denial-expired'); if (row.approved) throw new Error('denial-already-approved'); row.approved = true },
    consume(action, sessionId) {
      prune(); const identity = actionIdentity(action, sessionId)
      const row = [...records.values()].find((v) => v.approved && v.identity === identity)
      if (!row) return undefined
      records.delete(row.id)
      return { role: 'explicit-user-override', denial_id: row.id, authorization: 'The human approved this exact action for ONE retry using the authenticated review control. This is additional authorization, not an execution grant. Reassess risk and follow all policy; critical risk and absolute denies remain denied.' }
    },
    clear() { records.clear() },
  }
}
