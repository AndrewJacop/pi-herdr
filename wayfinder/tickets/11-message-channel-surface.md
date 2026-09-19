---
label: wayfinder:grilling
status: open
assignee:
blocked-by: []
---

## Question

The exact `message_orchestrator` / `message_agent` parameter and return surfaces for the herdr-native open message channel. Anchors already settled — do not re-open: charter item 7 (no broker, open fleet anyone↔anyone, all kinds via CLI convention, return address in `PI_HERDR_ORCHESTRATOR_PANE`, blocking ask/reply deferred post-v0.5); ticket `07`'s env-contract discipline (`PI_HERDR_*` = single-value scalars only; register: `PI_HERDR_ORCHESTRATOR_PANE`, `PI_HERDR_SPAWN_DEPTH`, `PI_HERDR_AGENT_LABEL`, `PI_HERDR_NO_SELF_REPORT`); ticket `06` (both tools in the visible-11); ticket `10` (shared `wait?: ms|true` vocabulary, handle|pane-id resolution chain, six-state status vocabulary, verify-before-act on `agent get`).

Decide: params for each tool (`message_agent` target addressing — handle|pane-id like `steer_agent`? `message_orchestrator` = text only via env return address?); the delivery mechanism — how a message physically reaches a pane child (steer-style text injection vs a herdr pane-metadata channel vs file+notice) and what is honestly promisable per kind; how a pi child's own pi-herdr surfaces an inbound message (injected prompt next-turn? a tool the child model calls?); return shapes; and whether/how an inbound message wakes or notifies a busy child (interplay with ticket `04`'s watcher and ticket `10`'s status flips). Also: what a non-pi child sees (CLI convention) without promising structure we can't enforce (charter 8 fidelity honesty).

Feeds the fog item on spawn-prompt etiquette (how spawners pass names down) — that item sharpens against this spec.
