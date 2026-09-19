# Glossary

Terms as used across pi-herdr docs, the wayfinder map, and tickets. Decisions live in `wayfinder/`, not here. Updated for v0.6 (the subagent experience layer).

- **Substrate** — the session-file foundation: children are pi launched with parent-owned session files plus an injected child extension (`agent_done`, session naming, activity recorder, completion sidecars, identity strip). Everything (delivery, statuses, fork, resume, workflows) stands on it.
- **Sidecar** — a small file the injected child extension writes beside the session file: the **completion sidecar** (`<session>.exit`, typed `done`/`error`) and the **activity sidecar** (current tool/streaming, read by the poll loop).
- **Push** — full final assistant message steered into the orchestrator session on completion; wake governed by the `notifications` setting (blocked always wakes).
- **Pull** — `get_agent_result` as an inspection tool: mid-flight snapshot, bounded waits, re-reads. Never the mandatory second step.
- **User takeover** — a human typing into a child pane. Disables auto-close only; the result contract (`agent_done`, session readability) is never revoked.
- **Idle re-arm** — after a takeover, `agent_settled` + N quiet minutes (default 15, setting `idle_rearm_minutes`) auto-delivers the latest final message (labeled *auto-delivered after user steer*) and closes the pane. Any keystroke resets the timer.
- **Stance** — whether a run is **autonomous** (auto-exit on settle, stall pings wake the orchestrator) or **interactive** (pane intentionally open, pings suppressed). Derives from `auto-exit`; overridable per-agent and per-spawn via `interactive`.
- **Projected state** — a status *derived* from sources (herdr inspection, activity snapshots, watchdog), never stored as ground truth. Ten: `queued`, `starting`, `active`, `waiting`, `blocked`, `interrupted`, `stalled`, `running`, `finalizing`, `gone`.
- **Watchdog** — the supervisor that flags `stalled` (inspection unhealthy / pane gone without a sidecar) and steers recovery pings; aged-but-valid `active`/`waiting` never stalls.
- **Session mode** — how a child session begins: `standalone` (fresh), `lineage-only` (header link, no turns), `fork` (parent conversation copied, truncated before the parent's last user message).
- **Launch plan** — the composed pi argv for a spawn (`--session`, `-e`, `--model`/`--thinking` from routing, system-prompt mode, identity/mode-hint blocks, task-as-artifact), handed to herdr's `agent start --kind`.
- **Routing chain** — model/thinking resolution order: spawn param > frontmatter > `models.agents.<name>` > `models.default` > parent session's model; enforce-or-error names the level that supplied a bad value.
- **Registry** — the orchestrator-side map handle → {session path, activity path, launch plan, stance, last-seen state}. Survives pane death (`gone`); the backbone of get/resume/statuses.
- **Agent kind** — which CLI runs in an agent pane. v0.6 promises are pi-only; other kinds get bare pane mechanics via the passthrough.
- **Agent-message** — the protocol envelope (`<agent-message from="…" to="…">`) carrying inter-agent text; a convention, never verified. The open channel (`message_agent`) is anyone↔anyone; `orchestrator` is the reserved role handle resolving via `PI_HERDR_ORCHESTRATOR_PANE`.
- **Orchestrator** — the role of the session that spawned you. Addressed by the reserved role handle, not by name.
- **Workflow** — a small sandboxed JS program (`agent()`/`pipeline()`/`parallel()`/…) run by `herdr_run_workflow` in the background; determinism-jailed (replayable), journaled (resumable by prefix), saved as `.pi/workflows/*.js`.
- **Determinism jail** — `Date.now()`/`new Date()`/`Math.random()` throw inside workflow scripts; a script that varies run-to-run cannot be replayed from its journal.
- **Resume journal** — per-run `<id>.workflow.jsonl` recording each settled `agent()` call; `resumeFromRunId` replays the unchanged prefix and pays only for what changed.
- **Kill-switch** — the settings gate that refuses new agent spawns. It never terminates anything; see *kill all agents*.
- **Kill all agents** — the `/subagents config` menu action that terminates every running agent pane, after confirmation.
- **Queued agent** — an accepted spawn with no pane yet because the fleet is at its concurrency cap; it starts when a slot frees.
- **Spawn depth** — how many spawns deep an agent is from the originating session; the guard against runaway recursive fleets (`PI_HERDR_SPAWN_DEPTH`).
- **Floor** — the minimum supported herdr version: ≥0.9.0, hard-checked at init (`HERDR_TOO_OLD` below it).
