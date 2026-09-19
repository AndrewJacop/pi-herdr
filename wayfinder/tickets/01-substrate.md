---
label: wayfinder:grilling
status: closed
assignee: Andrew
blocked-by: []
---

## Question

The result substrate: how spawned children report, where their sessions live, and what the injected child extension provides. Decided at the v0.6 re-spec grill (2026-09-19) after studying `0xRichardH/pi-subagents` (research/richardh-prior-art.md §2) — their architecture adopted; the v0.5 pane-tail reading demoted.

## Resolution

1. **Parent-owned session files.** Every spawn seeds and owns a child session file: `pi --session <path>` is part of every launch plan. The session JSONL becomes the source of truth for the child's transcript, result, and errors. Result extraction = the exact last assistant message object — no screen scraping, no adaptive tail heuristics, no truncation ambiguity.
2. **Location: pi's default sessions dir.** Files live at `~/.pi/agent/sessions/--<child-cwd>--/<timestamp>_<uuid>.jsonl` — the same place pi puts its own sessions. Consequence (the point of the choice): any spawned session is resumable and perusable from a plain pi session via `/resume` or `pi --session <path|id>`. Isolated worktree spawns file under their own cwd automatically. No custom session directory, no `--session-dir`.
3. **Session naming.** The injected child extension calls `pi.setSessionName("herdr/<spawn-name>")` at boot (a `session_info` entry), so fleet sessions are identifiable in `/resume` and never masquerade as the user's own conversations.
4. **Injected child extension** (loads via `-e`, same channel as today's self-report — that stays):
   - `agent_done` — the child-side completion declaration ("call when the overall task is complete; your final message is pushed to the orchestrator"). Writes the completion sidecar, exits.
   - **Activity recorder** — records what the child is doing right now (current tool, streaming) to an activity sidecar the parent's poll loop reads; powers `active · bash 7m` in the widget (ticket `03`).
   - **Completion sidecars** — `<session>.exit` with typed payloads `{type: done|error|errorMessage?}`; `error` carries the mined `stopReason`/`errorMessage` so provider-overload/retry-exhaustion reaches the parent as a *typed failure*, not a mystery.
   - **Identity/tools strip** — `[scout] — 12 tools · 4 denied (Ctrl+J)` above the child's editor; a human walking into the pane sees what they're in.
   - **Auto-exit** — autonomous children (`auto-exit: true` stance) close on `agent_settled` per ticket `02`; interactive ones never do.
5. **Pane-tail reading demoted to fallback.** The v0.5 adaptive-tail machinery survives only for panes we didn't spawn (non-pi passthrough kinds, adopted panes). It is no longer a result source for pi children.
6. **Registry grows session paths.** The spawn registry maps handle → {session file, activity file, launch plan, stance} — the substrate `get_agent_result`, `resume_agent` (ticket `06`), push delivery (ticket `02`), and the workflow host (ticket `08`) all stand on.
7. **Session retention: always.** Session files are never deleted by pi-herdr. Closing a pane loses nothing; the pane is not the transcript.

**Honesty note:** `agent_settled` (not `agent_end`) is the definitive idle signal — pi may auto-retry/compact/follow-up after `agent_end`; the child extension maps events exactly as `src/selfreport.ts` does today.

**Feeds:** `02` (push reads sidecars + JSONL), `03` (activity recorder), `05` (seeding for session modes), `06` (resume), `08` (workflow host seam).
