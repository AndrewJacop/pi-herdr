---
label: wayfinder:research
status: closed
assignee:
blocked-by: []
---

## Question

What can each agent CLI control at launch, by exact flag/env? Build the capability→flag mapping matrix for `pi`, `claude` (Claude Code), `codex` (OpenAI Codex CLI), plus a brief survey of other kinds in `src/launcher.ts` presets. Per kind: (1) pinning the model, (2) injecting/appending/replacing a system prompt, (3) allowing/denying tools, (4) preloading skills or instruction files, (5) disabling extensions/MCP, (6) non-interactive/headless flags (prompt as argv, exit on completion), (7) worktree-isolation-relevant flags (cwd/git). Evidence-based — cite exact flags and sources; mark UNKNOWN rather than guessing.

Context pointer: findings land on branch `research/capability-matrix`, file `wayfinder/research/capability-matrix.md`. This gates the `spawn_agent` parameter surface (ticket `01`) and the default-agents ticket (`02`): a param is only honest if the underlying kind can enforce it.

## Resolution

Matrix complete (merged to `main`: [`wayfinder/research/capability-matrix.md`](../research/capability-matrix.md)), evidence-cited against pi 0.85.1, claude 2.1.263, codex 0.135.0 + a survey of other launcher kinds.

- **Portable (all three, honest to promise):** model pin, system prompt replace/append, headless prompt-as-argv, cwd.
- **Portable-ish:** tool allow/deny — pi & claude have flags; codex only via `-c` TOML config keys, no general allowlist → degrade to deny-known or mark unsupported for codex.
- **Kind-specific:** skills preload (pi-only `--skill`; claude is cwd/`--plugin-dir` based, codex config-only), extensions/MCP disable (pi `-ne`, claude `--safe-mode`/`--strict-mcp-config`, codex config).
- **Do not promise:** worktree/branch creation (claude `-w` and cursor only — our `isolated` param must be a pi-herdr-side worktree, not a child flag), codex system-prompt and skills via CLI (config-file only).
- Housekeeping: `AGENT_KINDS_FALLBACK` in `src/config.ts` is missing `qwen` vs live `herdr agent` output.

> Update from ticket `11` (resolved): **this decision is mooted by the pi-only scope ruling.** v0.5 promises nothing for non-pi kinds; `kind` survives on `spawn_agent` as an unopinionated passthrough param (herdr's native `agent start --kind` axis) with one honest line — *text in a pane, TUI-detected lifecycle, nothing else*. The matrix above stays as verified reference for anyone who later redraws the destination to multi-kind; it no longer constrains the v0.5 spec. (The `qwen` fallback housekeeping note remains valid regardless.)
