# Host recipe — disposable DSH profile that loads the codex-guardian plugin and raises a real approval

Verified on this machine on 2026-10-06. Every command and every output block below was actually run;
nothing here is inferred from source alone unless it is explicitly labelled **(source-read, not run)**.

## 0. Environment facts (measured)

| Fact | Value |
|---|---|
| `node --version` | `v22.19.0` |
| `npm --version` | `10.9.3` |
| `pnpm --version` | `11.15.1` |
| `dsh --version` | `0.1.7-alpha.2` |
| `dsh` resolves to | `D:\node_global\dsh.ps1` → `D:\node_global\node_modules\@deepseek-ai\dsh\lib\bin.js` |
| DSH packages root | `D:\node_global\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\` |
| Real `$env:DSH_HOME` | `C:\Users\15185\.dsh` (never written to by anything in this recipe) |
| Disposable DSH home | `F:\codexprojects\codex_like_review\.dsh-poc` (inside the workspace) |
| Boot wall time, `--help` mount only | **2.9 s** (plugin mounted) |
| Boot wall time, live one-shot headless run | **16.3 s** (plugin mounted, one model turn) |
| Boot wall time, bundle route live run | **19.6 s** |

**No network and no `pnpm install` is used anywhere in this recipe.** The plugin is dependency-free
(`node:` builtins only) and is mounted straight out of its source directory.

## 1. The profile boot (the part that already worked)

`dsh` composes a profile from patch layers over an empty root entry list. Layer order (from
`@deepseek-ai/dsh-app-boot`):

1. each bundle in the profile `package.json`'s `dsh.profile.bundles`, in order;
2. the profile's own `$DSH_HOME/profiles/<name>/cordis.patch.yml`;
3. the home-level `$DSH_HOME/cordis.patch.yml`;
4. each `--patch <file>` overlay, in argv order;
5. a derived telemetry switch.

Every layer except (1) is a **top-level YAML array of loader patch entries**. `--patch` is therefore the
right lever, and it never has to touch a committed profile file.

Patch-entry schema (from `dsh --profile poc --dump-config-schema`, `$defs.patchList` → `$defs.patch`):

```yaml
- insert:                     # appends entries, optionally inside the group named by id
    - id: <entry-id>          # stable id inside the containing entry tree
      name: <module specifier> # what the loader imports
      config: {...}           # optional
      disabled: false         # optional
      group: false            # optional
      inject: [...]           # optional
- id: <existing-entry-id>      # or: retarget an existing row
  config: {...}               # config is replaced wholesale, not deep-merged
  disabled: true
```

Boot a disposable profile (all writes land inside the workspace):

```powershell
$env:DSH_HOME = "F:\codexprojects\codex_like_review\.dsh-poc"
New-Item -ItemType Directory -Force -Path $env:DSH_HOME | Out-Null
dsh --from-default-profile headless --profile poc --dump-config-schema   # seeds the profile, prints the schema
```

`--from-default-profile headless` seeds `profiles/poc/{package.json,cordis.patch.yml,pnpm-workspace.yaml}` with
the shipped `headless` bundle list (`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-headless`). `dsh --profile poc --help`
boots the app's own `--help` and exits **without running a task**, so it is the cheap mount-only smoke test.

> Gotcha: `dsh --help` / `--dump-config` / `--dump-config-schema` **rewrite** `profiles/<name>/cordis.yml`
> every time. Running them against `--profile web` or `--profile desktop` would have written into
> `C:\Users\15185\.dsh\profiles\...`. The DSH file sandbox blocked it in this session; do not retry such a
> write with an escalation. Always pass an explicit disposable `DSH_HOME`.

## 2. Loading the plugin from its LOCAL DIRECTORY

### What the loader does with an absolute path (verified)

`anchorInsertedPluginNames()` in `dsh-app-boot` rewrites any `insert[].name` that is absolute or starts with
`./`/`../` into a `file:` URL **anchored beside the patch file**. So a `--patch` overlay can name a local path
directly — but only a **file**, not a directory:

| `insert[].name` form | Result |
|---|---|
| `F:\...\dsh-plugin-codex-guardian\src\index.js` — **absolute path to the entry module** | **WORKS** (verified, run F) |
| `F:\...\host-scratch\probe-plugin` — absolute path to a **directory** | **SILENTLY DOES NOT MOUNT** (verified, run E) |
| `dsh-plugin-codex-guardian` — bare name, resolvable from the profile dir | **WORKS** (verified, runs B and H) |

The directory form exits 0 and prints the app help exactly like a successful boot, but the plugin's `apply()`
never runs — Node rejects a `file:` URL directory import and the loader only logs that at a level this headless boot
does not surface. **Never point `insert[].name` at a directory.**

### Recommended: route (a) — absolute path to the entry module (no junction at all)

This is the cheapest working mechanism and needs nothing added to the profile.

`notes\host-scratch\patch-f-real.yml`:
```yaml
- insert:
    - id: codex-guardian
      name: F:\codexprojects\codex_like_review\dsh-plugin-codex-guardian\src\index.js
      config:
        enabled: true
