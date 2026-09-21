# Plan — v0.6 issue 12: workflow vm runtime + host seam

## Context

Issue [12-workflow-runtime](.scratch/v0.6/issues/12-workflow-runtime.md), decided by [wayfinder/tickets/08-workflows.md](../wayfinder/tickets/08-workflows.md) + [research §10](../wayfinder/research/richardh-prior-art.md). `herdr_run_workflow(script | scriptPath, args?)` runs a small JS program in the background inside a Node `vm` sandbox. The script's only route to real work is injected globals — `agent()`, `pipeline()`, `parallel()`, `workflow()`, `phase()`, `log()`, `args`, `budget` — each `agent()` spawning a real herdr pane through the ordinary spawn gates. Two halves:

- **The port** (from tintinweb/pi-subagents, local clone `.scratch/pi-subagents/`, gitignored, MIT): runtime core + worker bootstrap + caps table (1000 agents/run, 4096 items/call, 512 KiB scripts) + determinism jail + un-awaited-`agent()` failure ruling.
- **The host seam** (ours, ~300–400 lines): `agent()` → our spawn machinery — launch plan (08) → pane → completion sidecar → JSONL result (04); the 06 push detection is what the runtime awaits. Option mapping: `agentType` → registry type, `model` → routing chain (exact IDs, enforce-or-error), `effort` → thinking, `isolation: "worktree"` → `isolated`, `gate` → shell command after settle, `resume: <label>` → the 10 resume machinery.

All blockers landed (04 `2a51f5a`, 06 `f6c176f`, 08 `3730aae`, 10 `ba4e70b`). This issue is the first of three workflow issues: 13 adds the resume journal + saved-workflow discovery (+ `name` param), 14 adds the progress card + real budget.

## What already exists (reuse)

| Piece | Where |
|---|---|
| Spawn engine: gates (kill-switch → depth → cap=queue), spec merge, enforce-or-error, registry, queue drain | `src/spawn.ts` `spawnAgent`/`checkGates`/`startRecordNow`/`SpawnDeps` |
| Routing chain level 1 (spawn param model/thinking, exact-ID enforce-or-error naming the level) | `src/launchplan.ts` `resolveRouting`/`validateRouting`/`THINKING_LEVELS` |
| Completion detection (sidecar → JSONL extract → gone), terminal wait loop, typed error payloads | `src/tools/result.ts` `getAgentResult` (+ `src/sessionfile.ts` `readExitSidecar`/`extractSessionResult`/`minedAssistantError`) |
| Resume machinery (registry handle, re-derived plan, message, gates) | `src/tools/lifecycle.ts` `resumeAgent` |
| Push path / steer sink + wake policy (`notifications`) | `src/delivery.ts` `SteeredMessage`/`terminalWake`/`registerDelivery` |
| Registry type (grows a `workflow?` run-id stamp) | `src/spawn.ts` `SpawnRecord` |
| Settings row (already in the table/menu) | `src/settings.ts` `workflows_enabled` |
| Kill path for abort (`pane close`, session retained) | `src/menu.ts` `killAllAgents` pattern |
| `pi.exec` (gate command), `ctx.modelRegistry`/`ctx.model` (routing deps) | pi `ExtensionAPI`/`ExtensionContext` |
| Built-in default type `general-purpose` | `src/agentdefs.ts` `BUILT_IN_AGENTS` |
| Offline harness (jiti + injected seams) | `tests/substrate.mjs`, `tests/delivery.mjs` |

Port sources in the clone: `src/workflow/runtime.ts` (host half), `src/workflow/worker-source.ts` (worker+vm bootstrap), `src/workflow/meta.ts` (meta pre-parse — required even in 12: the vm cannot compile `export`, and upstream `validateScript` = length + control chars + `extractMeta`).

## Approach

### 1. Ported files (new `src/workflow/`, provenance headers + README acknowledgement)

- **`src/workflow/worker-source.ts`** — ported near-verbatim (plain-CJS string; host↔worker↔vm layering, determinism prelude, JSON boundary checks, realm arrays, `parallel`/`pipeline` semantics with `workflowFatal`, option-key validation, `phase`/`log`/`console`/`budget`/`workflow`). Trims for 12:
  - `schema` moves from `AGENT_OPTIONS` to `UNSUPPORTED_AGENT_OPTIONS` ("structured output lands in v0.6 issue 14") — named refusal, not silent drop.
  - `EFFORT_LEVELS` gains `"off"` to match herdr's `THINKING_LEVELS`.
  - Budget: `total: null` (upstream-verbatim), `spent()` → `Infinity` (honest: usage not recoverable until 14 wires JSONL reading), `remaining()` → `Infinity`.
