# Concepts

Cross-cutting concepts that apply to **every** pi-herdr tool. The per-surface pages
([agent tools](tools/orchestration.md) and [pane-sync](tools/pane-sync.md)) assume
these.

## The `Result<T>` envelope

Every interaction with the `herdr` CLI goes through one spawn module (`src/herdr.ts`)
that parses herdr's JSON envelope into a uniform [`Result<T>`](../src/env.ts):

```ts
type Result<T> =
  | { ok: true;  data: T }
  | { ok: false; error: { code: HerdrErrorCode; message: string; details?: unknown } };
```

`herdr()` **never throws** — every failure path resolves to `{ ok:false, error }`.
Each tool then maps that `Result<T>` to a pi tool return value (`ToolReturn`):

- **Success → `okText(text, details)`** — `{ content:[{type:"text",text}], details }`.
  The human-readable summary goes in `content`; the structured data (the normalized
  herdr payload) goes in `details`.
- **Failure → `fail(r)`** — `{ content:["Error (CODE): message"], details:{error}, isError:true }`.
  Setting `isError:true` flags the call for pi.
- **Partial (spawn) → an error ToolReturn carrying whatever partial state
  exists** — when a spawn's turn times out or never starts, the result still
  names the pane (which exists) so the caller can wait/read it later.

### The `code` vocabulary

`HerdrErrorCode` is a fixed, normalized set surfaced to the model
([`src/env.ts`](../src/env.ts)):

