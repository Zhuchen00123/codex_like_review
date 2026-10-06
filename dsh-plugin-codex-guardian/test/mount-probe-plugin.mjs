/** Verify the shipped apply() mounted, not a test-injected reviewer. No model requests. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
export const inject = ['permissionPresets', 'agents']
export function apply(ctx) {
  const root = ctx.loader.store
  function find(store) {
    for (const [id, entry] of Object.entries(store ?? {})) {
      if (id === 'codex-guardian') return entry
      const nested = find(entry?.subtree?.store)
      if (nested) return nested
    }
  }
  let ticks = 0
  const timer = setInterval(async () => {
    ticks++
    const entry = find(root)
    if (entry?.fiber?.state === 2 && ctx.permissionPresets?.names.includes('auto')) {
      clearInterval(timer)
      try {
        console.log('[guardian-mount] shipped codex-guardian fiber=ACTIVE; Auto registered')
        const handle = await ctx.agents.create({ sessionId: `session-${randomUUID()}`, meta: { cwd: process.cwd() } })
        ctx.permissionPresets.set(handle.agent.session, 'auto')
        await entry.fiber.dispose()
        assert.equal(ctx.permissionPresets.current(handle.agent.session), 'workspace-write')
        assert.ok(!ctx.permissionPresets.names.includes('auto'))
        await handle.dispose()
        console.log('[guardian-mount] shipped plugin fiber disposal restored workspace-write and removed Auto; PASS')
        process.exit(0)
      } catch (error) { console.error('[guardian-mount] FAIL', error); process.exit(1) }
    } else if (ticks === 100) {
      console.error('[guardian-mount] FAIL: Auto integration not active')
      clearInterval(timer); process.exit(1)
    }
  }, 25)
}