- **`src/workflow/meta.ts`** — ported as-is (scanner, pure-literal vm eval with timeout, `extractMeta`, offset-preserving `export` strip). 13 builds saved-workflow discovery on `hasMetaDeclaration`.
- **`src/workflow/runtime.ts`** — ported host half with the same seams (`WorkflowHost`, `validateScript`, `assertBoundarySafe`, semaphore, caps constants `MAX_SCRIPT_LENGTH`/`WORKFLOW_AGENT_CAP`/`WORKFLOW_ITEM_CAP`/`WORKFLOW_NESTED_CAP`). Trims for 12:
  - journal (replay/`recordJournal`) — out, 13's seam.
  - `WorkflowControl` pause/skip/retry — out (FleetView inspector deferred post-v0.6; card actions are 14).
  - schema compile/`applySchema` — out (stretch, 14 at the earliest).
  - concurrency: `runWorkflow` called with `concurrency: Infinity` — **no separate pool** (issue ruling): pacing flows through the ordinary cap/queue drain. `workflowConcurrency()` (cpus-derived) is not ported. `ponytail:` comment: a 4096-item call creates 4096 queued records; the herdr queue paces pane starts.
  - progress entries: keep the emit machinery + minimal inline `WorkflowEntry` types (the runtime is woven through them; 14 replaces with the ported `progress.ts`). `onProgress` unused in 12.
