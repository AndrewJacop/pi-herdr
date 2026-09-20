# pi-herdr

[![npm version](https://img.shields.io/npm/v/@andrewjacop/pi-herdr.svg)](https://www.npmjs.com/package/@andrewjacop/pi-herdr)
[![license](https://img.shields.io/github/license/AndrewJacop/pi-herdr)](./LICENSE)
[![platform](https://img.shields.io/badge/platform-macOS%20%26%20Windows%20tested-blue)](#platform-support)

A [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) coding-agent
extension that turns pi into an **orchestrator over a fleet of visible AI agent
panes** running in [herdr](https://herdr.dev). Spawn another `pi`, `claude`,
`codex`, or `opencode` in its own terminal pane with a task, steer it while it
works, wait for it to finish, and harvest its response — all from your pi
session. Each spawned agent is an independent CLI process you can watch, attach
to, and intervene in while pi coordinates them.

The v0.6 surface is deliberately small: **one surface, nine tools today**
(spawn, save, result, message, list, and the pane quartet), converging to
**twelve** as the remaining v0.6 tickets land (`interrupt`/`resume`,
`run_workflow`). Everything else — layout, tab/workspace CRUD, worktrees,
fleet introspection — is machinery you never have to switch to: the herdr UI
stays the human's surface for that.

> **Complementary to [`pi-subagents`](https://www.npmjs.com/package/pi-subagents):**
> `pi-subagents` runs children **in-process** (fast, shared context). `pi-herdr`
> runs agents in **separate herdr panes** (visible, heterogeneous, resumable,
> directly attachable). They work well together.

---

## Platform support

**Tested on Windows and macOS.** The code is platform-aware (`herdr` is spawned
directly as a native binary, argv passed literally with `shell: false`) and is
*expected* to work on Linux too, though that has not been verified. herdr's own
availability on each platform follows [herdr.dev](https://herdr.dev). If you try
Linux, please open an issue with the result.

> **macOS — launch herdr from your terminal, not `brew services`.** A launchd-managed
> herdr server inherits macOS's minimal PATH (no `node`), and spawned `pi` agents die
> silently. See [Requirements → herdr](#2-herdr-the-workspace-manager).

---

## What is herdr?

[**herdr**](https://herdr.dev) is a **terminal workspace manager for AI coding
agents**. It runs multiple terminal panes/tabs/workspaces, each of which can host an
agent CLI (`pi`, `claude`, `codex`, …), and it tracks each pane's agent state
(`idle` / `working` / `blocked`). herdr exposes a local JSON-over-socket API and a
`herdr` CLI; **this extension speaks that CLI** so the pi LLM can spawn and drive
panes.

`pi-herdr` does **not** bundle herdr — herdr is a separate product you install and
run yourself (see below).

## Requirements

You need all of these before `pi-herdr` can do anything useful.

### 1. pi (the host agent)

```bash
npm install -g @earendil-works/pi-coding-agent
pi --version          # verify
```

pi needs at least one model + API key configured (run `pi` and use `/login`, or see
`pi --help`). **Spawned agents inherit this config**, so they can respond too.

### 2. herdr (the workspace manager)

Install herdr from **<https://herdr.dev>** (follow the instructions there for your
platform). Then verify it's on your `PATH` and start a session:

```bash
herdr --version       # verify, e.g. "herdr 0.9.0" — pi-herdr requires ≥ 0.9.0
herdr status          # shows server + socket; "server: not running" until you launch it
herdr                 # launch the herdr workspace (starts its local server)
```

The `herdr` server must be running for `pi-herdr`'s tools to work — they talk to that
server. If herdr is missing or not running, every tool returns a clean
`HERDR_UNAVAILABLE` error instead of hanging.

> ℹ️ **Version floor: herdr ≥ 0.9.0 (hard).** `pi-herdr` probes `herdr --version`
> once at session start. Below the floor it refuses to run — one clean
> `HERDR_TOO_OLD` error naming the upgrade pointer (<https://herdr.dev>), the
> same style as `HERDR_UNAVAILABLE`; no tool half-works, no degraded paths.
> 0.9.0 is the release that fixed Windows `agent start --kind` (shim launch +
> flaky process-tree detection), which is what lets every platform share ONE
> launch path. Above the floor the probe keeps reporting for diagnostics: the
> detected version shows in the footer, e.g. `herdr: 3 agents (1 working) (0.9.0)`.

> ⚠️ **macOS — do not manage herdr with `brew services`.** `brew services` runs the
> herdr server under launchd, which gives it macOS's *minimal* PATH
> (`/usr/bin:/bin:/usr/sbin:/sbin`) with no `node`. Spawned `pi` is a
> `#!/usr/bin/env node` script, so it can't find `node` and the pane dies silently
> (~2s, no output). (`claude`/`codex` survive because they're standalone binaries.)
>
> Launch herdr from your terminal instead, so the server inherits your shell PATH:
>
> ```bash
> brew services stop --all 2>/dev/null; brew services stop herdr   # if you enabled it
> herdr                            # from your project dir; starts a server w/ your full PATH
> herdr status                     # confirm "server: running"
> ```
>
> herdr attaches to a *persistent* session, so you must stop the launchd server first
> — otherwise `herdr` just reattaches to the minimal-PATH one. There is no per-spawn
> env injection on the v0.6 surface, so a minimal-PATH server can't be worked around
> from a spawn — run herdr from your terminal.

### 3. This extension

```bash
pi install npm:@andrewjacop/pi-herdr
```

That's it — every pi session (including agents you later spawn) will now load it.
Restart pi (or `/reload`) if a session was already running.

> **Quick test without installing:** `pi -ne -e ./src/index.ts` from a clone of
> this repo — `-ne` skips installed-extension discovery so only this local copy
> loads (great for end-to-end checks against a real herdr server).

## Install

### From npm (recommended)

```bash
pi install npm:@andrewjacop/pi-herdr
```

### From source / local dev

```bash
git clone https://github.com/AndrewJacop/pi-herdr.git
cd pi-herdr
npm install
pi install ./          # register the local checkout globally
```

---

## Quick start

With **herdr running** (you've launched `herdr` and `herdr status` shows the server
up), open **another** terminal and start pi in a project:

```bash
cd my-project
pi
```

Then just ask pi in natural language:

```
Spawn a background agent to summarize README.md in 3 bullets, wait for it, and give me the result.
```

You'll see a new pane appear in herdr, the spawned agent work, and pi return its
answer. While orchestrating, pi's footer shows the fleet, e.g. `herdr: 3 agents (1 working) (0.9.0)`.

---

## Examples

### Example 1 — One-shot task (the core pattern)

Hand a self-contained task to a fresh agent and collect the result.

> 1. `Spawn an agent named "summ" with the task "Summarize README.md in 3 bullets" (herdr_spawn_agent).`
> 2. `Pull the result (herdr_get_agent_result, wait: true) and give me the summary.`

**What happens:** `herdr_spawn_agent` splits a pane, launches the agent, submits
the task, and returns a handle. Pi children run **autonomous** by default: when
the work settles they write their typed completion sidecar, close their pane,
and the result lives on in the retained session file — pass `interactive: true`
to keep the pane open for follow-ups instead. Passing `wait: 180000` (ms) folds
the timing into the spawn call: it blocks until the terminal status.

### Example 2 — Parallel fan-out (do N things at once)

Background spawns run concurrently, so you can fan work out:

> *Prompt:* `In parallel, spawn three background agents — one to write tests for auth.ts, one for payment.ts, one for user.ts (herdr_spawn_agent ×3). Pull all three results (herdr_get_agent_result, wait: true), then give me a combined summary and any failures.`

**What happens:** Three panes spawn at once, each works its task concurrently.
At `max_parallel_agents` the extra spawns are accepted **queued** — they start
when a slot frees. Pair with `isolated: true` to give each agent its own
auto-created git worktree (fresh checkout, no interference).

### Example 3 — Heterogeneous review (a different agent reviews pi's work)

> *Prompt:* `Spawn a claude agent (inline definition, kind: "claude") with the task "review the diff in git diff main" and wait for its verdict.`

**What happens:** A `claude` pane boots, receives the diff, and returns a review.
Because each agent is a real CLI in its own pane, you can mix models/vendors freely.

### Example 4 — Steering and questions (stay in control)

While an **interactive** agent (`interactive: true` — the pane stays open) is at
work you can steer it, and if it asks a question you can answer:

> *Prompt:* `Send "focus only on the auth module" to agent "tests" (herdr_message_agent), then keep waiting.`

If an agent blocks on an ask-user overlay, `herdr_get_agent_result` reports it
(`status: blocked`); answer **freeform** questions with `herdr_message_agent`
— the message is delivered as the raw answer, typed into the overlay — and
**option-list** questions with `herdr_send_keys` (typed text never reaches an
option list — bare `Enter` picks option 1, `down` then `Enter` picks option 2).

> ⚠️ **Interrupting a stuck pane:** to send Ctrl-C to a runaway agent, use
> `herdr_send_keys` with `["ctrl+c"]` (set `agentScope: true` to target an agent
> rather than the raw pane).

### Example 5 — Raw panes (logs, servers, builds)

The pane quartet drives *non-agent* panes you have open in herdr:

> *Prompt:* `In pane w1:p3, run "npm run dev" (herdr_run_command), wait for the "ready" line (herdr_wait_output), and show me the first requests as they land (herdr_read_pane).`

**What happens:** The command is typed + submitted in that pane; pi watches the
output without spawning an agent for it.

---

## Tools

`pi-herdr` exposes **one surface of ten tools** (twelve when the remaining v0.6
tickets land). Every agent-surface tool accepts `target` as a **pane id**
(`w1:p3`), **agent name**, or **label**.

### The agent registry

Spawn `type` names resolve through a layered registry — **session** (inline
definitions from accepted spawns this session) > **project** (`.pi/agents/*.md`)
> **global** (`~/.pi/agent/agents/*.md`) > **built-in** (`general-purpose`,
`Explore`, `Plan`). First-hit-wins per name, so a project file shadows a
global one and a session definition shadows both. The file layers are
read-at-use: a freshly saved `.md` resolves without a reload.

An agent file is YAML-ish frontmatter plus the system prompt as the body:

```markdown
---
name: auditor
description: Audits a diff for quality and security
kind: pi
model: anthropic/claude-opus-4-6
thinking: high
session-mode: fork
auto-exit: true
interactive: false
spawning: false
tools: read, bash
deny-tools: ["write", "edit"]
skills: ["/skills/audit"]
args: ["--plan"]
cwd: /repo
prompt_mode: append
---

You audit things. Be thorough.
```

The folder is **shared** with other agent-definition tools (same locations,
same precedence as the coinstallable prior art): unknown frontmatter keys are
ignored on both sides, and list values accept either a JSON array or a plain
comma list. A malformed file is skipped and reported (in the unknown-type
error) — it never kills the rest of the registry. `model`/`thinking` resolve
through the five-level routing chain (spawn param > frontmatter > settings pin
> settings default > this session's model — exact `provider/model-id` only,
enforce-or-error naming the level; see [Concepts](docs/concepts.md));
`session-mode`, `auto-exit`, and `interactive` ride the spawn; `session-mode`
selects how the child session begins (see [Session modes](#session-modes)).

### The spawn entry point

| Tool | What it does |
| --- | --- |
| `herdr_spawn_agent` | Spawn a background agent in a herdr pane, submit the task prompt, return `{name, paneId, status, sessionPath, stance, model, thinking, session_mode}`. Registry `type` (`general-purpose` / `Explore` / `Plan`, plus `.md`-registry and session-inline definitions) xor an inline `agent: {…}` definition. `model`/`thinking` resolve down the five-level routing chain — spawn param > frontmatter > `models.agents.<name>` > `models.default` > this session's model — exact authenticated `provider/model-id` only, enforce-or-error naming the offending level. `fork: true` boots a pi child with this conversation as context, truncated before your last user message (see [Session modes](#session-modes)). Gates (kill-switch → depth → parallel cap, over-cap = queued), `isolated: true` worktrees, `wait` to block for the result. Prompts over 2000 chars ride `<session>.task.md` beside the child's session file, delivered as a one-line reference. Every pi child runs on a parent-owned session file in pi's default sessions dir (`herdr/<name>` in `/resume`) with the injected child extension (`agent_done`, identity strip, typed completion sidecars); stance: autonomous (auto-exit on settle — pane closes, session retained) by default, `interactive: true` keeps the pane open. |
| `herdr_save_agent` | Persist an inline `agent` definition or an existing registry `type` to a `.md` file in the project (`.pi/agents/`, default) or global registry — spawn it by `type` in any session afterwards. Ungated (delete the file to undo); refuses to overwrite an existing file unless `overwrite: true`. |

An inline `agent` definition takes: `name`, `description`, `kind` (default: the
`default_kind` setting, `"pi"` — an unopinionated passthrough onto herdr's
native `agent start --kind` axis), `model`, `thinking`, `system_prompt`,
`prompt_mode` (`replace`\|`append`), `tools`, `exclude_tools`, `skills`
(pi-only), `agent_args` (raw CLI flags, e.g.
`["-ne","-e","./src/index.ts"]` to load a local extension — spawn-level
`agent_args` append after the definition's, last-wins), `session_mode`
(`standalone`\|`lineage-only`\|`fork` — see [Session modes](#session-modes)),
`auto_exit`, `interactive`,
`spawning`, `cwd`. Honesty rule: a field the chosen kind cannot enforce refuses
the spawn naming the field — use `agent_args` or another kind.

### Session modes

How a spawned pi child's session begins relative to this conversation — selected
by frontmatter `session-mode:` or the spawn-level `fork: true` override:

- **`standalone`** (default) — fresh session, no lineage. Today's behavior.
- **`lineage-only`** — the child's seeded session header carries the
  `parentSession` link to this session, with zero copied turns; pi's `/resume`
  shows the relationship (lineage discovery, later forking).
- **`fork`** — this conversation is copied into the child's session file,
  **truncated just before your last user message**, session-entry noise
  (model/thinking changes, compaction and branch summaries, custom extension
  entries) filtered out — the child boots knowing everything discussed and
  receives its prompt as the natural next user turn. Honest costs: fork is a
  **context-copy tax** (the child re-processes the whole copied conversation)
  and a **snapshot** (it freezes at spawn; the parent keeps moving; the pushed
  result is the only sync-back). For "you know what we've discussed, now do
  X" — never a default. A fork requested when this session has no readable
  session file seeds an empty file (standalone on disk); the mode still
  reports what was selected.

The registry records the mode alongside the session path; resume replays the
file whatever its lineage.

### Results and steering

| Tool | What it does |
| --- | --- |
| `herdr_get_agent_result` | **The result tool.** For spawned pi children it reads the EXACT final assistant message from the child's parent-owned session file (byte-identical, complete — no screen scraping); mid-flight calls return an interim snapshot. A failing child surfaces as a typed error (`stopReason`/`errorMessage` mined off the session). Panes this session didn't spawn (or non-pi kinds) fall back to pane-tail reading. A gone pane still answers with last-known metadata — its session file stays readable and resumable. `wait: true` blocks until done/failed/blocked/gone (through the queue). |
| `herdr_message_agent` | **The open channel** — anyone ↔ anyone, no broker. Resolves `target` (pane id → herdr name → spawn handle → reserved `orchestrator` role; real names win) and injects text through the send machinery. Physics-adaptive: a blocked target gets the raw text as its answer; everything else is wrapped as `<agent-message from="…" to="…">` — spawner-declared identity, never verified. Fire-and-forget: the receipt reports `{delivery: "message"\|"answer"}`; delivered-to-the-pane ≠ consumed-by-the-model. |
| `herdr_interrupt_agent` | **Turn cancel** (pi children) — sends Escape to the pane and stamps the registry so the fleet reports `interrupted` immediately, even while herdr still shows the pane working; a lagging pre-interrupt activity snapshot can't overwrite it. The pane, session file, and supervision all stay intact. Not a terminate — closing panes is the kill-all action. Follow with `herdr_message_agent` for stop-and-redirect. Refuses honestly: non-pi kinds (use `herdr_send_keys` for a raw Escape), queued/never-started agents, settled panes, and gone panes — which point at `herdr_resume_agent`. |
| `herdr_resume_agent` | **The recovery move** — relaunch a `gone` agent on its retained session file (`pi --session <retained>` in a fresh pane), by registry HANDLE (never a raw path). The launch plan re-derives NOW (the routing chain against current settings and this session's model — a settings change since death takes effect); the optional `message` is the opening prompt. Re-enters normal supervision: fleet row, watchdog, push-on-completion. Same gates as any spawn (kill-switch → depth → cap, over-cap = queued). Stance follows the definition: autonomous resumes auto-exit-and-push, interactive stay open. Honest limit: resume replays the session file — anything that lived only in the dead process is gone. |

> `herdr_wait_agent` / `herdr_read_agent` are **retired** (v0.6 issue 04):
> `herdr_get_agent_result` replaces them with exact session-file reads.

### Push delivery, takeover, and idle re-arm

You never have to poll. When a spawned pi child finishes — by settling
autonomously or by calling its injected `agent_done` — the child's **full
final message is steered straight into your session**: the push carries the
letter, not a doorbell. Detection is triply redundant: the child's typed
completion sidecar first, then the session JSONL's last message when a child
died without one (typed error if it died failing), then an honest gone note
after a bounded grace when a pane vanished. Transient herdr hiccups never
fake a completion. Each terminal event is pushed exactly once, and a **blocked**
child always wakes you (answer via `herdr_message_agent`) regardless of settings.

The `notifications` setting governs the wake: `normal` steers the result in
and wakes you immediately; `quiet` delivers it on your next natural turn
without waking; `none` pushes nothing — pull with `herdr_get_agent_result`
whenever you want (blocked still always wakes).

**User takeover** splits two effects. If *you* type into a running child's
pane, its auto-exit is disabled — a pane never slams shut on a human — while
the result contract stays intact (`agent_done` still works, the session file
is readable throughout). Your orchestrator gets a quiet
`user took over <agent>` note on its next turn, and no mid-conversation
pushes land from that pane. The child distinguishes your keystrokes from its
orchestrator's own follow-ups (a steer watermark the parent stamps before it
drives the pane), so `herdr_message_agent` never fakes a takeover.

**Idle re-arm** is the headless plug: after a takeover, once the child
settles and stays quiet for `idle_rearm_minutes` (default 15; any keystroke
resets the timer), its latest final message auto-delivers — honestly labeled
*auto-delivered after user steer* — the pane closes, and the session file is
retained for resume. SSH in, steer, log out: the result still arrives, no
orphan panes.

`herdr_get_agent_result` stays pure inspection: mid-flight snapshot, bounded
wait, re-read — never a mandatory second step after spawn.
> Raw pane reads remain on the pane-sync quartet (`herdr_read_pane`).

### Interrupt, resume, and recovery

**Interrupt** (`herdr_interrupt_agent`) cancels an agent's CURRENT turn, not
the agent: Escape lands in the pane, the session file and supervision stay
untouched, and the fleet row flips to `interrupted` on the spot (the parent's
Escape receipt leads herdr's own view — a lagging activity snapshot can't
overwrite it). New work ends the interrupt: `herdr_message_agent` returns the
agent to `active` — stop-and-redirect in one flow. A human typing into the
pane ends it too (the projection self-corrects on the first fresh active
snapshot).

**Resume** (`herdr_resume_agent`) is the documented recovery move for a
gone agent — crashed, errored, or pane-closed mid-run. The registry kept the
retained session file; resume relaunches on it, so the child boots with its
full conversation, not from scratch. The launch plan re-resolves at resume
time (routing levels against current settings — change `models.default`
between death and resume and the child relaunches on the new model), and the
run re-enters every supervision path as any spawn. Same gates, same honest
limit: the session file is the whole truth — anything that lived only in the
dead process is gone.

### Fleet introspection

| Tool | What it does |
| --- | --- |
| `herdr_list_agents` | List all running agents with status — the fleet's single introspection tool. |

### The pane-sync quartet (raw pane control)

| Tool | What it does |
| --- | --- |
| `herdr_run_command` | Run a shell command (text + Enter) in an existing raw pane. |
| `herdr_read_pane` | Read a raw pane's terminal output. |
| `herdr_wait_output` | Block until a pane emits matching output (e.g. a server `ready` marker). |
| `herdr_send_keys` ⚠️ | Send logical key presses (`ctrl+c`, `esc`, `Enter`) — interrupts, option-list answers. |

Per-tool reference: [docs/tools/orchestration.md](docs/tools/orchestration.md) ·
[docs/tools/pane-sync.md](docs/tools/pane-sync.md) ·
[docs/concepts.md](docs/concepts.md).

## How completion is detected (and why it's reliable)

herdr auto-detects a pi pane's state from its TUI. It reliably catches `idle → working`
but **sometimes misses `working → idle`**, which can leave a finished pane stuck on
`working` and hang a wait. `pi-herdr` solves this with **self-report**:

When pi runs inside a herdr pane, this extension pushes its real state to herdr on
lifecycle hooks — `agent_start → working`, `agent_settled → idle` — and on the
blocked EventBus channels. The current channel is `herdr:blocked`, emitted by
[`pi-ask-user`](https://www.npmjs.com/package/pi-ask-user) (v0.14+) when `ask_user`
waits/resumes **and** by `pi-subagents` for attention states; the legacy
`rpiv:ask-user:blocked` ([`@juicesharp/rpiv-ask-user-question`](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question))
and `pi-cursor-sdk:ask-question:blocked` ([`pi-cursor-sdk`](https://github.com/fitchmultz/pi-cursor-sdk))
are kept for back-compat (`active: true → blocked`, `active: false → working` so
the turn resumes). pi-herdr is the bridge that turns `herdr:blocked` into a herdr
`pane report-agent --state blocked` — nothing else in JS consumes it, so without
this bridge blocked detection relies on herdr's native TUI-watching. A global install
(`pi install npm:@andrewjacop/pi-herdr`) loads the extension into **every** pi —
including spawned ones — so all pi agents report reliably.

Completion is read from herdr's state events — never inferred from the
rendered `Working…` spinner (tool-call output replaces that spinner mid-work, which
would otherwise cause false "idle" reports). The spawn submits its task with one
atomic `agent prompt <pane> <text> --wait` call; its wait vocabulary races a
polling `agent get` fallback alongside the event wait: if the event never fires
(e.g. a `done`/`idle` state herdr doesn't derive), the poll still detects the
settled state promptly —
instead of hanging on the event or timing out the budget. For an agent that can't
self-report (e.g. `claude`/`codex`), the poll catches the settled state too.

> **Tip:** You can always unstick a pane manually:
> `herdr pane report-agent <pane> --source manual --agent pi --state idle`.

## Configuration (environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `HERDR_BIN` | `herdr` (resolved via `PATH`/`PATHEXT`) | Override the herdr binary path. |
| `PI_HERDR_NO_SELF_REPORT` | unset | Set to `1` to disable self-report in this pi. |

## Settings (`/subagents config`)

Run `/subagents` (or `/subagents config`) for the settings menu: one flat list of
`key = value (source: project | global | default)` rows plus a confirmed
**Kill all agents** action. Bool rows toggle, enum rows pick, number rows
input, `default_kind` picks from the live kind list, `models.default` takes a
free model id (empty unsets it), and the `models.agents` row edits one
agent-name pin at a time (empty model removes the pin). Each edit persists to
whichever file owns the key (a default-sourced key writes the project file), so
a project checkout never mutates your global config. There is deliberately
**no** `/subagents set key value` args form: settings are user knobs, and
hand-editing the JSON files stays the scriptable path.

Settings live in two JSON files, deep-merged with the project file winning per
key (and per agent name for `models.agents`):

| File | Scope |
| --- | --- |
| `~/.pi/agent/herdr.json` | global |
| `<project>/.pi/herdr.json` | project (wins per key) |

| Key | Default | Purpose |
| --- | --- | --- |
| `agents_kill_switch` | `false` | Refuse new agent spawns. A gate only — never terminates running agents (that's the menu's Kill-all action). |
| `default_kind` | `"pi"` | Agent kind spawned when none is given (validated against the live `herdr agent` kind list). |
| `models.default` | *(unset)* | Model id every spawned agent falls back to (routing level 4). Empty/absent = routing falls through to the parent session's model. |
| `models.agents.<name>` | `{}` | Per-agent model pins (routing level 3): agent name → model id. Entries merge across both files, project winning per name. |
| `max_parallel_agents` | `3` | Concurrency cap; spawns beyond it are queued until a slot frees. |
| `max_spawn_depth` | `2` | Guard against runaway recursive fleets. |
| `notifications` | `"normal"` | Wake behavior when a spawned agent completes: `normal` = the full result is steered in and the session wakes; `quiet` = delivered on the next natural turn, no wake; `none` = no pushes at all (pull-only). A blocked agent always wakes, whatever this is set to. |
| `idle_rearm_minutes` | `15` | After a user takeover, minutes of quiet (any keystroke resets) before the agent's latest final message auto-delivers — labeled *auto-delivered after user steer* — and its pane closes. The timer starts on settle, never mid-work; the session file is retained for resume. |
| `workflows_enabled` | `true` | Register the workflow tool (consumed by the workflows ticket). A gate on new runs only. |

Every key is read at the moment it matters, so menu edits take effect on the
next operation — no restart needed. Malformed JSON in a settings file is
reported (and ignored) rather than silently dropping your other file's values;
the menu never overwrites a file it can't parse. The v0.5 `surface` and
`allow_save_agent` keys are gone (see [Upgrading](#upgrading-v05--v06)).

## Upgrading v0.5 → v0.6

**Breaking: the tool surface was cut from 43 to one deliberate surface** (9
tools today, 12 at v0.6 completion), and `/herdr` became `/subagents config`.
Removed tools and their replacements:

| Removed | Use instead |
| --- | --- |
| `herdr_send_prompt` | `herdr_message_agent` (v0.6 issue 05) — same delivery path, plus the envelope, the full resolution chain, and the reserved `orchestrator` role. |
| `herdr_wait_agent` / `herdr_read_agent` | `herdr_get_agent_result` (exact session-file reads; `wait: true` blocks until terminal). |
| `herdr_delegate` | `herdr_spawn_agent` + `herdr_get_agent_result(wait: true)` (spawn + wait is the one-shot form; push delivery now brings the result to the session on its own). |
| `herdr_start_agent` | `herdr_spawn_agent` (same single `agent start --kind` launch path underneath; registry types or inline definitions instead of loose flag bags). |
| `herdr_get_agent`, `herdr_explain_agent` | `herdr_list_agents`. |
| `herdr_stop_agent` | The confirmed **Kill all agents** action in `/subagents config`; for one runaway agent, `herdr_send_keys` with `["ctrl+c"]`, or close the pane in the herdr UI. |
| `herdr_rename_agent`, `herdr_focus_agent` | The herdr UI (rename/focus a pane yourself). |
| `herdr_split_pane`, `herdr_close_pane` | The herdr UI — open/arrange panes yourself; drive them by id with `herdr_run_command` / `herdr_read_pane` / `herdr_wait_output` / `herdr_send_keys`. |
| All layout CRUD (`herdr_list_panes`, `herdr_get_pane`, `herdr_resize_pane`, `herdr_zoom_pane`, `herdr_move_pane`, `herdr_swap_panes`, `herdr_list_tabs`, `herdr_create_tab`, `herdr_get_tab`, `herdr_focus_tab`, `herdr_rename_tab`, `herdr_close_tab`, `herdr_list_workspaces`, `herdr_create_workspace`, `herdr_get_workspace`, `herdr_focus_workspace`, `herdr_rename_workspace`, `herdr_close_workspace`) | The herdr UI — layout is a human action; the machinery survives internally where later tickets need it (pane focus for "go look"). |
| Worktree CRUD (`herdr_worktree_create`, `herdr_worktree_open`, `herdr_worktree_list`, `herdr_worktree_remove`) | `isolated: true` on a spawn (auto-created worktree), or `herdr worktree …` in your own terminal. |
| Introspection (`herdr_api_snapshot`, `herdr_session_list`, `herdr_session_stop`, `herdr_session_delete`) | `herdr` CLI directly (`herdr api snapshot`, `herdr session …`). |
| Settings keys `surface`, `allow_save_agent` | Gone — one surface, nothing to switch to; `save_agent` lands ungated (ticket 03). Stale keys in your JSON files are ignored harmlessly. |

No runtime nagging, no shim tools — a clean cut ([wayfinder ticket 09](wayfinder/tickets/09-surface-cut-settings.md)).

## Platform notes

- **Requires herdr ≥ 0.9.0** (hard floor — see Requirements). Everything above the
  floor goes through exactly one launch path on every OS: split a pane, then
  `agent start <name> --kind <kind> --pane <id> [-- <argv>]`. herdr resolves
  the kind to its CLI itself, so npm `.cmd` shims on Windows need no special
  handling here — 0.9.0 is the release that fixed that (and the flaky
  process-tree detection) on herdr's side.
- **macOS:** the only macOS gotcha is environmental: a herdr server started by
  `brew services` / launchd (or a GUI launch) inherits macOS's minimal PATH, so
  node-based agents like `pi` can't find `node`. Launch herdr from your terminal
  instead (see Requirements).

## Development

```bash
npm install
npm test                 # offline suites (smoke + settings + spawn) — no herdr required
npm run typecheck        # tsc --noEmit
npm run test:live        # requires a running herdr session
npm run test:multi       # 3 parallel agents, multi-step, artifact-verified
npm run test:stress      # 5 parallel agents, heavy multi-tool, artifact-verified
```

The extension is TypeScript loaded via jiti — **no build step**. Edit `src/` and
`/reload` (or restart pi).

### Project layout

```text
src/
  index.ts               # entry; registers the 11-tool surface + footer status + self-report
  herdr.ts               # the one spawn module (envelope parse, timeouts, errors, version probe + floor gate)
  version.ts             # pure version-floor logic (parse/compare/HERDR_TOO_OLD)
  config.ts              # binary resolution + live agent-kind list (env + PATH)
  env.ts                 # shared types + unwrap/normalize/extractText helpers
  selfreport.ts          # push this pi's state to herdr (reliable completion)
  child.ts               # the injected child extension (agent_done, session naming, sidecars, auto-exit, identity strip)
  sessionfile.ts         # parent-owned session files (pi-default dir, seeding, JSONL result extraction, .exit sidecars)
  spawn.ts               # the herdr_spawn_agent engine (gates, spec merge, queue, wait, launch plan, stance)
  agentdefs.ts           # agent-definition registry (built-in + session + .md file layers)
  settings.ts            # effective-settings resolution (global + project JSON, models.* routing keys)
  menu.ts                # the /subagents config menu + Kill-all-agents action
  tools/agents.ts        # herdr_spawn_agent registration (the spawn entry point)
  tools/result.ts        # herdr_get_agent_result (exact JSONL result; pane-tail fallback for unspawned panes)
  tools/message.ts       # herdr_message_agent (the open channel: resolution chain, envelope, physics-adaptive delivery)
  tools/lifecycle.ts     # herdr_interrupt_agent + herdr_resume_agent (turn cancel; the gone-agent recovery move)
  tools/orchestration.ts # list_agents + the send machinery (spawn submit, message delivery, launch/wait paths)
  tools/sync.ts          # pane-sync quartet (run/read/wait_output/send_keys)
  tools/worktrees.ts     # worktree machinery (powers isolated; no model-facing tools)
tests/
  smoke.mjs, substrate.mjs, settings.mjs, spawn.mjs, agentfiles.mjs, message.mjs, lifecycle.mjs   # offline suites (npm test)
  live.mjs, selfreport.mjs, blocked.mjs, spawn-live.mjs, message-live.mjs, dev-load.mjs, …
```

## Contributing

Contributions are welcome — especially macOS/Linux testing! Please open an issue
first to discuss substantial changes. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Appendix: fleet machinery (internal, off the model surface)

These capabilities exist in herdr and remain fully available **to you** — they
are just no longer registered as model-facing tools (the v0.6 surface cut).
pi-herdr keeps the thin slices it needs internally:

- **Worktree create/remove** — powers `isolated: true` spawns (auto branch +
  path). Hand management: `herdr worktree create|open|list|remove`.
- **Pane close / focus** — powers the menu's confirmed Kill-all action and
  future "go look" affordances. Hand use: the herdr UI, or
  `herdr pane close|focus …`.
- **`agent get` polling** — the internal fallback that catches settled states
  the event waits miss. Hand use: `herdr agent get <pane>`.
- **Sessions & snapshot** — `herdr session list|stop|delete`, `herdr api
  snapshot` (herdr's own debugging surface).

## Limitations / roadmap

- **v0.6 in flight** (the subagent experience layer): the session substrate
  (parent-owned session files + injected child extension) and
  `herdr_get_agent_result` landed; still coming: push delivery with
  user-takeover and idle re-arm, a 10-state projected lifecycle with watchdog
  and activity sidecars, fork/lineage/standalone session modes,
  model/thinking routing (`models.default` / `models.agents.<name>`),
  interrupt + resume, a fleet widget, and scripted workflows
  (`run_workflow`). See [wayfinder/map.md](wayfinder/map.md).
- **Tested on Windows and macOS** (see [Platform support](#platform-support)).
- Self-report is pi-only; heterogeneous (claude/codex) completion relies on herdr's
  auto-detect (also caught by the `agent get` polling fallback).

## License

[MIT](./LICENSE) © Andrew
