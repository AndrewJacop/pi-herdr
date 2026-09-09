---
label: wayfinder:grilling
status: open
assignee:
blocked-by: [01-spawn-agent-surface]
---

## Question

The exact `get_agent_result` and `steer_agent` parameter surfaces and return shapes. Anchors already decided in ticket `01` (do not re-open): spawn-level `name` is the pane handle (fallback chain), targets address by handle | pane-id; `blocked` is a distinct terminal state — `get_agent_result` returns `{status: "blocked", question, handle}`; spawn's `wait` semantics are bounded-ms-or-until-terminal. Decide: `get_agent_result` params (target, wait/timeout, freshness/poll vs snapshot) and return shape per status (working/idle/done/blocked — what result text, what truncation, what of the transcript); `steer_agent` params (target, text, submit?, wait-for-turn semantics, steering a working vs idle child); whether they replace or pass through to `herdr_read_agent`/`herdr_send_prompt` in the agents surface (zoom ticket `06`); and error semantics for dead/gone panes (zoom ticket `09`'s verify-before-act patterns). Feeds tickets `04` (notification consumption) and `05` (widget status).
