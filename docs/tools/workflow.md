# `herdr_run_workflow`

**Scripted workflow orchestration** (v0.6 issue 12): run a small JavaScript
program in the background that spawns and coordinates many real agents — fan
out over a list discovered at runtime, push items through the same stages,
verify each result before believing it. The script is only the coordinator:
it has no filesystem, no network, no `eval`; every `agent()` call spawns a
real pi pane through the ordinary spawn gates.

The runtime core, worker bootstrap, determinism jail, caps table, and meta
pre-parse are **ported from [`tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents)**
(MIT; provenance in the ported file headers and the README
[acknowledgements](../../README.md#acknowledgements)). The host seam — option
mapping onto the spawn engine, completion detection, gates, resume — is
pi-herdr's own. See that ticket's ruling: **concurrency flows through the
ordinary gates** (kill-switch → spawn depth → parallel cap, over-cap =
queued) — workflow agents get no separate pool.

## Params

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `script` | string | one of these | Inline source. Must begin with `export const meta = { name, description }` — a pure literal. |
| `scriptPath` | string | one of these | A workflow file, absolute or project-relative. **Wins over `script`** — this is how an edited workflow is re-run. Saved `name` discovery arrives with the next workflows ticket (issue 13). |
| `args` | any | no | Handed to the script as the `args` global, verbatim. Must be JSON-shaped. |

Returns immediately: run id, the script's scratch path, and the instruction
not to poll. The run reports **once**, aggregated, when it settles — the
completion push carries the agent counts, the return value, and the last
`log()` lines (wake per the `notifications` setting; failures always wake).

## The script

**The body is an async function body.** Top-level `await` and a bare
top-level `return` are both allowed; what you `return` crosses a JSON
boundary (cycles, sparse arrays, Maps, symbols, functions refuse).

### Globals

| Global | What it does |
|--------|--------------|
| `agent(prompt, opts?)` | Spawns one pi child; resolves to its **exact final message** (the session JSONL, not a screen scrape). A failed child resolves to `null` — filter with `.filter(Boolean)`. |
| `pipeline(items, ...stages)` | Staged fan-out, **no barrier**: item A can be in stage 3 while item B is in stage 1. Each stage sees `(previousResult, originalItem, index)`; a stage that throws drops that one item to `null`. |
| `parallel(thunks)` | **Barrier**: waits for all. A thunk that throws becomes `null` without taking its siblings down. |
| `phase(title)` | Starts a progress group. Inside `pipeline`/`parallel` stages, use the `phase` *option* instead — the ambient phase races. |
| `log(message)` | A progress line, echoed in the run's completion push. |
| `args` | Whatever the tool received, verbatim (`undefined` if none). |
| `budget` | `{ total: null, spent(), remaining() }` — `total` is always `null` (upstream-verbatim; Claude Code scripts' guards on it keep working). In issue 12 `spent()` is honestly `Infinity`; the next ticket makes it real from the session JSONL. |
| `workflow(nameOrRef, args?)` | Present but refuses in this ticket — saved-workflow resolution is issue 13. |

### `agent()` options

| Option | Notes |
|--------|-------|
| `label` | Pane handle + the `resume` address. Defaults to the prompt's first line. |
| `phase` | File this agent under a named group without moving the ambient phase. |
| `agentType` | Registry type (`.md` registry, built-ins `general-purpose` / `Explore` / `Plan`; default `general-purpose`). A definition whose kind names a non-pi CLI is a **per-agent refusal** — workflow children are pi-only (the result contract rides the pi session substrate). |
| `model` | Exact authenticated `provider/model-id` — routing-chain level 1, enforce-or-error naming the level. A refusal fails THIS agent (null), not the run. |
| `effort` | `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` → `--thinking`. |
| `isolation` | `"worktree"` → herdr-side worktree (a `gate` then verifies the tree the child wrote). |
| `gate` | Shell command run after the child settles; non-zero exit = a typed agent failure whose error is the command output. |
| `resume` | Continue the child that ran under `label` instead of starting fresh — the retained session replays with `prompt` as the opening message (the resume machinery, re-derived launch plan, same gates). Mutually exclusive with `agentType`/`model`/`effort`/`isolation`/`gate`. |

Unknown option keys are rejected **by name** at the call (a typo must not
silently become "no options"). `schema` is a named refusal until its ticket.

## Rules and caps

| Rule | Value |
|------|-------|
| Script length | 512 KiB; no control characters (tab/CRLF fine) |
| Agents per run | 1000 (fatal past the cap) |
| Items per `parallel`/`pipeline` call | 4096 |
| `meta` | Pure literal — no variables, calls, spreads, or template interpolation |
| Determinism jail | `Date.now()` / `new Date()` / `Math.random()` throw — replayable runs are what issue 13's resume journal replays |
| Code generation | `eval` and `Function(...)` throw (`codeGeneration.strings: false`) |

An `agent()` that is never awaited fails the run immediately with the
upstream ruling: *"workflow script completed with unawaited agent launch(es):
… Await or return each launch."*

## Children vs. the fleet

Workflow children are real spawn-registry agents — they hold ordinary fleet
rows, queue through the ordinary cap, and appear in the widget — but their
terminal pushes are suppressed: **the run reports for them**, once,
aggregated. A blocked child still wakes you (blocked always wakes); answer
with `herdr_message_agent` and the run continues — `agent()` waits for the
settle. Stopping a run is the kill-all menu action (in-flight children close,
sessions retained); `workflows_enabled: false` removes the tool from the
surface (evaluated at load; a mid-session toggle refuses new runs until
`/reload`) and never stops one in flight.