```

```powershell
$env:DSH_HOME = "F:\codexprojects\codex_like_review\.dsh-poc"
dsh --profile poc --patch "F:\codexprojects\codex_like_review\dsh-plugin-codex-guardian\notes\host-scratch\patch-f-real.yml" --help
```

Real captured output (run F, `exit=0 wall=2.86s`):

```
Usage: dsh --profile headless [options] [task...]

Answer one task and exit; the answer goes to stdout and diagnostics to stderr.

Arguments:
  task               the task text; multiple words are joined by spaces, and `-`
                     reads stdin

Options:
  --json             write newline-delimited run events to stdout instead of the
                     final message
  --session-id <id>  adopt the persisted Session with this id; an unknown id is
                     an error
  -h, --help         show this help

Examples:
  dsh --profile headless "run the tests"          answer one task and exit
  echo "run the tests" | dsh --profile headless   read the task from stdin
  dsh --profile headless --json "run the tests"   emit machine-readable run events
  dsh --profile headless --session-id session-… "continue"   resume an existing Session
```

Note: `ctx.logger.info` is a **no-op in this headless boot** — the plugin's own
`codex-guardian: mounted: ...` line never reaches stdout or stderr. The mount has to be proven
out-of-band; see §2.4.

### Alternative: route (c) — bare name via a junction in the profile's `node_modules`

This is the production-shaped route: the plugin keeps its real name and (optionally) its
`dsh.bundle.patch`, so the plugin's own `cordis.patch.yml` layer applies. It also lets the plugin
import the installation's own packages (`@deepseek-ai/cordis`, …) with no `node_modules` of its own, because
`linkedProfileRoots()` treats a link under the profile's `node_modules` whose target lies outside the profiles
tree as a *linked root* and routes bare names through the installation-scope package table.

```powershell
$m = "F:\codexprojects\codex_like_review\.dsh-poc\profiles\poc\node_modules"
New-Item -ItemType Directory -Force -Path $m | Out-Null
New-Item -ItemType Junction -Path "$m\dsh-plugin-codex-guardian" `
         -Target "F:\codexprojects\codex_like_review\dsh-plugin-codex-guardian"
```

Then either add the name to the profile's bundle list (`profiles/poc/package.json`):

```json
{
  "name": "dsh-profile-poc",
  "private": true,
  "dependencies": {},
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-headless",
    "dsh-plugin-codex-guardian"
  ] } }
}
```

…or keep the profile pristine and insert the bare name from an overlay instead:

```yaml
- insert:
    - id: codex-guardian
      name: dsh-plugin-codex-guardian
      config:
        enabled: true
```

`pnpm link`, a `link:` dependency and `pnpm install --offline` are **not needed** for either variant —
the junction alone is enough, and the plugin directory has no `node_modules`.

Left in place by this investigation: the disposable `poc` profile currently has **both** routes wired —
`dsh.profile.bundles` ends with `dsh-plugin-codex-guardian`, and the junction
`profiles\poc\node_modules\dsh-plugin-codex-guardian` → the plugin directory exists. Route (a) is
independent of both, and re-running §4 step 2 with both wired still boots cleanly (`exit=0`, 3.5 s); the
`--patch` insert of the same `id` simply supersedes the bundle's row. Remove the name from
`dsh.profile.bundles` (or delete the junction) to test one route at a time.

### 2.4 Proving the plugin mounted in-process

Because no host log line is visible, prove the mount by reading the live loader tree from a second
scratch plugin. The composed rows live in nested `Entry.subtree.store` (the root store holds only
`cordis:include`), and a mounted entry carries `fiber.state === 2` (ACTIVE).

`notes\host-scratch\probe-tree.mjs` (already written) walks the tree and prints every entry id with its
fiber state; `notes\host-scratch\patch-f2-real-and-tree.yml` mounts it after the real plugin.

