---
label: wayfinder:research
status: open
assignee:
blocked-by: []
---

## Question

What can each agent CLI control at launch, by exact flag/env? Build the capability→flag mapping matrix for `pi`, `claude` (Claude Code), `codex` (OpenAI Codex CLI), plus a brief survey of other kinds in `src/launcher.ts` presets. Per kind: (1) pinning the model, (2) injecting/appending/replacing a system prompt, (3) allowing/denying tools, (4) preloading skills or instruction files, (5) disabling extensions/MCP, (6) non-interactive/headless flags (prompt as argv, exit on completion), (7) worktree-isolation-relevant flags (cwd/git). Evidence-based — cite exact flags and sources; mark UNKNOWN rather than guessing.

Context pointer: findings land on branch `research/capability-matrix`, file `wayfinder/research/capability-matrix.md`. This gates the `spawn_agent` parameter surface (ticket `01`) and the default-agents ticket (`02`): a param is only honest if the underlying kind can enforce it.
