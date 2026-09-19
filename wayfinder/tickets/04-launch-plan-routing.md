---
label: wayfinder:grilling
status: closed
assignee: Andrew
blocked-by: [01-substrate]
---

## Question

How children are launched and how model/thinking get resolved. Adopts the prior art's argv-construction discipline (research/richardh-prior-art.md §5) while keeping herdr as the process launcher; replaces v0.5-01's merge+validate-only model handling with the 5-level routing chain (§6).

## Resolution

1. **Launch plan builder.** One function composes the pi argv from the resolved run: `--session <seeded-path>` (ticket `01`), `-e <child-extension>`, `--model`/`--thinking` from the routing chain, `--system-prompt`/`--append-system-prompt` (per `prompt_mode: replace|append`, replace default; multiline via temp file — single-line-safe, already house practice), identity + mode-hint blocks appended to the system prompt, and the task.
2. **Task-as-artifact.** Long tasks are written to a file and referenced by a one-line prompt — argv-length-safe on Windows (adopted; same trick we already use for system prompts).
3. **Frontmatter `args:` — custom agent args.** Agent definitions may pin raw CLI flags (`args: ["--plan"]` for a plannotator-mode planner); spawn-level `agent_args` appends/overrides. This is the sanctioned escape hatch (v0.5-01's `agent_args` ruling, extended to definitions).
4. **herdr stays the launcher.** `agent start --kind pi --pane <id> -- <argv>` on every platform (floor: ticket `10`). herdr owns pane creation, focus control, named registration, lifecycle tracking. **No multi-harness driver layer** — non-pi kinds remain `--kind` passthrough with the honest one-liner; pi-only promises unchanged.
5. **Routing chain (5 levels, adopted from prior art §6):**
   1. spawn `model` / `thinking` (one-off, wins)
   2. frontmatter `model` / `thinking`
   3. `models.agents.<name>` from settings
   4. `models.default` from settings
   5. parent session's model (inherit)
   with `thinking` resolving identically. **No fuzzy model resolution** — exact authenticated `provider/model-id` only; enforce-or-error validation names the level that supplied a bad value.
6. **Settings home** (not prior art's extension-dir `config.json`): `models.*` lives in `.pi/herdr.json` / `~/.pi/agent/herdr.json`, deep-merge project-wins, editable via `/subagents config` (ticket `09`).
7. **Stance fields ride the launch plan** too: `auto-exit`, `interactive` override, `session-mode` (ticket `05`), `isolated` (herdr-side worktree, v0.5-01 ruling unchanged).

**Feeds:** `05` (seeding precedes launch), `08` (workflow `agent()` builds launch plans through this builder).
