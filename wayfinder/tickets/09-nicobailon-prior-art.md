---
label: wayfinder:research
status: open
assignee:
blocked-by: []
---

## Question

What does [`nicobailon/pi-subagents`](https://github.com/nicobailon/pi-subagents) (npm `pi-subagents` — **not** tintinweb's) already do that we shouldn't reinvent? Answer: (1) mechanics of its "Herdr integration" (extension API docs mention it), (2) how its background-child runner works (detached process, result retrieval, notifications), (3) the exact pi-intercom bridge env-var contract (`PI_SUBAGENT_ORCHESTRATOR_TARGET` etc. — who sets what, what the child does with it), (4) its agent `.md` frontmatter schema vs tintinweb's — differences that matter for shared `.pi/agents/` dirs, (5) a borrow/avoid list for pi-herdr v0.5 pane-based spawning with a herdr-native message channel.

Context pointer: findings land on branch `research/nicobailon-prior-art`, file `wayfinder/research/nicobailon-prior-art.md`. Informs tickets `04` (notifications) and `07` (coexistence).
