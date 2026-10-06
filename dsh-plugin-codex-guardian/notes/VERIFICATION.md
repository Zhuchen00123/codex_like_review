# Verification record

> Historical record for the 0.1 approval-answerer implementation. The independent
> **0.2 Auto replacement**, desktop-runtime tests, and current limitations are
> recorded in [REPLACEMENT-VERIFICATION.md](REPLACEMENT-VERIFICATION.md).

Everything below was run on this machine on 2026-10-06. Where a claim comes from a
teammate rather than the lead, the raw artifacts are linked so it can be re-checked.

Environment: DSH CLI `0.1.7-alpha.2` (`D:\node_global\dsh.ps1`), desktop bundle
`0.2.0-rc.2` (identical approval API — see `notes/approval-seam.md` §6), node
`v22.19.0`, npm `10.9.3`, pnpm `11.15.1`, CONNECT proxy `127.0.0.1:7897`.

## Level 0 — the route works at all

`node reference\poc2-dsh-route.mjs` (the brief's own PoC, re-run first):

```
HTTP 200   (2379 ms)
model 回执: codex-auto-review   usage=96
模型输出: {"outcome":"allow","risk_level":"low"}
额度(前): 5h=25%  7d=68%      额度(后): 5h=25%  7d=68%
```

Credential source `C:\Users\15185\.dsh\.credentials.yaml`, `access` length 1700,
JWT true, expires 2026-10-12 18:36:55 (+08:00).

## Level 1 — standalone probe, no plugin installed

`node dsh-plugin-codex-guardian\test\route-probe.mjs` (deliverable 2). Real results
reported by probe-dev and reproducible independently:

| run | result |
|---|---|
| `--dry-run` | exit 0; credential len 1700 / JWT true / expires 2026-10-12; policy len 8281, starts `## Environment Profile`; no network |
| `--case allow` | HTTP 200, 2494 ms, `allow` / `low`, `usage.total_tokens=1726` |
| `--case deny` | HTTP 200, 6195 ms, `deny` / `high`, `usage.total_tokens=1752` |
| `--case git` | 3 POSTs sharing one session id, all `allow` / `low`, PASS 3/3 |
| `--timeout 1` | prints `TIMEOUT after 1 ms (request aborted)`, exit 1 |
| non-Guardian instructions | refused (exit 3) unless `--allow-non-guardian-instructions` |
| quota before/after | `primary=25% secondary=68%`, unchanged |
| leak check | the real 1700-char access token and 196-char refresh token do not appear in stdout/stderr |

## Level 2 — the plugin itself, mounted on a fake cordis context

`node dsh-plugin-codex-guardian\test\plugin-smoke.mjs` — **24/24 pass** (20 offline
+ 4 live). It drives the real `apply()` with a fake `ctx` and a fake session log
whose `tool/call` event mirrors what `dsh-agent-loop` appends.

Live assertions (real HTTPS to `chatgpt.com`, verdicts from `codex-auto-review`):

| scenario | observed |
|---|---|
| user-authorized `git status` | `allowed-once`, `next()` not called |
| unauthorized `rm -rf /home/user/Documents` | `rejected`, `next()` not called |
| arguments recovered only from the `tools/pre-execute` index (durable `tool/call` deliberately hidden) | `allowed-once`, and the capture listener stayed transparent |

Delegate-to-human assertions (the important half): non-selected tool, missing
`tool/call` event, unreachable proxy, 1 ms timeout, missing policy file,
`enabled: false`, and a `callId` that matches nothing in the log — all call
`next()`, none returns a decision. Unit coverage also pins the strict-callId rule
(no loose matching), breaker thresholds, the hourly budget, tolerant verdict
parsing (reasoning-first, fenced, multiple objects, braces inside strings), and
`sanitize()` redaction.

## Level 3 — in-host, in a disposable profile (the real thing)

Throwaway home: `F:\codexprojects\codex_like_review\.dsh-poc` (nothing outside the
workspace). Profile `poc` = `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-headless` +
`dsh-plugin-codex-guardian`. Recipe and all raw stdout:
[host-recipe.md](host-recipe.md), [host-scratch/](host-scratch/).

**Mount.** `ctx.logger.info` is a no-op in this headless boot, so the plugin's own
startup line never reaches stdout. A tree probe walking the live loader store
proves the fiber is active:

```
[tree-probe] TARGET codex-guardian: present fiberState=2 (tries=30)   # 2 = ACTIVE, 97 nodes
```

**A/B on the same prompt.** Ask the agent to write `Q:\…` with the `write` tool,
then retry once with `sandbox_permissions: danger-full-access` — the two-step
attempt → denied → retry shape the sandbox documents.

| run | `approval/asked` | `approval/decided` | tool result |
|---|---|---|---|
| `poc` **with** the plugin mounted | `{"toolName":"write","callId":"call_00_3uYso…","reason":"escalate sandbox to danger-full-access: Independent lead verification…"}` | **`{"outcome":"allowed-once"}`** | escalation proceeded → `ENOENT … mkdir '\\?'` (Q: does not exist) |
| `pocbase` **without** any answerer, same prompt | same shape | **`{"outcome":"unavailable"}`** | `Error: sandbox escalation to "danger-full-access" requires approval, but no approval channel is available` |

No other answerer is composed in `dsh-base` + `dsh-headless` (only `dsh-acp` and
`dsh-client-ui-approval` register one, neither is mounted), so the `allowed-once`
is the plugin's own answer. The control run is what makes that conclusion safe
rather than assumed.

The **shipped revision** was re-run after the last source edit and reproduced the
same pair in session `session-f93643e7-db2e-4e30-a4b9-ff757c6997a8`:

```
approval/asked   {"toolName":"write","callId":"call_00_tPzwoStnPlzJpdWI4mLT1147",
                  "reason":"escalate sandbox to danger-full-access: Final revision check…"}
approval/decided {"outcome":"allowed-once"}
```

Raw session events for all three runs are in [host-scratch/](host-scratch/) and
were re-read with `host-scratch/read-session.mjs` (multi-frame zstd).

## Red-line audit

| Rule | Status |
|---|---|
| Do not touch `profiles\desktop` / `profiles\web` | Newest mtime under both is 21:11 (desktop `cordis.patch.yml`), before this session began at 21:34. An early `--profile web` probe was refused by the file sandbox (EPERM) and left no change. |
| Do not modify `dsh-codex-subscription` | Untouched; newest mtime 2026-09-28 13:10. |
| Do not refresh OAuth tokens | No refresh code path exists. The plugin only calls `fs.readFileSync`; `refresh` is parsed but never used, and an expired token is a delegate-to-human outcome. |
| Do not touch `dsh.rc2-failed` | Untouched; mtime 2026-09-27 12:40. |
| No raw tokens in logs or files | Workspace-wide scan for JWT-shaped literals: clean. Log lines carry a 12-hex fingerprint, tool name, and verdict labels only; error text passes through `sanitize()`. |
| Do not use `ctx.llm.stream()` | Not used anywhere. |
| Disposable profile only | All new DSH state lives under `F:\codexprojects\codex_like_review\.dsh-poc`. |

## Not covered — read this before trusting the plugin in production

1. **The in-host deny path was not exercised.** Reproducing a genuine Guardian
   *denial* in-host requires presenting a genuinely destructive action, and the
   only way to know the plugin works is to let the host run it. We declined to
   point a live `danger-full-access` escalation at anything real. The deny →
   `rejected` mapping is proven live at Level 2 against the same model and the same
   policy, but the in-host round trip for a denial is untested.
2. **Desktop host (0.2.0-rc.2) was not booted.** Its approval API is byte-identical
   in the extracted sources (`notes/approval-seam.md` §6), but the plugin was only
   loaded by the CLI host.
3. **"Free" is still unproven.** One review costs ~1.7k tokens end to end, far too
   little to move an integer percent on the usage endpoint, so the unchanged
   `25% / 68%` reading proves nothing either way. Codex's own log shows a
   `codex-auto-review` call hitting a usage limit on the announcement day. Keep
   `usageGuard` and `maxReviewsPerHour` in mind before enabling this long-term.
4. **The `%USERPROFILE%\.codex\auth.json` fallback** was exercised at function
   level, not end-to-end (doing so would have required making the primary store
   unavailable).
5. **Error branches** for non-200 responses and `response.failed` events were never
   observed live; they are code-reviewed only.
