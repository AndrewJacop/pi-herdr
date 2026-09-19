---
label: wayfinder:grilling
status: closed
assignee: Andrew
blocked-by: [01-substrate, 03-status-projection]
---

## Question

The two lifecycle action tools: cancelling a child's current turn, and bringing a dead child back. `interrupted` is a promised state (ticket `03`) and needs an action that produces it; resume reverses v0.5-01's "no resume" scope-cut — cheap now precisely because the substrate owns session files.

## Resolution

1. **`herdr_interrupt_agent(target)`** — turn-level cancel: sends Escape to the child pane via the existing escape-send machinery, wired into the projection so the state flips to `interrupted` immediately (not on next poll). Session stays alive — pane, session file, watcher intact; stale pre-interrupt activity snapshots are discarded so a lagging reading cannot overwrite the interrupt; new work returns it to `active` naturally. Composes with `herdr_message_agent` as stop-and-redirect. Pi-only promise; non-pi panes get an honest refusal. It is a turn cancel, not a terminate — closing panes is the kill-all menu action or pane close.
2. **`herdr_resume_agent(target, message?)`** — target is a **registry handle, never a raw path**; the registry holds the retained session file (ticket `01` retention ruling). Mechanics:
   - Relaunch `pi --session <retained-path>` in a fresh pane with a **re-derived launch plan** — the definition's kind/model/thinking as resolved *now* (ticket `04` chain), not the stale runtime of the dead process — plus the optional `message` submitted as the opening prompt.
   - The run re-enters normal supervision: widget row, watchdog, push-on-completion (ticket `02`).
   - Same gates as any spawn: parallel cap, spawn depth, kill-switch.
   - Stance follows the agent's autonomous/interactive flag — autonomous resumes auto-exit-and-push again; interactive resumes stay open for a human.
3. **The recovery story (the user's scenario):** a child crashed, errored (sidecar `error`), or its pane closed — registry entry `gone` **with session path intact**; `resume_agent` on a `gone` agent is the documented recovery move, and the child boots with its full conversation, not from scratch.
4. **Honest limit:** resume replays the session file — anything that lived only in the dead process is gone. Since we own the file from boot, that is the whole truth and it is cheap.
