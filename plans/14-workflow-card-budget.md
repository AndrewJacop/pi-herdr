# Plan — v0.6 issue 14: workflow progress card + budget

## Context

Issue [14-workflow-card-budget](.scratch/v0.6/issues/14-workflow-card-budget.md), decided by [wayfinder/tickets/08-workflows.md](../wayfinder/tickets/08-workflows.md) items 4–7 + [research §10](../wayfinder/research/richardh-prior-art.md). Closes v0.6: the model-facing surface must converge to exactly the twelve tools. Deliverables:

1. **The live progress card** (~300 lines, ours): workflow name, `N/M agents · elapsed`, phase tree with per-agent rows (✔/⟳, label, type, state, tool calls, duration), `log()` lines beneath.
2. **Fleet placement**: workflow agents render in the card + the widget's workflow row, NOT as ordinary fleet rows — the run reports for them.
3. **`budget.spent()`**: real usage where recoverable from the child's session JSONL, else honest `Infinity`; `total` stays `null`.
4. **`schema`/StructuredOutput round trip** (user green-lit the stretch): child-side structured-output tool in the injected extension + validation-and-retry pressure (no forced toolChoice in pi — pressure, not guarantee).
5. **Stop story**: stopping a run = kill-switch / menu action; **twelve-tool convergence check**.

Decisions (user, planning round 1): card **clears at settle** (completion push is the terminal report); unrecoverable usage **poisons spent() to `Infinity`**; stop lives in a **`/subagents` action row** and kill-all also stops runs; **schema is in scope**.

Blockers 11, 12, 13 are done. Upstream references in the clone (`.scratch/pi-subagents/`, gitignored): `src/workflow/progress.ts` (progress model), `src/ui/workflow-card.ts` (card layout), `runtime.ts` (spent mirror on every response; `applySchema` + journalKey schema slot), `src/workflow/json-schema.ts` + `src/structured-output.ts` (schema round trip).

## What already exists (reuse)

| Piece | Where |
|---|---|
| Append-only progress log, last-write-wins by `index`; `onProgress` per batch; entries carry label/agentType/model/phase/state/durationMs/resultPreview/error/skipped/cached | `src/workflow/runtime.ts` |
| Upstream progress model to port: `collapse`/`displayState`/`buildPhaseGroups`/`stats`/`header`/`formatDuration` (incl. `cached` → "from resume journal") | clone `progress.ts` |
| Upstream card layout to port (trimmed): glyphs, phase tree, stat tail, log lines | clone `ui/workflow-card.ts` |
| Upstream schema validator + child tool to port: `compileJsonSchema` (typebox v1 `Check`/`Errors`, object-root, 64 KiB cap), `StructuredOutput` tool (`constrainedSampling`, `prepareArguments`, isError retry) | clone `workflow/json-schema.ts`, `src/structured-output.ts` |
| Widget slot precedent + render-once pattern | `src/child.ts` `renderStrip`, `src/widget.ts` `fleetWidgetOnce` |
| Delivery suppression for run-stamped children (`record.workflow`) | `src/delivery.ts` `deliverTerminal` |
| Run registry + one aggregated completion push | `src/workflow/runs.ts` |
| Session JSONL parsing (tolerant) | `src/sessionfile.ts` `parseSessionEntries` |
| JSONL usage shape: assistant `message.usage.output` per entry; tool calls = `toolCall` content blocks | pi `docs/session-format.md` / `message-types.md` |
| Completion sidecar (typed, forward-compatible parser that ignores unknown fields → `structured` rides `done`) | `src/sessionfile.ts` `parseExitSidecar`, `src/child.ts` `writeSidecar` |
| Child env channel (`PI_HERDR_*` single-value scalars, stamped at spawn) | `src/spawn.ts` `startRecordNow` |
| Resume machinery for the retry backstop prompt | `src/workflow/host.ts` `resumeAgent` |
| Kill-switch action row pattern | `src/menu.ts` `killAllAgents` |
| Offline harness (jiti + stub host + mock pi) | `tests/workflow.mjs`, `tests/widget.mjs`, `tests/workflow-journal-saved.mjs` |

