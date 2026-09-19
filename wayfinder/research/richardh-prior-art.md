# Prior art: 0xRichardH/pi-herdr-subagents (and tintinweb workflows study)

Studied from a fresh clone (2026-09-19) at `.scratch/pi-herdr-subagents/` (≈6.2k LOC)
plus tintinweb/pi-subagents at `.scratch/pi-subagents/` (`src/workflow/` ≈4.5k LOC).
Informs every v0.6 ticket; §-references used across tickets resolve here.

Positioning: same problem domain, opposite philosophy. They optimized for
autonomous fire-and-forget richness (push, projected lifecycle, fork/resume);
v0.5 optimized for minimal honest surface (pull, six states). v0.6 adopts their
architecture on our herdr foundation — the surface gets *smaller* (43→12) even
as the experience gets richer.

## 1. Architecture (what we adopted wholesale)

- Children are pi launched with **parent-owned session files** (`pi --session <path>`);
  the parent injects an extension (`-e subagent-done.ts`) providing `subagent_done`,
  auto-exit on `agent_end`, sidecar writes, activity recording, and a tools widget.
  Results = last assistant message from session JSONL, with `stopReason`/`errorMessage`
  mining (provider-overload retry-exhaustion reaches the parent as a typed failure).
  → ticket `01` (substrate).
- Completion detection is triply redundant: exit sidecar (`<session>.exit`,
  typed done/ping/error) > terminal sentinel (`__SUBAGENT_DONE_<code>__` screen text,
  for processes that die without a sidecar) > pane-disappearance + bounded grace.
  → ticket `02`.
- Agent files: `.md` + YAML frontmatter at `.pi/agents/` (project) >
  `~/.pi/agent/agents/` (global) > bundled — same locations and precedence as ours;
  richer fields (`session-mode`, `auto-exit`, `interactive`, `spawning`, `deny-tools`,
  `cwd`, `cli:`). Tool names `subagent*` vs our `herdr_*` — no collisions; env
  `PI_SUBAGENT_*` vs our `PI_HERDR_*` — no collisions. Co-installable, and the
  agent folders would even be **shared** (unknown keys ignored on both sides).

## 2. Result source (the v0.5 report's unclear point, restated)

- **Ours (v0.5):** pane-tail read via herdr CLI — screen-scraping the TUI's rendering;
  truncation heuristics, no error semantics, works on any pane.
- **Theirs:** session JSONL — the child's actual final message object; exact,
  complete; plus a purpose-written sidecar for completion typing.
- **Ruling:** observation (screen) loses to reporting (files); pane-tail demoted to
  fallback for panes we didn't spawn.

## 3. Delivery (push) and notifications

Full result steered into the parent with `triggerTurn: true`; autonomous agents
always wake; interactive ones suppress stall pings but still deliver results.
**Their weakness we fixed in the grill:** user takeover fuses pane-closing and the
result contract (any keystroke kills both permanently) — v0.6 splits them
(auto-close off, contract never revoked) and adds idle re-arm (15 min) for the
headless steer-and-leave case. → ticket `02`.

## 4. Status vocabulary

~9 projected states (starting/active/waiting/interrupted/stalled/running/finalizing/
blocked + terminal) derived from pane inspection + activity snapshots + a watchdog;
watchdog pings on stall-entry and recovery; aged-but-valid states never stall.
→ ticket `03` adopts the set (plus our `queued`, `gone` = 10).

## 5. Launch

Driver layer builds per-harness argv (pi: `--session`, `-e`, `--model`, `--thinking`,
`--system-prompt`/`--append-system-prompt`, skills flags; claude/codex/grok/opencode/
generic `command:` templates); long tasks delivered as artifact files (argv-length-safe).
**We adopt the pi argv discipline only** — herdr stays the launcher; no multi-harness
drivers (pi-only ruling stands). → ticket `04`.

## 6. Model routing

Five levels: tool arg → frontmatter → per-agent config → global default → parent
model; thinking resolves the same way. Their config home is an extension-dir
`config.json` (invisible, unmergeable) — ours moves to the settings files +
`/subagents config`. No fuzzy resolution for us (enforce-or-error, exact IDs).
→ ticket `04`.

## 7. Session modes & resume

`standalone` | `lineage-only` | `fork` — seeding writes the child header
(`parentSession` link) and, for fork, parent turns truncated before the last user
message. `subagent_resume(sessionPath)` relaunches with optional follow-up.
We adopt all three modes and resume-by-handle (never raw paths). → tickets `05`, `06`.

## 8. Widget

Multi-row table: elapsed, name, `state · tool`, state age; active/open header;
amber border when idle; rows leave on delivery. Child-side Ctrl+J identity/tools
strip. We adopt the table, keep our blocked-callout/footer-replacement/read-only.
→ ticket `07`.

## 9. What we did NOT adopt

- Their `caller_ping` exit-based help tool (our `message_agent` channel covers
  child→parent without killing the session).
- Their harness driver breadth (pi-only).
- Their interactive/autonomous *notification* semantics wholesale (we keep the
  verbosity setting governing the wake).
- `/plan`, `/iterate`, `/subagent` prompt-template commands — superseded by the
  user's ruling for **coded workflows** (§10).
- Their extension-dir `config.json`.

## 10. tintinweb/pi-subagents — workflow system study

`SubagentWorkflow` tool: a small JS program (inline `script` / `scriptPath` / saved
`name` + JSON `args`) run in a background Node `vm` sandbox. No fs/network/eval;
injected globals `agent()` / `pipeline()` (barrier-free stages) / `parallel()`
(barrier) / `workflow()` (one-level nesting) / `phase()` / `log()` / `args` /
`budget` (`total` always null). Agent options: `label`, `agentType`, `model`,
`effort`, `isolation: "worktree"`, `gate` (shell command must pass), `resume`,
`schema` (pressure, not guarantee — no forced toolChoice in pi).

Load-bearing details we port: the **determinism jail** (`Date.now()`/`Math.random()`
throw so scripts are replayable), the **resume journal** (`resumeFromRunId` replays
the unchanged prefix; failures end the prefix by design; no cross-session replay),
**saved-workflow discovery** (`.pi/workflows/` → `.agents/workflows/` → global;
`export const meta = {name, description}` pure-literal marks a workflow), the
meta-pre-parse (phases render from frame one), un-awaited-`agent()` failure, caps
(1000 agents/run, 4096 items/call, 512 KiB scripts), Claude Code script
compatibility. Their agents run **in-process** (AgentSession) — our host seam calls
herdr panes instead, which the substrate makes a drop-in: spawn → sidecar → JSONL
result is exactly the awaitable `agent()` needs. Concurrency flows through our
ordinary gates rather than their per-run `cpus-2` pool.

Port estimate: runtime core + worker + meta + journal + saved ≈ portable;
host seam ≈ 300–400 lines; progress card ≈ 300. Largest single v0.6 feature;
sequenced last. → ticket `08`.

## 11. Coexistence check (extends v0.5-07)

No tool-name collisions (`subagent*` vs `herdr_*`), no env collisions
(`PI_SUBAGENT_*` vs `PI_HERDR_*`), disjoint report channels. The one shared
surface is the agent-definition folders — same locations, same precedence,
field sets overlap but ignore each other's unknown keys. Their README explicitly
does not load other orchestrators. Audiences remain disjoint; nothing to do.