- **`src/workflow/host.ts`** (ours) — the `WorkflowHost` binding, per `WorkflowHostOptions { pi, ctx, signal, runId }`:
  - `spawnAgent(request)`: map to the spawn engine — `type: agentType ?? "general-purpose"` (resolved through the `.md` registry; **pi-kind enforced** — a non-pi definition is a per-agent refusal, since result/resume/gate all ride the pi substrate), `model`/`thinking: effort` (routing level 1 — `validateRouting` errors name the level; surface as per-agent failure, not run-fatal, upstream-style), `isolated: isolation === "worktree"`, `name: label ?? first-line-of-prompt` (uniquified by the engine), `wait: false`. Then await completion via **`getAgentResult({ target: handle, wait: true })`** — the 06 detection loop is the completion callback: sidecar `done` → `{ok, text}` (exact JSONL message); sidecar `error`/mined error → typed `{ok:false, error}`; `blocked` → keep waiting (decided: wake + wait — the delivery loop's blocked wake still lands, and the orchestrator model or the human answers via `herdr_message_agent`; the run can be killed via kill-all); `gone` → typed error. Result view maps to `WorkflowSpawnResult`.
  - `abortAgent(agentId)`: `herdr pane close <paneId>` (the kill-all path; session retained, record reads `gone`).
  - `resumeAgent(agentId, prompt)`: label → handle map; delegates to the 10 `resumeAgent` machinery (`{target: handle, message: prompt}`), then re-awaits `getAgentResult`.
  - `runGate(command, {cwd})`: `pi.exec` with `["cmd","/c"]`/`["sh","-c"]`, 10-min timeout, run's abort signal; non-zero/killed → `{ok:false, output}`. Runtime's `applyGate` turns a failing gate into a failed agent (typed error, `null` to the script).
  - `loadWorkflow`: omitted in 12 → `workflow()` refuses fatally ("arrives with saved-workflow discovery, issue 13").
- **`src/workflow/runs.ts`** (tiny, ours) — the background-run registry: start a run (Worker + runtime), keep run id → {meta, status, progress, worker}; `stopAll()` on session shutdown — upstream-verbatim: the run signal aborts and `finish` closes every in-flight child host-side (sessions retained, resumable); a run does not outlive its session, and orphaned children whose run died would silently deliver nothing (their per-child pushes are run-stamped away). Completion: one steered push (upstream's notification): meta.name + completed/failed counts + replay of `log()` lines + JSON-checked return value, wake per `terminalWake(notifications)`; a failed run wakes always.

### 2. `src/spawn.ts` — one field

`SpawnRecord.workflow?: string` (run id). Stamped by the host so delivery can hold per-child pushes.

### 3. `src/delivery.ts` — the run reports, not the children

In `deliverOnce`, records with `workflow` set skip the **terminal** done/error/gone branches (the run's own completion push reports for them). Blocked wakes and takeover notes still land — decided: a blocked workflow child wakes the orchestrator and the runtime keeps waiting (a `herdr_message_agent` answer resumes it); takeover disables auto-exit as usual. Watchdog unchanged.

### 4. `src/tools/workflow.ts` — the tool (surface 9 → 10)

`herdr_run_workflow({ script?, scriptPath?, args? })` (`scriptPath` wins over `script` — the edit-and-re-run loop; saved `name` arrives with 13). Gate: `workflows_enabled: false` → clean refusal. Validate source (`validateScript`) + `assertBoundarySafe(args)` before anything runs; write the script to the run's scratch file (`<tmp>/pi-herdr-<uid>/…/tasks/<runid>.workflow.js`) and report its path (the edit-and-re-run loop; 13's journal lands beside it). Return immediately: `Workflow "<name>" started in the background. Run ID: wf_xxx. Script: <path>. You will be notified when it finishes — do NOT poll or sleep waiting for it.` Registered in `src/index.ts`; `session_shutdown` → `stopAll()`.

### 5. Docs

`docs/tools/workflow.md` (new), README surface list + **MIT provenance acknowledgement** for the ported files (tintinweb/pi-subagents), CHANGELOG, `docs/development.md` test count.

## Steps

- [x] 1. Port `meta.ts` + `worker-source.ts` with trims; provenance headers
- [x] 2. Port `runtime.ts` (no journal/control/schema; `Infinity` concurrency; inline entry types) — TDD against a stub `WorkflowHost` like upstream's: determinism jail, eval/Function EvalError, caps (script/item/agent), un-awaited `agent()` ruling message, option-key + effort + isolation + resume-exclusivity validation, boundary checks, `parallel`/`pipeline` semantics (stage `(prev, item, index)`, throw → null, fatal propagates), budget shape, `meta` pure-literal contract
- [x] 3. `SpawnRecord.workflow` + delivery terminal-push skip (offline red-green in `tests/delivery.mjs` style)
- [x] 4. Host seam `host.ts` (TDD with injected `SpawnDeps`/fake `getAgentResult`): option mapping (type/model enforce-or-error/effort/isolation/name), non-pi type refusal, gate pass/fail → typed error, blocked → wait, abort → pane close, resume mapping
- [x] 5. `runs.ts` + tool registration + `workflows_enabled` gate + index wiring (offline: gate refusal, immediate return shape, script scratch file)
- [x] 6. `tests/workflow.mjs` in `npm test`; `tests/workflow-live.mjs` (one live 3-agent fan-out completes and reports) in `test:live`
- [ ] 7. Docs + README acknowledgement + CHANGELOG; full suite + typecheck; `/code-review`; commit

## Verification

**Pane hygiene (house rule, applies to every suite that touches real panes):** the offline suite never spawns panes (injected seams). `tests/workflow-live.mjs` follows the `lifecycle-live.mjs` rule: every pane id the run opens is tracked (from the spawn records the host creates / `herdr agent list` scoped to the test's tmp cwd) and a `finally` closes them all — including children that blocked, failed, or outlived an aborted run, and the panes of a crashed test. Autonomous children normally auto-exit on settle; cleanup exists exactly for the paths where they don't. No manual pane closing is ever needed to get back to the original chat.

- Offline: `node tests/workflow.mjs` (runtime jail/caps/rulings + host mapping + tool gate), full `npm test`, `npm run typecheck`.
- Live: `node tests/workflow-live.mjs` — a 3-agent `pipeline` fan-out spawns real panes through the gates, the orchestrator receives exactly ONE completion push with the aggregated return value, and the suite leaves zero open panes behind (asserted: a final `herdr agent list` shows none of the tracked panes still open).
- Manual: `workflows_enabled: false` in `.pi/herdr.json` → tool absent from the surface at load (a mid-session toggle refuses new runs until `/reload`).

## Decided (with Andrew)

1. Workflow children are **pi-only**: `agentType` resolves through the registry, a definition whose kind names a non-pi CLI is a per-agent refusal (named, never coerced), and the host pins `kind: "pi"` so `default_kind` drift cannot slip a child onto another harness — the result contract (JSONL, sidecar, resume) is pi substrate.
2. A **blocked** child wakes and waits: the 06 blocked wake lands, `agent()` stays pending, and an answer via `herdr_message_agent` (model or human) resumes the child; kill-all remains the stop hatch.
3. `workflows_enabled: false` **removes the tool from the surface** (ticket checkbox; evaluated at registration) AND refuses new runs at execute (the mid-session hot-reload path) — never stops one in flight.
4. Session shutdown ends live runs upstream-style: the run signal aborts and in-flight children are closed host-side (sessions retained) — an orphaned child would settle into suppressed pushes and deliver nothing.

## Review reconciliations (two-axis review, applied)

- **Non-pi agentType** (both axes, hard): the host pinned `kind: "pi"` silently where the ruling says refuse — now a named per-agent refusal via the `.md` registry resolution, before the spawn engine is called.
- **`workflows_enabled` semantics** (spec, hard): execute-gate only contradicted the ticket checkbox — added the registration-time gate (tool absent at load) beside the execute-time hot-reload refusal.
- **Shutdown semantics** (standards, doc): the plan text said children outlive the session; the code (and upstream) abort them — plan + comments reconciled to the code's ruling.
- **Push-sink duplication** (standards, judgement): `runs.ts` re-implemented delivery's steer sink — extracted `makeDeliverySink(pi)` in `delivery.ts`, both consumers share it.