| Code | Meaning |
|------|---------|
| `TIMEOUT` | A blocking call exceeded `timeoutMs` or was aborted. |
| `NOT_FOUND` | Target pane/agent/tab/workspace/session doesn't exist (herdr `not_found` / `no_such_agent` / `no_such_pane`). |
| `VALIDATION_ERROR` | Bad input — unknown agent kind, empty required field, mutually-exclusive params, or any unmapped herdr server error. |
| `AGENT_START_FAILED` | A spawned agent was not detected by herdr within budget (`agent_start_failed`). |
| `HERDR_UNAVAILABLE` | The `herdr` binary could not be resolved/spawned (ENOENT), or is missing from PATH. |
| `HERDR_TOO_OLD` | The detected herdr is below the ≥ 0.9.0 floor (or its version couldn't be determined) — the call is refused before it runs. |
| `PANE_GONE` | A split/create returned no pane/tab id, or a pane vanished mid-operation. |

The mapping is in [`mapCode()` in `herdr.ts`](../src/herdr.ts): `agent_start_failed →
AGENT_START_FAILED`; `*not_found*`/`no_such_agent`/`no_such_pane → NOT_FOUND`;
`*gone* → PANE_GONE`; `*timeout*`/`*timed_out* → TIMEOUT`; everything else →
`VALIDATION_ERROR`. herdr emits error envelopes on **stderr** (stdout empty,
non-zero exit); `herdr()` parses both stdout and stderr so codes map correctly rather
than surfacing raw JSON.

## Version floor: herdr ≥ 0.9.0

`pi-herdr` requires herdr **≥ 0.9.0** and probes `herdr --version` once per
session (cached; see [`src/herdr.ts`](../src/herdr.ts) — the probe and its
classification live next to the exec module, the pure compare logic in
[`src/version.ts`](../src/version.ts)). 0.9.0 is the release that fixed Windows
`agent start --kind`, which is what lets every platform share **one** launch
path — no version branches anywhere.

Below the floor there is no partial function: the gate inside `herdr()` itself
refuses every call with one clean `HERDR_TOO_OLD` error naming the upgrade
pointer (herdr.dev), the same style as `HERDR_UNAVAILABLE`. An unparseable
version is refused the same way (a hard floor doesn't guess); a missing binary
keeps its single natural `HERDR_UNAVAILABLE` instead of stacking two errors.
At/above the floor the probe keeps reporting for diagnostics: the footer shows
the detected version, e.g. `herdr: 3 agents (1 working) (0.9.0)`, and
`herdr: too old (0.8.2 < 0.9.0)` below it.

The commands the tools use (all current-surface, no legacy fallbacks):

- **`herdr_spawn_agent`** (the launch machinery) — `pane split --current
  --direction right` **then** `agent start <name> --kind <kind> --pane <id>
  [-- <argv>]` (the pane must already exist). `agent_pane_busy` races the
  freshly-split shell's prompt, so the start retries briefly; the turn itself
  is submitted with one atomic `agent prompt <pane> <text> --wait --timeout
  <ms>` (`agent_prompt_stalled` falls back to the wait/poll dance). Every pi
  child's argv leads with the parent-owned session file (`--session <path>`
  under pi's default sessions dir) and the injected child extension
  (`-e <pkg>/src/child.ts`).
- **`herdr_message_agent`** — delivery rides the same commands:
  `agent prompt <target> <text>` (submit) or `pane send-text <pane> <text>`
  (text only). A blocked target gets the raw text (the message IS the
  answer); everything else is enveloped
  `<agent-message from="…" to="…">…</agent-message>` (spawner-declared
  identity, never verified; no child-side parsing — the receiving model
  recognizes the tag).
- **`herdr_get_agent_result`** — reads the child's session JSONL (the exact
  last assistant message) and `<session>.exit` (the typed completion sidecar)
  directly; `agent read` only as the pane-tail fallback for panes this session
  did not spawn. `wait` races nothing: it polls sidecar → pane status until a
  terminal state.

## Pane surface vs agent surface

herdr separates two surfaces:

- **Agent surface** — AI agent panes. Commands the kept tools use: `agent
  start` / `prompt` / `get` / `read` / `list` / `wait` / `send-keys`. Used by
  the [agent tools](tools/orchestration.md) and the spawn engine.
- **Pane surface** — raw terminal processes (logs, builds, test suites, shells).
  Commands the kept tools use: `pane run` / `read` / `wait-output` /
  `send-keys`. The rest of the pane/tab/workspace/worktree/session surface
  exists in herdr but is **off the model surface** (the v0.6 cut) — it stays
  the human's surface in the herdr UI, and a thin slice of it survives
  internally as machinery (worktree create/remove for `isolated`, pane close
  for kill-all).

`herdr_send_keys` is the one tool that spans both: `agentScope:false` (default) →
`pane send-keys`; `agentScope:true` → `agent send-keys`.

## Targets: pane id vs name

A tool's `target` (or `paneId`) identifies a pane. For agent-surface tools,
`target` is flexible:

- a **pane id**, e.g. `w1:p3`;
- an **agent name** — the handle `herdr_spawn_agent` returned (`name`);
- a **label**.

`herdr_message_agent` resolves a flexible `target` down the shared chain:
exact pane-id → herdr name → spawn-registry handle → the reserved role
`orchestrator` (via `PI_HERDR_ORCHESTRATOR_PANE`; real names win over the
reserved role, and a session no agent spawned gets the honest "no orchestrator
above you" error). `herdr_get_agent_result` resolves `target` against the
spawn registry first (handle, then pane id) and only falls back to herdr's
own resolution for panes this session did not spawn.

**Names are lowercase `[a-z0-9-_]`.** herdr rejects uppercase characters in pane
names, so always name agents in lowercase. A name `herdr_spawn_agent` returns
**is** usable as a `target` by later calls.

## Destructive tools ⚠️

Tools that close/terminate/kill/delete carry a ⚠️ marker in their description (the
CONTRIBUTING convention) and in this wiki. On the v0.6 surface there is **one**:

- `herdr_send_keys` — sends logical key presses; `ctrl+c` interrupts a running
  process.

Terminating agents is deliberately a **human** action: the confirmed **Kill all
agents** item in `/subagents config` (which wraps `pane close` for every running
agent), or closing the pane yourself in the herdr UI.

## Timeouts & abort

Every blocking `herdr()` call takes `timeoutMs` (default 60 s in the spawn module;
each tool sets its own — e.g. reads 15 s, snapshot 15 s, worktree create 60 s) and
honors an `AbortSignal` (the pi tool `signal`). On timeout or abort the child process
is killed and the call resolves `{ ok:false, error:{ code:"TIMEOUT", … } }` rather
than hanging — "Timeouts everywhere" per [`CONTRIBUTING.md`](../CONTRIBUTING.md).
Several tools also expose their own timeout parameter (`herdr_get_agent_result`'s
`wait` ms form, `herdr_wait_output`'s `timeoutMs`).

## Agent kinds

`kind` (in a spawn definition) is a **free string**, default `"pi"` (the
`default_kind` setting). It is validated at execute time against the **live** kind list
emitted by `herdr agent` (the trailing `kinds: a|b|c` line), which is
[cached per session](../src/config.ts) with a hardcoded
[`AGENT_KINDS_FALLBACK`](../src/config.ts) (~21 kinds: `pi`, `claude`, `codex`,
`gemini`, `cursor`, `devin`, `agy`, `cline`, `omp`, `mastracode`, `opencode`,
`copilot`, `kimi`, `kiro`, `droid`, `amp`, `grok`, `hermes`, `kilo`, `qodercli`,
`maki`) when herdr is unavailable. An unknown kind returns a
`VALIDATION_ERROR` **listing the kinds your herdr supports**.

The old `agent:"custom"` + raw `argv` launch surface is gone. To load a **local
extension** instead of the installed one, pass `agent_args` on the spawn
definition (e.g. `["-ne","-e","./src/index.ts"]`) — they follow `--` in
`agent start`, and herdr resolves the kind to its CLI on its own side.

## Model & thinking routing

Every spawn resolves `model` and `thinking` through a **routing chain**
(first hit wins):

1. **Spawn param** — `model` / `thinking` on the `herdr_spawn_agent` call.
2. **Frontmatter** — the definition's `model:` / `thinking:` (`.md` file or
   inline `agent`).
3. **`models.agents.<name>`** — per-agent **model** pin in the settings files,
   keyed by the definition's registry name.
4. **`models.default`** — the settings **model** fallback (empty = unset).
5. **Parent session's model** — the model the spawning session is running on
   right now, pinned explicitly onto the child. `thinking` never inherits from
   the parent: the child keeps its own configured default. Settings carry
   model pins only, so the thinking chain is levels 1–2.

**Enforce-or-error, no fuzzy resolution.** A model value must be an exact,
authenticated `provider/model-id` (e.g. `anthropic/claude-opus-4-6`) — bare
ids, unknown ids, and unauthenticated providers refuse the spawn. A thinking
value must be a valid pi level (`off|minimal|low|medium|high|xhigh|max`). Every
routing error **names the level that supplied the bad value** ("routing level 3
(models.agents pin for "scout"): no such model…"), so a bad pin in a `.md` file
or settings is immediately diagnosable. An explicit `thinking` pin on a kind
without a thinking flag (everything but `pi`) also refuses; an unset thinking
value on such kinds is simply absent.

Raw CLI flags remain the escape hatch: frontmatter `args:` and spawn-level
`agent_args` append **after** every computed flag (spawn-level after the
definition's), so a later duplicate wins by ordinary CLI semantics — that is
the documented override path, and it bypasses routing validation by design.

## The launch plan

One builder composes the argv handed to `agent start --kind <kind> --` for
every spawn: for pi children — the parent-owned `--session <seeded file>`, the
injected child extension (`-e`), the routing flags, the system-prompt flags
(replace default, or one combined `--append-system-prompt` in append mode)
with a lean identity + mode-hint block appended (`You are herdr/<name>…`, the
settle/`agent_done` contract for autonomous children, the seeded-lineage note
for `fork`/`lineage-only`), then raw flags. Every other kind keeps the honest
one-liner passthrough — no multi-harness driver layer.

Prompts longer than 2000 chars are written to `<session>.task.md` beside the
child's session file and delivered as a one-line reference — length-safe on
Windows, and the artifact survives for resume (the session dir is never
cleaned).
