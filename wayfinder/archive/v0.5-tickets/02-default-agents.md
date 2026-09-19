---
label: wayfinder:grilling
status: closed
assignee: Andrew Jacop
blocked-by: [08-capability-matrix]
---

## Question

Which built-in agent types ship out of the box, with what kinds and prompts? tintinweb ships `general-purpose` / `Explore` / `Plan` (all in-process pi). For us each default also picks a `kind` — is the default fleet pi-only (e.g. `general-purpose`, `Explore`) with claude/codex as opt-in kinds, or do we ship kind-flavored defaults? What system prompts, tool sets, models per default? Decide the shipped set and their one-line descriptions (the `spawn_agent` tool description enumerates them, so brevity counts). Zoom `08` for what each kind can enforce.

## Resolution

HITL-grilled 2026-09-09; every default cross-checked against ticket `08`'s matrix and tintinweb's shipped `src/default-agents.ts` (fetched verbatim, master).

1. **Fleet: the trio, pi-only.** `general-purpose`, `Explore`, `Plan` — same names as tintinweb (maximizes the shared-registry story feeding ticket `07`), all `kind: pi`. Other kinds are reached per-call via the `kind` override (merge+validate, ticket `01`) — never via shipped defaults, since only pi enforces every shipped field honestly.
2. **Content adopted verbatim from tintinweb.** Explore/Plan: replace-mode read-only system prompts + `tools: [read, bash, grep, find, ls]`; general-purpose: all tools, empty system prompt. **Descriptions keep tintinweb's full text** (user decision over one-liners — the spawn_agent tool description carries them). No `isDefault` flag — ticket `01` killed silent defaults.
3. **No model pins.** All three inherit the user's configured pi model; we ship no fallback resolver, and a wrong pin hard-fails the child. Pinning stays a project/global registry override.
4. **Schema addition surfaced here: `prompt_mode: replace | append`, default `replace`.** Exists in both the inline `agent:` definition and the `.md` frontmatter dialect — name, default, and semantics identical to tintinweb (`fm.prompt_mode === "append" ? "append" : "replace"`), so shared `.pi/agents/` files behave the same under both tools. pi enforces both via `--system-prompt` / `--append-system-prompt`. Without it, a tintinweb file with `prompt_mode: append` would silently replace under us.
5. **`.md` dialect pinned (tintinweb's):** system prompt = file body; `tools` = comma list; unknown frontmatter keys (`thinking`, `max_turns`, …) ignored as cross-dialect no-ops per ticket `09`'s finding.
6. **Mechanics:** built-ins ship as embedded definitions (tintinweb's `default-agents.ts` pattern) — the precedence floor under session > project > global; a same-name registry entry overrides.
