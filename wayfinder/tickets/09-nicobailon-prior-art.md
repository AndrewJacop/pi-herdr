---
label: wayfinder:research
status: closed
assignee:
blocked-by: []
---

## Question

What does [`nicobailon/pi-subagents`](https://github.com/nicobailon/pi-subagents) (npm `pi-subagents` — **not** tintinweb's) already do that we shouldn't reinvent? Answer: (1) mechanics of its "Herdr integration" (extension API docs mention it), (2) how its background-child runner works (detached process, result retrieval, notifications), (3) the exact pi-intercom bridge env-var contract (`PI_SUBAGENT_ORCHESTRATOR_TARGET` etc. — who sets what, what the child does with it), (4) its agent `.md` frontmatter schema vs tintinweb's — differences that matter for shared `.pi/agents/` dirs, (5) a borrow/avoid list for pi-herdr v0.5 pane-based spawning with a herdr-native message channel.

Context pointer: findings land on branch `research/nicobailon-prior-art`, file `wayfinder/research/nicobailon-prior-art.md`. Informs tickets `04` (notifications) and `07` (coexistence).

## Resolution

Study complete (merged to `main`: [`wayfinder/research/nicobailon-prior-art.md`](../research/nicobailon-prior-art.md)). Key facts:

- Its herdr integration = status bridge (`pane report-metadata`, single root-session publisher, ttl+seq) + inspector/project panes (`pane split` → `pane run` → binding JSON, verify-before-act, "display pane ≠ lifecycle owner"). All via the herdr CLI — no ground we can't coexist on.
- **It removed the `PI_SUBAGENT_*` env-var bridge (Sep 2026)** in favor of in-process typed metadata, explicitly advising against env-var contracts for structured child config. pi-intercom's current docs still document the contract — ticket `07` must pin which convention actually ships today. Our `PI_HERDR_ORCHESTRATOR_PANE` is a one-string address (like herdr's own `HERDR_PANE_ID`), not structured config — survives, but gets a hard look in `07`.
- Notification reliability worth borrowing for ticket `04`: durable result file deleted only after acknowledged delivery, dedupe key + TTL, replay records for missed deliveries, batching, `triggerTurn`.
- Frontmatter dialects are mutually inert: a shared `.pi/agents/` dir only works if files carry `name`+`description` and authors accept cross-dialect no-ops — feeds ticket `07`.
- **Avoid list for us:** its detached-runner machinery and temp-dir result fan-out — herdr panes give us lifecycle and visibility for free.
