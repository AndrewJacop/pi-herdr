---
label: wayfinder:grilling
status: open
assignee:
blocked-by: [09-nicobailon-prior-art]
---

## Question

Coexistence and naming in a shared ecosystem: `spawn_agent` vs tintinweb's `Agent` tool (no collision by name — confirm and document the pairing story: same `.pi/agents/` dir readable by both, in-process vs pane dispatch); interaction with nicobailon's `pi-subagents` (zoom ticket `09` — its herdr integration may already occupy ground we're claiming, e.g. pane spawning or bridge env vars); pi-intercom's `contact_supervisor` env contract vs our `PI_HERDR_ORCHESTRATOR_PANE` convention (compatible? conflicting? which wins if both installed?); and what the install docs promise when multiple orchestrator extensions are active.
