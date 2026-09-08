---
label: wayfinder:grilling
status: open
assignee:
blocked-by: [08-capability-matrix]
---

## Question

The exact `spawn_agent` parameter surface and semantics: `type` vs inline `agent:` definition (field set for on-the-fly agents), `name`, per-call `kind`/`model` overrides, `isolated` (worktree) param, background-by-default vs `wait: true`, blocked-agent handling (does a blocked child surface as a distinct result/notification?), resume semantics (if any), and where the max-spawn-depth check hooks in. Constraint: every param must be honestly enforceable per kind — zoom ticket `08`'s matrix before deciding; drop or mark per-kind-optional anything that isn't. Charter items 2/3/4 in the map's Notes are settled — this ticket specifies, not re-opens.