Real captured output from a live run with the real plugin mounted (run G, `exit=0 wall=16.28s`):

```
[tree-probe] tick=1 nodes=97 target=present fiberState=2 names=[include,tool-plugin-manager,plugin-manager,timer,hmr,llm,deepseek-llm-api-extensions,session,session-log-deepseek,typert,typert-loader,typert-gateway,session-title,session-title-llm,user-questions,agent,plugin-package-inventory-deepseek,agent-default-model,jobs,llm-retry,config-editor,settings,authorization,deepseek-account,credentials,llm-pi-ai,session-persistence-jsonl,attachment-local,session-query-sqlite,session-projection,storage,storage-json,storage-domain,session-projection-cache,session-telemetry-otel,subprocess,sandbox,sandbox-policy,bash-sandbox,pwsh-sandbox,approval,permission,shell-env,tool-bash,tool-pwsh,tool-jobs,fs-observation-policy,tool-fs,tool-fs-search,agent-instructions,skill,skill-filesystem,skill-badge,tool-skill,commands,command-feedback,goal,goal-round-driver,command-goal,plan-mode,token-meter,compaction-basic,command-compact,subagent,subagent-spawn-in-process,subagent-fork-in-process,tool-subagent-control,tool-subagent-list-agents,tool-subagent,tool-subagent-fork,ptc-runtime,workflow-ptc,tool-workflow,timeout-policy,spill-local,spill-policy,session-checkpoint-policy,tool-result-pruner,image-offload,tool-todo,tool-goal,tool-ralph,repeat-tool-reminder,web,web-search-deepseek,web-fetch-http,tool-web,mcp-resources,tools,system-prompt,agent-loop,fs-sandbox,llm-deepseek,headless-startup,headless-runner,codex-guardian,guardian-tree-probe]
[tree-probe] TARGET codex-guardian: present fiberState=2 (tries=30)
```

`fiberState=2` on `codex-guardian` is the in-process mount proof: the entry exists in the composed
tree **and** its fiber is active. The same probe verified the bundle route (run H, `exit=0 wall=19.59s`).

## 3. Raising a real `approval/request`

### The seam (source-read)

`@deepseek-ai/dsh-user-approval` `ApprovalService.request(req)`:

1. throws unless the session currently sits inside an open turn (`turn/start` with no `turn/end`);
2. appends `approval/asked` to the session log;
3. dispatches the cordis **waterfall `approval/request`** with default `'unavailable'`;
4. appends `approval/decided` with the outcome.

The only in-tree answerers registered on that waterfall are `@deepseek-ai/dsh-acp` and
`@deepseek-ai/dsh-client-ui-approval` (the browser client). **Neither is composed by `dsh-base`/`dsh-headless`**,
so a bare headless profile resolves every ask to `unavailable` (fail closed) — but the ask itself is real
and durable.

### Which tool makes the ask, and under what condition

`@deepseek-ai/dsh-tools` `serviceAsk()` calls `approval.request(...)` when the `tools/pre-execute`
waterfall returns `{ kind: "ask" }`. That gate is produced either by a hook plugin
(`@deepseek-ai/dsh-hooks-claude-code` maps a `permissionDecision: "ask"` hook to it) or, on the
sanctioned path, by a **sandbox escalation**: the `write`/`edit` tool family (`@deepseek-ai/dsh-tool-fs`)
and the `pwsh`/`bash` tool family (`@deepseek-ai/dsh-tool-pwsh`) both accept a `sandbox_permissions` +
`justification` argument pair and call `approveEscalation()` (`@deepseek-ai/dsh-sandbox`), which calls
`approval.approver.request({ agent, toolName, callId, reason: 'escalate sandbox to <mode>: <justification>', signal })`
**before anything executes**.

Condition that makes it fire:

- `@deepseek-ai/dsh-sandbox-policy` `mode` defaults to `process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`
  (confirm with `dsh --profile poc --dump-config` → `- id: sandbox-policy ... mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`);
- `@deepseek-ai/dsh-user-approval` `policy` = `'ask'` unless the mode is `danger-full-access`
  (`(process.env.DSH_PERMISSION_MODE ?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask'`);
- `WIDER_MODES = { 'read-only': ['workspace-write','danger-full-access'], 'workspace-write': ['danger-full-access'] }`,
  so under `workspace-write` the only legal escalation target is `danger-full-access`.