## Approach

### 1. Port the progress model — `src/workflow/progress.ts` (new, ported + trimmed)

Port from clone `progress.ts` with provenance header: `collapse`, `displayState`, `isLive`, phase grouping/merge/summarize, `buildPhaseGroups`, `stats`, `elapsedMs`, `formatDuration`, `header`, `WorkflowDisplayState` types. Trims: no `attempt`/`lastAttemptReason` (no control intents), no size warning (no token-cap setting), no footer gerund/phase label (footer is diagnostics-only per issue 11), no terminal suffix in `header` (card clears at settle — terminal state is the push's job). Upstream entry fields we don't emit (`recordId` is ours already; `thinking`/`requestedThinking`/`fallbackModel`/`tokens`) stay optional in the types or drop out — keep the port compiling against OUR `WorkflowAgentEntry` (runtime.ts's inline entry types move here; runtime imports from progress.ts).

### 2. The card — `src/workflow/card.ts` (new, ours)

- Pure layout: `layoutWorkflowCard(run, now, width)` → string[] (plain text lines; upstream arrangement trimmed to our fields): header `name  N/M agents · elapsed`, phase groups (one box, `╭─├─╰─`), per-agent rows `✔/✘/⟳ label · type · state · N tool calls · 42s` (label column padded to the widest; `cached` rows lead with "from resume journal"), `⎿` log lines beneath, `queued` rows shown, `interrupted` state for mid-flight rows of a killed run (moot while card clears at settle, but displayState derives it for free).
- Mount: second widget slot `ctx.ui.setWidget("herdr-workflow", …)` (placement `aboveEditor`), captured on `session_start`, cleared on `session_shutdown` — same pattern as widget.ts/child.ts.
- Cadence: own 1s `setInterval` (upstream `WORKFLOW_TICK_MS` rationale: static glyphs, only the clock moves), no-op when no live runs, stopped on shutdown. Reads the runs registry **in memory** — not a polling tier (the "one poll loop" ruling is about fleet observation; the card has no I/O).
- Multiple concurrent runs: one block per live run, stacked; widget clears when none are live (clear-once, `shown` flag like widget.ts).

### 3. Live progress — `src/workflow/runs.ts`

- `WorkflowRun` grows `progress: WorkflowEntry[]` (live, via `onProgress` passed to `runWorkflow`) and `endedAt?`.
- Export `liveWorkflowRuns()` (status `running`) for card + widget row.
- `elapsed` for the card = `now - startedAt`.

### 4. Widget workflow row — `src/widget.ts`

- `fleetWidgetOnce`/`buildWidgetModel`: skip records with `record.workflow` (the run reports for them). Their blocked callouts drop out with the row — blocked workflow children still wake the orchestrator via the unsuppressed blocked push (existing behavior).
- Append one row per live run to the table: `MM:SS │ <meta.name> │ running · N/M agents │ <age>`; counts toward the header's ACTIVE side; leaves at settle. Implementation: extend `buildWidgetModel` with a `workflowRows` input so rendering/width logic stays shared.
- Import direction: widget.ts imports `runs.ts`; runs.ts must stop importing delivery.ts or the graph cycles (delivery → widget → runs → delivery). Move `SteeredMessage`/`makeDeliverySink`/`terminalWake` to a small leaf `src/push.ts`; delivery.ts re-exports (runs.ts + menu imports update). Graph stays acyclic.

### 5. Budget — `host.ts` + `runtime.ts` + `worker-source.ts` + `sessionfile.ts`

- `sessionfile.ts`: `sessionUsage(sessionPath): { outputTokens: number; toolCalls: number } | undefined` — sum assistant `usage.output`, count `toolCall` blocks; `undefined` when the file is missing/unreadable.
- `host.ts` `awaitSettled`: after done AND error, look up the record's `sessionPath`; attach to `WorkflowSpawnResult`: `outputTokens?: number` (absent = unrecoverable), `toolCalls?: number`.
- `runtime.ts`: host-owned counter (upstream pattern — one tally, mirrored on every `response` message as `spent`): `spentKnown` accumulates `outputTokens ?? 0`, but any settled live agent with absent `outputTokens` sets `spentUnknown` → mirror `Infinity`. Failed agents count (they burned tokens); journal-replayed agents contribute 0 and never poison. Settle-entry emits gain `toolCalls`.
- `worker-source.ts`: response handler stores `message.spent` into a module-level `let spentTokens`; `budget.spent()` mirrors it; `total: null` and `remaining(): Infinity` unchanged (structured clone carries `Infinity` fine).

### 6. Stop = `/subagents` action row + kill-all

- `runs.ts`: export `stopWorkflowRun(runId)` — abort the run's controller (existing `finish` machinery terminates the worker and closes in-flight children host-side; sessions retained).
- `menu.ts`: when live runs exist, `/subagents` shows a "Stop workflow run" action row → pick from live runs → confirm → stop → notify. Card hints "stop via /subagents".
- `killAllAgents` also calls `stopAllWorkflowRuns()` — today closing panes under a live run lets the script spawn fresh children (whack-a-mole).

### 7. Schema round trip (green-lit)

- **Port `json-schema.ts`** → `src/workflow/json-schema.ts` (near-verbatim: typebox v1 `Check`/`Errors`, object-root rule, 64 KiB cap, smoke-compile). Host-side guarantee: nothing in pi validates tool args, so this is the only enforcement.
- **Worker** (`worker-source.ts`): `schema` moves from `UNSUPPORTED_AGENT_OPTIONS` to `AGENT_OPTIONS`; payload carries it raw; `journalKey` gains `schema: JSON.stringify(schema)` (changed schema breaks the prefix — upstream verbatim).
- **Runtime** (`runtime.ts`): compile once per call (invalid schema = typed per-agent refusal, not run-fatal); `WorkflowSpawnResult` unchanged — host returns the validated JSON as `text`; replayed journal entries re-checked via `applySchema` (a stale journal entry from before the schema changed fails honestly); final `applySchema` after settle/gate ordering as upstream.
- **Transport**: `host.spawnAgent` writes the compiled schema to `workflowScratchDir()/<runId>-<index>.schema.json`; spawn engine gains `extraEnv?: Record<string, string>` on `SpawnInput` → `SpawnRecord` → `childEnv.PI_HERDR_SCHEMA = <path>` (env channel pattern; a path, not inline JSON — Windows env-block limits). The path rides the record so **resumes re-present the tool**.
- **Child** (`child.ts`): when `PI_HERDR_SCHEMA` is set — read + `compileJsonSchema` (invalid file → skip silently, host-side check still guards); register the `StructuredOutput` tool (ported shape: `constrainedSampling {type:"json_schema", strict:"prefer"}`, `prepareArguments` JSON-string recovery, isError retry pressure with up to 5 reported errors); capture last valid payload; `writeSidecar({type:"done", structured})` on the auto-exit/agent_done paths (sidecar parser gains the optional field). No settle-interception retry loop in the child.
- **Retry backstop**: `host.awaitSettled` on a schema'd call — payload present → re-validate host-side, `text` = canonical JSON; absent → one `resumeAgent(handle, structuredRetryPrompt)` (ported wording), re-await, re-check; still absent → typed per-agent failure ("did not report structured output").

### 8. Twelve-tool convergence check

Test: register every tool module against a mock pi (`workflows_enabled: true`) → registered names are EXACTLY `herdr_spawn_agent, herdr_save_agent, herdr_get_agent_result, herdr_message_agent, herdr_interrupt_agent, herdr_resume_agent, herdr_list_agents, herdr_run_command, herdr_read_pane, herdr_wait_output, herdr_send_keys, herdr_run_workflow`; with `workflows_enabled: false` → eleven (workflow tool absent from registration).

## Files to modify

- `src/workflow/progress.ts` (new — ported model), `src/workflow/card.ts` (new — ours)
- `src/workflow/json-schema.ts` (new — ported validator)
- `src/workflow/runtime.ts` (entries from progress.ts; spent mirror; schema compile/apply/journalKey; entry `toolCalls`)
- `src/workflow/worker-source.ts` (budget mirror; `schema` option)
- `src/workflow/host.ts` (usage extraction; schema file + retry backstop)
- `src/workflow/runs.ts` (live `progress`, `endedAt`, `liveWorkflowRuns`, `stopWorkflowRun`; import push.ts)
- `src/push.ts` (new — moved sink factory; `src/delivery.ts` re-exports)
- `src/spawn.ts` (`extraEnv` passthrough)
- `src/child.ts` (StructuredOutput tool + sidecar `structured`)
- `src/sessionfile.ts` (`sessionUsage`; sidecar `structured` field)
- `src/widget.ts` (filter run-stamped rows; workflow row)
- `src/menu.ts` (stop-run action; kill-all stops runs)
- `tests/workflow-card.mjs` (new: progress model, card layout, budget mirror, stop, schema round trip offline), extensions to `tests/widget.mjs`, `tests/workflow.mjs`, `tests/workflow-journal-saved.mjs`, `tests/smoke.mjs` (convergence), `tests/workflow-live.mjs` (live card + budget + one schema'd agent)
- `package.json` (test script), README (workflow section + acknowledgements already cover provenance), CHANGELOG

## Steps

- [x] 1. Move sink factory to `src/push.ts` (delivery re-exports); typecheck green
- [x] 2. `sessionfile.ts`: `sessionUsage` + sidecar `structured` field (offline red-green)
- [x] 3. Runtime/worker: spent mirror + result `outputTokens`/`toolCalls`; entry types move to `progress.ts` (red-green)
- [x] 4. `host.ts`: usage extraction on settle (done + error); poison-to-Infinity covered
- [x] 5. Port `progress.ts` model (unit tests against emitted entry shapes)
- [x] 6. `runs.ts`: live progress + `liveWorkflowRuns` + `stopWorkflowRun`; card tick
- [x] 7. `card.ts` layout + widget mount (offline red-green on layout lines)
- [x] 8. `widget.ts`: filter + workflow row (extend `tests/widget.mjs`)
- [x] 9. `menu.ts`: stop-run action + kill-all stops runs
- [x] 10. Schema: port `json-schema.ts`; worker `schema` option + journalKey slot; runtime compile/apply; spawn `extraEnv` + `PI_HERDR_SCHEMA`; child StructuredOutput tool; host retry backstop (offline red-green at each seam)
- [x] 11. Twelve-tool convergence test; package.json test wiring
- [x] 12. Full suite + typecheck; extend `tests/workflow-live.mjs` (card counts up through a real fan-out, real `budget.spent()`, one schema'd agent returns an object)
- [x] 13. README/CHANGELOG; code-review; commit

## Verification

- **Offline**: `tests/workflow-card.mjs` (progress model collapse/merge, card layout lines, spent mirror incl. poison + replay-doesn't-poison, stopWorkflowRun, schema compile/apply/retry, journalKey schema slot) + extended widget/delivery/workflow/journal suites + convergence test. `npm test` + `npm run typecheck` clean.
- **Live**: extended `tests/workflow-live.mjs` — a 3-agent fan-out renders the card above the editor counting up (phase tree + log lines), children never appear as fleet rows, `budget.spent()` returns a real number mid-run (asserted via a script that logs it), one schema'd agent's answer is a validated object, and the card clears on the completion push.
