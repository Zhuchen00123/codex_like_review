# Approval seam contract — DSH `approval/request` answerer plugin

Author: seam-scout (task-1). Status: **verified against local sources**, gaps marked `UNVERIFIED`.
Purpose: enough detail to write `dsh-plugin-codex-guardian` without reopening DSH sources.

## 0. Sources and roots (read-only)

| Root | What it is |
|---|---|
| `D:\node_global\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\` | CLI install, `@deepseek-ai/dsh` **0.1.7-alpha.2** (`dsh/package.json` → `name: "@deepseek-ai/dsh"`, `version: "0.1.7-alpha.2"`) |
| `C:\Users\15185\AppData\Local\Programs\DeepSeek Harness\resources\app.asar` | Desktop bundle, **its own embedded copy**: `/dsh/package.json` → `"@deepseek-ai/dsh-desktop-runtime"`, `version: "0.2.0-rc.2"` |

Paths below are relative to the CLI root unless prefixed with `app.asar::`.
Extracted comparison copies of the desktop files live in `notes/scratch/asar/` (workspace-only).

Key packages: `dsh-user-approval` (the seam), `dsh-tools` (only `ask` producer + the `ask`→`approval.request` bridge),
`dsh-agent-loop` (appends `tool/call`), `dsh-scope` (waterfall scoping), `dsh-session` (log + `session/event`),
`dsh-client-ui-approval` (reference answerer, client side), `dsh-acp` (reference answerer, host side),
`dsh-api-remotes` (forwards the event to the client).

---

## 1. Registration API — confirmed

A listener is an ordinary **cordis waterfall listener**:

```ts
// dsh-user-approval/lib/types/types.d.ts:76
'approval/request'(this: Scoped<Agent>, req: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome>;
```

Registration surface used by the bundled host-side answerer (`dsh-acp/lib/index.js:1116-1139`):

```js
ctx.on("approval/request", (request, next) => { ... })       // dsh-acp/lib/index.js:1116
```

- Dispatch: `dsh-user-approval/lib/index.js:176`
  `this.ctx.waterfall(scopeTarget(req.agent, req.agent), "approval/request", req, () => Promise.resolve("unavailable"))`.
  The innermost default (`next` of the last listener) is `'unavailable'` → **fail closed**.
- Return a value ⇒ you claim the request. Call `next()` ⇒ delegate to the next listener.
- **Non-vocabulary return value ⇒ normalized to `'unavailable'`** (`dsh-user-approval/lib/index.js:176`, `.then((outcome) => OUTCOMES.includes(outcome) ? outcome : "unavailable", () => "unavailable")`).
  So returning `undefined`, a boolean, or a promise resolving to junk all become a **denial**. A listener that "does nothing" fails the call closed.
- **Throwing (or rejecting) ⇒ also `'unavailable'`** (same line, rejection handler).
- **`this` inside the listener is NOT the agent.** `scopeTarget` builds a fresh routing-only carrier object
  (`dsh-scope/lib/index.js:327-338`: `const carrier = { [Context.filter](ctx) {...} }`), and cordis binds listeners to that
  carrier (`cordis/lib/index.js:259-263`, `.map((hook) => hook.callback.bind(thisArg))`).
  Read the agent from **`req.agent`**, never from `this` (`dsh-scope/lib/types/index.d.ts:14-20`).
- **Agent scoping:** dispatch is scope-filtered. An *untagged* listener registered at a plugin's root scope receives **every**
  agent's requests (`dsh-scope/README.md:42`, `:77`). A listener tagged with a scope key receives only that key and its descendants;
  tag it by registering the listener inside `createScope(ctx, key)` / `scopeTarget`-compatible scope
  (`dsh-scope/lib/types/index.d.ts:65-78`, `:97`). Practical host idiom is root registration + a check on `req.agent`
  (`dsh-acp/lib/index.js:1117-1118`).
- Sibling order is **not** a policy-priority mechanism; one deployment should compose one terminal answerer
  (`dsh-user-approval/README.md:32`). Because a listener that returns anything (including `'unavailable'`) **short-circuits** the rest of the
  waterfall, delegate with `return next()`, not `return 'unavailable'`.

## 2. Outcome vocabulary and semantics — confirmed

```ts
// dsh-user-approval/lib/types/types.d.ts:26
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';
// dsh-user-approval/lib/index.js:30-35
const OUTCOMES = ["allowed-once", "rejected", "cancelled", "unavailable"];
```

- `'allowed-once'` is the **only** grant (`types.d.ts:24`, `lib/index.js:124`); the consumer maps it to `{ kind: 'allow' }`
  (`dsh-tools/lib/index.js:3463-3466`). The three other outcomes deny with distinct model-visible reasons
  (`dsh-tools/lib/index.js:3467-3487`).
- Grants are one-shot per request: the service mints a fresh `ApprovalRequestId` per call and logs an
  `approval/asked` / `approval/decided` pair (`dsh-user-approval/lib/index.js:128-144`).
- **`policy: never` short-circuits before the waterfall**: `if (this.effectivePolicy(session) === "never") return "rejected";`
  (`dsh-user-approval/lib/index.js:175`), so the plugin is never called in a `never` session. Policy default is `"ask"`
  (`lib/index.js:74`), override folded from the last `approval/policy` event (`lib/index.js:152-165`).
- **Abort wins the race**: the service races the answerer promise against `req.signal` and yields `'cancelled'`;
  a late answer is discarded (`dsh-user-approval/lib/index.js:173-188`). Observe `req.signal` in the plugin
  (e.g. pass it to `fetch`) or the HTTP call will keep running after cancellation.
- The ask requires an **open turn**; an idle ask throws before appending anything (`dsh-user-approval/lib/index.js:130`).
  At `approval/request` time the turn is therefore always open, and `req.agent.session` is always present (`lib/index.js:129`).

## 3. `req` shape — no arguments, and how to recover them

```ts
// dsh-user-approval/lib/types/types.d.ts:55-66
export interface ApprovalRequestEvent {
  readonly agent: Agent;
  readonly toolName: string;
  readonly callId?: ToolCallId;   // branded string at type level, plain string at runtime
  readonly reason?: string;
  readonly signal?: AbortSignal;
}
```

**Confirmed: there is no tool-argument field.** Only `toolName`/`reason`/`callId`/`signal`/`agent` cross this seam.
The audit event written by the service carries exactly the same three fields (`dsh-user-approval/lib/index.js:132-137`).

### 3a. RECOMMENDED — stash parsed arguments from `tools/pre-execute` (live, ordered, no parsing)

```ts
// dsh-tools/lib/types/index.d.ts:216-242 (ToolExecutionInput)
readonly callId: ToolCallId;
readonly name: string;
readonly arguments: unknown;      // losslessly JSON-serializable PARSED arguments
readonly agent?: Agent;
readonly signal: AbortSignal;
// dsh-tools/lib/types/index.d.ts:282-287 (ToolExecution extends ToolExecutionInput; arguments are materialized + deep-frozen)
```

```js
// dsh-tools/lib/types/index.d.ts:47 — waterfall declaration
'tools/pre-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>;
```

Plugin side (transparent pass-through, stash by `callId`):

```js
const pending = new Map(); // callId -> { name, arguments }
ctx.on('tools/pre-execute', (exec, next) => {
  pending.set(exec.callId, { name: exec.name, arguments: exec.arguments });
  return next();                       // stay transparent; never return allow/deny/ask here
});
```

Why this is ordered-safe (see §3c): the `ask` is computed from the **same `exec` object** immediately after this waterfall returns
(`dsh-tools/lib/index.js:3225-3229`), so `pending.get(req.callId)` is already populated when `approval/request` fires.
`exec.arguments` is already parsed, validated and deep-frozen — the plugin does no JSON parsing and sees exactly what will run.

Housekeeping: the map must be bounded. Delete on decision and/or on `tools/result`
(`dsh-tools/lib/index.js:3409-3426` emits `tools/result` with the frozen `exec`; `exec.callId` is available).
`tools/result` is observe-only and listener failures are contained (`dsh-tools/lib/types/index.d.ts:85-92`).

Note: `tools/pre-execute` "deliberately cannot rewrite `exec.arguments`" (`dsh-tools/README.md:230`), so the stashed value is authoritative.

### 3b. FALLBACK — read the session log by `callId`

Event (agent loop): appended for **every** model-requested call:

```ts
// dsh-session/lib/types/types.d.ts:354-360
'tool/call': { turn: number; step: number; callId: ToolCallId; name: string; arguments: string };
// arguments = the RAW JSON string exactly as the model produced it (UNPARSED)
```

Read helper (the in-repo idiom, e.g. `dsh-user-approval/lib/index.js:49-56`, `:160-165`):

```js
function argsFor(session, callId) {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {     // session.seq = SessionLogOffset (log length)
    const event = session.eventAt(seq);                        // dsh-session/lib/index.js:1248-1250 = this.log[seq]
    if (event === undefined || event.type !== 'tool/call') continue;
    if (callId !== undefined && event.data.callId !== callId) continue;   // ALWAYS match by callId
    try { return { name: event.data.name, args: JSON.parse(event.data.arguments) }; }
    catch { return { name: event.data.name, args: event.data.arguments }; } // may be non-JSON text
  }
  return undefined;
}
```

Facts that make this safe:

- `tool/call` carries `name` + raw `arguments` string (`dsh-session/lib/types/types.d.ts:349-360`).
- Field paths confirmed by a real consumer: `event.data.name`, `event.data.arguments`
  (`dsh-session-query/lib/index.js:541`); the "raw string, then `JSON.parse`" idiom is at
  `dsh-client-ui-plan/lib/client.js:243-254`.
- `session.seq` is the next seq / log length (`dsh-session/lib/types/index.d.ts:206-207`); `eventAt(seq)` is `this.log[seq]`
  (`dsh-session/lib/index.js:1248-1250`), so a **plain integer works at runtime** (brand function `SessionSeq` is identity plus a
  safe-integer check — `dsh-session/lib/types/types.js:15-19`).
- Event envelope: `{ type, seq, time, data }` (`dsh-session/lib/types/types.d.ts:489-499`).
- **Caveat:** `eventAt` / `snapshotEvents` / `ownEvents` are marked *deprecated — new calls are prohibited*
  (`dsh-session/lib/types/index.d.ts:174-181`, `:182-192`, `:193-199`), yet the core itself still uses them
  (`dsh-user-approval/lib/index.js:50`, `:162`; 30+ call sites across packages). Acceptable for the plugin, but it is a deprecated read path.
- Because parallel tool-call groups append several `tool/call` events (see §3c), **never** take "the latest `tool/call`"; match `data.callId === req.callId`.

### 3c. Third option — live `session/event` observer

`Session.append` synchronously publishes `session/event` (`dsh-session/lib/index.js:1290`, `:1353-1358`; declared at
`dsh-session/lib/types/index.d.ts:63` as `'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void`).
A `ctx.on('session/event', (session, event) => ...)` observer (pattern: `dsh-acp/lib/index.js:1103-1106`) can stash `tool/call`
payloads by `callId` with zero deprecated reads. Same caveat: bound the map.

### 3d. Answering the ordering question: the call is already committed before the ask

Caller code path (`@deepseek-ai/dsh-agent-loop`, scheduler `startCall`):

```js
// dsh-agent-loop/lib/index.js:578-582
const startCall = async (index) => {
  const call = group[index];
  callSeqs[index] = appendToolCall(session, turn, step, call.block);   // 580 — session.append("tool/call", …) FIRST
  started++;
  const prepared = await ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare(call.exec);   // 582 — policy/ask happens HERE or later
// dsh-agent-loop/lib/index.js:681-689
function appendToolCall(session, turn, step, block) {
  return session.append("tool/call", { turn, step, callId: block.id, name: block.name, arguments: block.arguments }).seq;
}
```

…and inside `prepare`:

```js
// dsh-tools/lib/index.js:3225-3229
const gate = await this.ctx.waterfall(carrier, "tools/pre-execute", exec, () => Promise.resolve({ kind: "allow" })); // 3225
const askResolution = gate.kind === "ask" ? await this.serviceAsk(exec, gate) : { decision: gate, approvalCancelled: false }; // 3226
// dsh-tools/lib/index.js:3455-3461
const outcome = await approval.request({ agent: exec.agent, toolName: exec.name, callId: exec.callId,
  ...ask.reason !== void 0 ? { reason: ask.reason } : {}, signal: exec.signal });
```

**PROVEN:** `session.append("tool/call", …)` (line 580) executes **before** `prepare(...)` (line 582) in the same async
function, and `prepare` → `prepareExecution` → `tools/pre-execute` (3225) → `serviceAsk` → `approval.request` (3455) is a
pure sequential chain on the same `exec`. Therefore, when `approval/request` fires:

1. the `tool/call` event for this exact `callId` is **already committed** to `req.agent.session`;
2. the parsed `exec.arguments` have **already** been materialized and frozen (`dsh-tools/lib/index.js:3163-3168`);
3. `req.callId` is that same `exec.callId` (3458), so log/stash lookups match exactly.

The sandbox-escalation ask is even later — it fires from **inside the tool body** (`dsh-tool-bash/lib/index.js:364-378`,
`dsh-tool-pwsh/lib/index.js:335`, `dsh-tool-fs/lib/index.js:1192`, `dsh-tools/lib/index.js:1194`, all calling
`dsh-sandbox/lib/index.js:89-107`), i.e. after pre-execute has already run.

Only skipped-after-abort calls never reach `prepare`; those append a synthetic pair and never ask
(`dsh-agent-loop/lib/index.js:646-679`). So the invitation in §3a/§3b is never missing for a real ask.

`req.callId` is effectively always present in this deployment: `dsh-tools` always passes it (3458), as does the escalation
path (`dsh-sandbox/lib/index.js:98`); only `dsh-acp` explicitly bails when it is absent (`dsh-acp/lib/index.js:1118`).

### 3e. Who actually produces `ask` (and with what reason)

- **Only bundled `ask` producer:** the Codex `PreToolUse` hook bridge —
  `dsh-hooks-claude-code/lib/index.js:248-263`, `if (merged.decision === "ask") return { kind: "ask", ...merged.reason !== void 0 ? { reason: merged.reason } : {} }`.
  So a plugin's `reason` is usually the hook's own reason string or `undefined`.
- **Escalation asks bypass the `ask` gate** and call the approval service directly with
  `reason: \`escalate sandbox to ${mode}: ${justification}\`` (`dsh-sandbox/lib/index.js:95-100`), from
  `dsh-tool-bash` (`sandbox_permissions` + `justification`), `dsh-tool-pwsh`, `dsh-tool-fs`, `dsh-tools` (PTC).
- When `reason` is `undefined` the built-in UI shows "Tool {toolName} requests privileged execution"
  (`dsh-client-ui-approval/lib/client.js:73`, `:220`) — a reviewer plugin should do something equivalent.

## 4. Plugin export shape / service declaration

Cordis plugin modules export `name`, optional `Config` (schemastery), optional `inject` (array of service names), and `apply(ctx, config)`:

```js
// dsh-hooks-codex/lib/index.js:101-118, :346
const name = "hooks-codex";
const inject = ["shell", "sessionProjections"];
const Config = z.object({ configPath: z.string().required(), /* … */ });
function apply(ctx, config) { … }
export { Config, apply, inject, name };
```

```js
// dsh-repeat-tool-reminder/lib/index.js:1344, :1430, :1495 — inject is OPTIONAL (absent here)
const name = "repeat-tool-reminder";
function apply(ctx, config) { … }
export { Config, apply, name };
```

Client-side answerer uses the same shape (`dsh-client-ui-approval/lib/client.js:227-233`, `:288`):

```js
const inject = ["sessions", "remote", "uiSession", "slots", "locale"];
// …
exports.inject = inject;
```

`inject` is a static service-name array; the callback form also exists:
`ctx.inject(["systemPrompt"], (scope) => { … })` (`dsh-user-approval/lib/index.js:79-89`).
**For this plugin `inject` is not required** — an `approval/request`/`tools/pre-execute` listener needs no service.
Declare `inject: ['approval']` only if the plugin itself needs to *ask* (`ctx.approval`); the opportunistic
`ctx.get('approval')` pattern is `dsh-tools/lib/index.js:3440`.

## 5. Reference answerer implementations

**Client-side (Remote Event answerer)** — `dsh-client-ui-approval`:

```js
// lib/client.js:282-284 — registration
ctx.remote.$on("approval/request", function(request, next) {
  return answerApproval(ctx, this, request, next, registerPendingInteraction);
});
```

- `answerApproval` bails when the scope owns no session: `if (sessionId === void 0) return next();` (`:236-238`).
- It builds a `PendingApproval` from `{ toolName, callId?, reason?, signal? }` (`:239-244`), awaits `pending.result`
  (`:252`), and **returns that outcome to the waterfall**; on abort it rejects with a sentinel and calls `next()` (`:253-256`).
- Outcome construction: `answer(outcome)` resolves the pending promise (`:166-172`); the UI's Reject button answers `"rejected"`
  (`:85-88`) and Allow-once answers `"allowed-once"` (`:89-95`); `signal` abort resolves to `signal.reason` (`:155-161`),
  which the service turns into `'cancelled'` (`dsh-user-approval/lib/index.js:178-183`).
- The event reaches the client because `dsh-api-remotes` forwards `approval/request` in `waterfall` mode
  (`dsh-api-remotes/lib/index.js:22-25`).

**Host-side answerer** — `dsh-acp` (`lib/index.js:1116-1139`): `ctx.on("approval/request", (request, next) => …)`;
delegates with `next()` when it does not own the agent or has no `callId` (`:1118`); maps the external decision to
`'cancelled'` / `'allowed-once'` / `'rejected'` (`:1135-1138`).

## 6. Copy-pasteable minimal host plugin

```js
// dsh-plugin-codex-guardian/lib/index.js
import z from '@deepseek-ai/schemastery'; // only needed because Config is declared

export const name = 'codex-guardian';
export const Config = z.object({
  endpoint: z.string().default('http://127.0.0.1:8787/review'),
  timeoutMs: z.number().default(120000),
});
// no `inject` needed: listeners on approval/request + tools/pre-execute require no service

export function apply(ctx, config) {
  /** @type {Map<string, { name: string, arguments: unknown }>} */
  const pending = new Map();

  // 1) Stash the PARSED arguments of every dispatched call, keyed by callId.
  //    Ordered before the ask: dsh-agent-loop:580 appends tool/call, :582 prepares;
  //    dsh-tools:3225 runs this waterfall, :3226/3455 ask.
  ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.callId !== undefined) pending.set(exec.callId, { name: exec.name, arguments: exec.arguments });
    return next(); // stay transparent
  });
  ctx.on('tools/result', (exec) => { pending.delete(exec.callId); }); // observe-only cleanup

  // 2) Decide the ask. Return an outcome to answer, or next() to delegate.
  ctx.on('approval/request', async (req, next) => {
    const call = req.callId === undefined ? undefined : pending.get(req.callId);
    if (call === undefined) return next();          // cannot see the call → delegate, do NOT fail closed
    pending.delete(req.callId);

    let decision;
    try {
      const response = await fetch(config.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: req.signal,                        // cancellation must propagate
        body: JSON.stringify({
          toolName: req.toolName,                  // from the seam
          reason: req.reason ?? null,              // from the seam
          callId: req.callId ?? null,              // from the seam
          arguments: call.arguments,                // recovered (§3a)
          sessionId: req.agent.session.id,          // dsh-user-approval/index.js:129
        }),
      });
      if (!response.ok) return next();
      decision = await response.json();           // { decision: 'allow' | 'deny' }
    } catch {
      return next();                             // any failure → delegate (service maps junk/throw to 'unavailable')
    }
    return decision?.decision === 'allow' ? 'allowed-once' : 'rejected'; // 'allowed-once' is the ONLY grant
  });
}
```

Hard rules for the implementation:

1. Return **only** `'allowed-once'` to allow; anything else denies. Returning a junk value fails closed to `'unavailable'`.
2. Never return without a value (would be `'unavailable'`); use `return next()` to delegate.
3. `req.agent` is the agent; `this` is an opaque routing carrier (`dsh-scope/lib/index.js:327-338`).
4. Do not wait on the model past `req.signal`; the seam yields `'cancelled'` and discards the answer.
5. Never take "the newest" tool call; in parallel groups other calls' `tool/call` events may already be logged. Match `callId`.
6. `arguments` from `exec` is already parsed/frozen; from the session log it is a **raw JSON string** and may be non-JSON text.

## 7. Version matrix / host differences

| Host | Version | `approval/request` waterfall | Ordering path |
|---|---|---|---|
| CLI (`dsh` on PATH → `D:\node_global\dsh.ps1`) | `@deepseek-ai/dsh` **0.1.7-alpha.2** | `dsh-user-approval/lib/index.js:176`, `types/types.d.ts:76` | `dsh-agent-loop/lib/index.js:580→582`, `dsh-tools/lib/index.js:3225→3226→3455` |
| Desktop app (`app.asar`) | `@deepseek-ai/dsh-desktop-runtime` **0.2.0-rc.2** (embedded copy at `/dsh/...`) | identical: `.../dsh-user-approval/lib/index.js:176`, OUTCOMES `:30-35`, `never` short-circuit `:175`, `approval/asked` append `:132` | identical line-for-line: `dsh-agent-loop/lib/index.js:580`, `:582`, `:681-689`; `dsh-tools/lib/index.js:3225`, `:3226`, `:3455` |

So the desktop bundle does **not** expose a different approval API — one plugin implementation works on both. Two caveats:

- The app.asar copy ships **only `.js`** (no `.d.ts`): `/dsh/node_modules/@deepseek-ai/dsh-user-approval/lib/{index,invariant}.js`, `lib/types/*.js`. Type-level imports (`ApprovalOutcome`, `ToolExecution`) are not resolvable there, so write the plugin in plain JS.
- The desktop asar *does* compose answerers (e.g. its own `dsh-acp` `ctx.on("approval/request", …)` at abs byte ~14258660), same as the CLI.

`UNVERIFIED`: whether the CLI/desktop plugin loader will load a third-party plugin from this workspace at all, and which host the plugin is actually mounted under (host-scout's task-2). `UNVERIFIED`: whether a plugin may import `@deepseek-ai/dsh-session` / `@deepseek-ai/dsh-scope` directly by name from its install location (depends on the loader's module resolution); the §3a design needs **no** DSH imports at all, which is why it is recommended.

## 8. Verification notes

- All CLI line numbers read directly from the files listed above.
- Desktop claims derive from files extracted from `app.asar` into `notes/scratch/asar/` (extraction scripts: `notes/scratch/asar-*.mjs`); byte offsets are noted where line numbers are from the extracted copy.
- Scratch artifacts (`notes/scratch/`) are evidence only and are not part of the deliverable.