**On this machine, trigger it with the `write` tool, not `pwsh`/`bash`.** The Windows `pwsh` sandbox
(`@deepseek-ai/dsh-pwsh-sandbox`, disabled on non-Windows) failed at the ACL runner here
(`Error: sandbox-local windows-acl temp grant materialization failed and its cleanup also failed`), so it never
produced a denial to ground the escalation. The in-process filesystem fence (`@deepseek-ai/dsh-fs-sandbox`)
works and produces the documented marker.

### The verified prompt (copy-pasteable)

Run it with the disposable profile plus the overlay that points the credential store at the machine's real store
**read-only** (`patch-c-live.yml`; the store only writes on `set`/`unset`, which this run never calls):

```powershell
$env:DSH_HOME = "F:\codexprojects\codex_like_review\.dsh-poc"
$s = "F:\codexprojects\codex_like_review\dsh-plugin-codex-guardian\notes\host-scratch"
dsh --profile poc --patch "$s\patch-c-live.yml" `
  "Use the write tool to create the file Q:\guardian-probe.txt with the content probe. If and ONLY if that write is denied by the file sandbox, retry the exact same write once with sandbox_permissions 'danger-full-access' and justification 'Probe the approval seam for codex-guardian plugin verification.'. Do not use any other tool. Then print the retry tool result text verbatim and reply with the single word DONE."
```

The target path must be outside the workspace and must be a path that cannot be written for any other
reason; `Q:\` is a drive letter that does not exist on this machine, so even a granted escalation cannot
create a file. The denial is by fence policy, before the filesystem is touched.

Do **not** ask for a speculative escalation with no denial behind it: the headless model's own sandbox guidance
refuses it (observed in the first live run — the model ran the command without `sandbox_permissions` and explained why).
The two-step "attempt, get denied, retry" shape is what makes it work.

### Real captured session log (run G, the **real plugin mounted**)

The audit pair is durable; this is the raw session log (`approval/asked` + `approval/decided`), not stdout.
The prompt produced **exactly one** ask:

```
EVENT sandbox/mode | {"mode":"workspace-write"}
EVENT approval/policy | {"policy":"ask"}
EVENT turn/start | {"turn":1}
EVENT tool/call | {"turn":1,"step":1,...,"name":"write","arguments":"{\"file_path\": \"Q:\\\\guardian-probe3.txt\", \"content\": \"probe\"}"}
EVENT tool/result | {..., "content":[{"type":"text","text":"Error: [sandbox: file access denied under workspace-write mode]\n[sandbox: escalation available — retry this exact operation once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]"}], "isError":true}
EVENT tool/call | {"turn":1,"step":2,...,"name":"write","arguments":"{\"content\": \"probe\", \"file_path\": \"Q:\\\\guardian-probe3.txt\", \"sandbox_permissions\": \"danger-full-access\", \"justification\": \"Probe the approval seam for codex-guardian plugin verification.\"}"}
EVENT approval/asked | {"id":"cf5a8ac9-c5e7-47f6-bad6-65cc14dc849e","toolName":"write","callId":"call_00_34ZUf7YipTSIG4FvMPH35984","reason":"escalate sandbox to danger-full-access: Probe the approval seam for codex-guardian plugin verification."}
EVENT approval/decided | {"id":"cf5a8ac9-c5e7-47f6-bad6-65cc14dc849e","outcome":"allowed-once"}
EVENT tool/result | {..., "content":[{"type":"text","text":"Error: ENOENT: no such file or directory, mkdir '\\\\?'"}], "isError":true}
EVENT turn/end | {"turn":1,"reason":{"kind":"completed"}}
```

`outcome: "allowed-once"` here came from **the codex-guardian plugin's own answerer** — that run had
no scratch answerer mounted. The plugin really answered a live approval request end-to-end.

### Baseline without an answerer (run D, real escalation, no guardian)

Same prompt, `--patch patch-c-live.yml --patch patch-d-answerer.yml`, where `probe-answerer.mjs` records the ask
and returns `allowed-once`:

```
[probe-answerer] installer registered on approval/request
[probe-answerer] ask intercepted: toolName=write callId=call_00_YUjp6R7nktZlJsEPdwzi7653 reason="escalate sandbox to danger-full-access: Probe the approval seam for codex-guardian plugin verification."
[probe-answerer] returning allowed-once (auto-grant)
Retry tool result text, verbatim:
Error: ENOENT: no such file or directory, mkdir '\\?'
```

With no answerer at all, the same ask resolves the other way and the tool is denied with exactly:

```
Error: sandbox escalation to "danger-full-access" requires approval, but no approval channel is available
```

That message is emitted by `approveEscalation()` in `@deepseek-ai/dsh-sandbox`, and it is itself proof that
the ask reached `approval.request` and found no answerer. **A bare `dsh headless` run can raise the ask but cannot
grant it**; granting needs an answerer (the plugin under test, or the `dsh web` client UI).

### Other triggers (source-read, not run)

- **Deterministic, no model needed for the ask itself:** mount `@deepseek-ai/dsh-hooks-claude-code` with a
  `PreToolUse` hook returning `{"permissionDecision":"ask"}`; it returns `{ kind: "ask" }` from
  `tools/pre-execute`, which reaches the same `approval.request`. (`@deepseek-ai/dsh-hooks-codex` can only deny.)
- **Interactive, grants possible:** `dsh web --profile poc --patch ...` on a spare port with the disposable
  `DSH_HOME`; the browser client plugin registers the answerer, so the user can actually click Allow.

## 4. Copy-pasteable end-to-end sequence

```powershell
# 1. disposable home + profile (all writes inside the workspace)
$env:DSH_HOME = "F:\codexprojects\codex_like_review\.dsh-poc"
$s = "F:\codexprojects\codex_like_review\dsh-plugin-codex-guardian\notes\host-scratch"
New-Item -ItemType Directory -Force -Path $env:DSH_HOME | Out-Null
dsh --from-default-profile headless --profile poc --dump-config-schema > "$s\schema.json"

