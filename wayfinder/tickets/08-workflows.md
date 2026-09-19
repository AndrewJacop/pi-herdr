---
label: wayfinder:grilling
status: closed
assignee: Andrew
blocked-by: [01-substrate, 02-push-delivery, 04-launch-plan-routing]
---

## Question

Scripted workflow orchestration — **reverses the v0.5 out-of-scope ruling** ("Scripted workflow orchestration (`SubagentWorkflow` equivalent) — not in v0.5"). The user's explicit call after studying tintinweb's implementation (cloned at `.scratch/pi-subagents/`, `src/workflow/` ~4.5k lines; docs/workflows.md studied in full). What we adopt, what we port, what we defer.

## Resolution

1. **The concept (tintinweb's design, verbatim adoption).** A `herdr_run_workflow` tool takes a small JavaScript program — inline `script`, a `scriptPath`, or a saved `name` + JSON `args` — and runs it in the background inside a Node `vm` sandbox. The script has no filesystem, no network, no `eval`; just injected globals: `agent(prompt, opts)` (spawns one subagent, resolves to its final text), `pipeline(items, ...stages)` (barrier-free staged fan-out), `parallel(thunks)` (barrier), `phase()`, `log()`, `args`, `workflow()` (one-level nesting), `budget` (`total` always `null` — same as theirs). Agent options: `label`, `agentType`, `model`, `effort`→thinking, `isolation: "worktree"`, `gate` (shell command must pass), `resume: <label>`, `schema` (stretch, item 7).
2. **The port set (portable, not rewritten):** the vm runtime core + worker bootstrap, `meta` pre-parse (pure literal requirement), the **determinism jail** (`Date.now()`/`new Date()`/`Math.random()` throw — scripts must be replayable), the **resume journal** (`resumeFromRunId` replays the unchanged prefix, pays only for what changed; failures end the prefix by design), saved-workflow discovery (`.pi/workflows/` → `.agents/workflows/` → global, first hit wins; `export const meta = {name, description}` marks a file), limits/caps table (1000 agents/run, 4096 items/call, 512 KiB scripts).
3. **The host seam (ours, ~300–400 lines):** `agent()` calls our spawn machinery — launch plan builder (ticket `04`) → pane → completion sidecar → JSONL result (ticket `01`); the push path (ticket `02`) *is* the completion callback the runtime awaits. Option mapping: `agentType` → registry `type`; `model` → routing chain (exact IDs, no fuzzy resolution — enforce-or-error); `effort` → thinking levels; `isolation` → `isolated: true`; `gate` → shell command after settle; `resume: label` → `resume_agent` machinery; **concurrency flows through the ordinary gates** (cap/queue/kill-switch/depth — no separate pool, unlike theirs).
4. **The progress card (ours, ~300 lines):** a live transcript card — workflow name, `N/M agents · elapsed`, phase tree with per-agent rows (✔/⟳, label, type, state, tool calls, duration), `log()` lines beneath. Workflow agents render in the card and the widget's workflow row, not as ordinary fleet rows (the run reports for them).
5. **Deferred: the FleetView inspector** (pause/skip/retry keys, two-pane descent, conversation viewer) — FleetView-class UI is post-v0.6 in the map; stopping a run = kill-switch / card action for now.
6. **`budget.spent()`** — real where usage is recoverable from session JSONL, else honest `Infinity`; `total` stays `null` exactly as theirs does.
7. **Stretch: `schema`/StructuredOutput** — a child-side structured-output tool in the injected extension + validation-and-retry round trip (pressure, not guarantee — pi has no forced toolChoice). Attempted only after the core loop lands; decided at implementation if at all.
8. **Sequencing: last.** Workflows are a pure consumer of spawn/get/resume/message — the substrate feeds it; build it after tickets 01–07.

**Honesty note:** ported code carries its provenance (tintinweb/pi-subagents, MIT) in the file headers and the README acknowledgements.