# 2. mount the real plugin from its LOCAL DIRECTORY by absolute path (no junction, no pnpm, no network)
dsh --profile poc --patch "$s\patch-f-real.yml" --help      # boots + mounts + exits; ~2.9 s

# 3. raise exactly one real approval ask (needs the real store, read-only, for the model turn)
dsh --profile poc --patch "$s\patch-c-live.yml" `
  "Use the write tool to create the file Q:\guardian-probe.txt with the content probe. If and ONLY if that write is denied by the file sandbox, retry the exact same write once with sandbox_permissions 'danger-full-access' and justification 'Probe the approval seam for codex-guardian plugin verification.'. Do not use any other tool. Then print the retry tool result text verbatim and reply with the single word DONE."
```

## 5. Gotchas worth remembering

- `--profile <name>` **writes** `profiles/<name>/cordis.yml` on every `--dump-config*` and `--help` run. Always set a disposable `DSH_HOME`; never point these at `web`/`desktop`.
- A shim-only `package.json` is enough for a profile — `dependencies` may stay empty; `dsh.profile.bundles` is what selects the layers.
- `insert[].name` accepts a bare package name, a `file:`/absolute path to a **module file**, or a `./`-relative path. It does **not** work for a directory, and that failure is silent.
- The `write`/`edit` and `pwsh`/`bash` tool families both escalate; on this Windows host only the `write` family can produce the grounding denial.
- `ctx.logger.info` produces no visible output in the headless boot; use a probe plugin or the session log for evidence.
- Session logs are multi-frame concatenated zstd (one frame per append); a single `zstdDecompressSync` call decodes only the first frame. See `notes\host-scratch\read-session.mjs`.
- Approval asks require an **open turn**, so a real ask always needs at least one model turn; there is no model-free way to raise one.

## 6. Scratch files

| File | Purpose |
|---|---|
| `notes\host-scratch\patch-a-absfile.yml` | probe by absolute path to a module file (works) |
| `notes\host-scratch\patch-b-bare.yml` | probe by bare name via junction (works) |
| `notes\host-scratch\patch-c-live.yml` | read-only credential-store overlay for live runs |
| `notes\host-scratch\patch-d-answerer.yml` | scratch `allowed-once` answerer (grant path) |
| `notes\host-scratch\patch-e-absdir.yml` | probe by absolute DIRECTORY (silently fails) |
| `notes\host-scratch\patch-f-real.yml` | real plugin by absolute path |
| `notes\host-scratch\patch-f2-real-and-tree.yml` | real plugin + tree probe |
| `notes\host-scratch\patch-g-live-real.yml` | real plugin + tree probe + credentials (run G) |
| `notes\host-scratch\patch-h-tree-only.yml` | tree probe only, for the bundle route (run H) |
| `notes\host-scratch\probe-plugin\` | scratch probe + answerer plugins |
| `notes\host-scratch\probe-tree.mjs` | live tree inspection probe |
| `notes\host-scratch\read-session.mjs` | multi-frame zstd session-log reader |
| `notes\host-scratch\run-*.stdout.txt` | captured raw output of every run above |
