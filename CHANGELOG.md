# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Interrupt + resume: the lifecycle pair (v0.6 issue 10).**
  `herdr_interrupt_agent(target)` is a turn-level cancel, not a terminate: it
  sends Escape to the child pane via the existing key-send machinery and
  stamps the registry so the projection flips to `interrupted` immediately —
  ahead of herdr's own view — while stale pre-interrupt activity snapshots
  are discarded so a lagging reading can't overwrite the interrupt. The pane,
  session file, and supervision stay intact; new work ends the interrupt
  (a `herdr_message_agent` delivery clears the flag — stop-and-redirect in
  one live flow — and the projection self-corrects on the first fresh
  active snapshot, so a human typing into the pane ends it too).
  `herdr_resume_agent(target, message?)` is the documented recovery move for
  a `gone` agent: the target is a registry handle, never a raw path; the
  registry holds the retained session file, and resume relaunches
  `pi --session <retained>` in a fresh pane with a re-derived launch plan —
  the definition's kind/model/thinking resolved NOW via the routing chain
  (a settings change between death and resume takes effect), falling back to
  the spawn-time definition snapshot when the type can no longer be
  resolved. The optional `message` is submitted as the opening prompt (with
  the steer watermark and task-artifact machinery); a message-less resume
  replays the session and sits open without resubmitting the old task. The
  run re-enters normal supervision (fleet row, watchdog, push-on-completion);
  same gates as any spawn (kill-switch → depth → parallel cap, over-cap =
  queued via the same drain); stance follows the definition (autonomous
  resumes auto-exit-and-push, interactive stay open). The previous run's
  sidecars are cleared on relaunch so a stale completion can never be
  re-delivered as the resumed run's result. Pi-only: non-pi panes get an
  honest refusal pointing at `herdr_send_keys` (interrupt) or a
  re-spawn (resume); re-derived non-pi kinds refuse (`--session` is
  pi-only). Honest limit, documented: resume replays the session file —
  anything that lived only in the dead process is gone. Offline suites
  (`tests/lifecycle.mjs`, projection pins in `tests/status.mjs`) + a live
  suite (`tests/lifecycle-live.mjs`): interrupt → stop-and-redirect and one
  crash → gone → resume → push round-trip where the resumed child answers
  from its replayed conversation.

- **Session modes: standalone / lineage-only / fork (v0.6 issue 09).** How a
  spawned pi child's session begins relative to the parent's conversation.
  `standalone` (default) is unchanged — an empty seeded file pi initializes
  itself. `lineage-only` seeds the child header with the `parentSession` link
  (the parent session file path pi's `/resume` builds lineage trees from) and
  zero copied turns. `fork` — selected by frontmatter `session-mode:` or
  forced by the new spawn-level `fork: true` — copies the parent conversation
  into the child's session file, **truncated just before the parent's last
  user message**, session-entry noise (model/thinking changes, compaction and
  branch summaries, custom extension entries) filtered, re-chained into a
  fresh linear tree so pi's context walk sees every copied turn — the child
  boots knowing everything discussed and receives its task as the natural
  next user turn. Honest costs, stated in the docs: fork is a context-copy
  tax (the child re-processes the whole copied conversation) and a snapshot
  (freezes at spawn; the pushed result is the only sync-back). A fork with no
  readable parent session seeds an empty file (standalone on disk) while the
  mode keeps reporting the selection. A meaningful `session_mode` on a kind
  without a session substrate refuses (enforce-or-error, naming the field).
  The registry records the mode alongside the session path. Live-tested: a
  forked child answers a question about the parent conversation without being
  told (`tests/modes-live.mjs`).
- **Launch plan builder + 5-level model/thinking routing chain (v0.6 issue
  08).** One builder (`src/launchplan.ts`) composes the full argv for every
  spawn — parent-owned `--session`, injected `-e` child extension, routing
  flags, prompt flags, raw flags — replacing the two-site inline composition.
  `model`/`thinking` now resolve through five levels (spawn param >
  frontmatter > `models.agents.<name>` > `models.default` > this session's
  model; thinking never inherits from the parent) with **enforce-or-error**
  validation: exact authenticated `provider/model-id` only, no fuzzy
  resolution, and every refusal names the level that supplied the bad value.
  Pi children get a lean identity + mode-hint block appended to their system
  prompt (`herdr/<name>`, the settle/`agent_done` contract, the seeded-lineage
  note for fork/lineage-only), and prompts over 2000 chars are written to
  `<session>.task.md` beside the session file, delivered as a one-line
  reference (Windows argv/typing-length safe; survives resume). Frontmatter
  `args:` (e.g. a plannotator `--plan` planner) and the new spawn-level
  `agent_args` append last-wins — the sanctioned raw-CLI escape hatch. Stance
  fields (`auto-exit`, `interactive`, `session-mode`, `isolated`) ride the
  launch plan end to end; the spawn result now reports the resolved
  `model`/`thinking` + `session_mode`. herdr stays the launcher: non-pi kinds
  keep the honest one-liner passthrough, no multi-harness driver layer.
- **Push delivery + user takeover + idle re-arm (v0.6 issue 06).** A spawned
  pi child's completion now comes to you: the delivery loop watches the spawn
  registry and steers the child's **full final assistant message** into your
  session — the push carries the letter, no doorbell, no summary-then-fetch.
  Both completion routes push (autonomous auto-settle and the declared
  `agent_done`), and detection is triply redundant: typed exit sidecar →
  session-JSONL sentinel (a sidecar-less death still delivers, mined as a
  typed error when it died failing) → an honest gone note after a bounded
  grace. Transient herdr errors never fake a completion; each terminal event
  pushes exactly once. Wake follows the `notifications` setting — `normal`
  steers + wakes (`triggerTurn`, `deliverAs: "steer"`), `quiet` delivers on
  the next natural turn, `none` pushes nothing (pull-only) — and a **blocked**
  child always wakes regardless, unless you've taken its pane over. **User
  takeover** (your typing in a child's pane, reported by the child extension
  and disambiguated from the orchestrator's own steering via a
  `<session>.steer` watermark) disables auto-exit only — a pane never slams
  shut on a human — while the result contract is never revoked: `agent_done`
  stays available, the session file is readable before/during/after, the
  orchestrator gets a quiet `user took over <agent>` note, and no
  mid-conversation pushes land from that pane. **Idle re-arm** plugs the
  headless case: takeover + settle + `idle_rearm_minutes` (default 15; any
  keystroke resets, timer starts on settle) auto-delivers the latest final
  message labeled *auto-delivered after user steer*, closes the pane, and
  retains the session for resume. `herdr_get_agent_result` stays pure
  inspection (snapshot, bounded wait, re-read). One shared poll loop
  (`src/delivery.ts`) drives it all; the status projection (07) and
  workflows (08/11) hang off the same loop. Offline: `tests/delivery.mjs`;
  live round-trip: `tests/push-live.mjs`.

- **The open message channel: `herdr_message_agent` (v0.6 issue 05).** One
  tool, anyone ↔ anyone, no broker: any session (orchestrator, child, or peer)
  delivers text to any agent pane. The `target` is always explicit and
  resolves down the shared chain — exact pane-id → herdr name →
  spawn-registry handle → the reserved role `orchestrator` (via
  `PI_HERDR_ORCHESTRATOR_PANE`, stamped when a pi-herdr agent spawned this
  session; a session no agent spawned gets the honest "no orchestrator above
  you, answer in-conversation" error) — real names winning over reserved.
  Delivery is physics-adaptive: a **blocked** target gets the raw text typed
  into its question overlay (the message IS the answer; option lists still
  take `herdr_send_keys`), everything else is enveloped as
  `<agent-message from="…" to="…">…</agent-message>` — identity is
  spawner-declared (`PI_HERDR_AGENT_LABEL` → `PI_HERDR_NAME` → pane name →
  pane id → `"session"`), never verified, and there is no child-side parsing:
  the receiving *model* recognizes the tag. No state gates (text to a working
  child queues natively); fire-and-forget — the receipt
  `{delivered, target, to, from, state, delivery: "message"|"answer", name?,
  submit}` reports which path ran, but delivered-to-the-pane ≠
  consumed-by-the-model. A `gone` target errors naming the handle and
  pointing at `herdr_list_agents`; a queued (not-yet-started) spawn has no
  pane and errors the same way.

- **The session substrate + `herdr_get_agent_result` (v0.6 issue 04).** Every
  spawned pi child now runs on a **parent-owned session file** in pi's default
  sessions dir (`~/.pi/agent/sessions/--<child-cwd>--/<timestamp>_<uuid>.jsonl`
  — seeded by the parent before launch, no `--session-dir`), so any spawned
  session is resumable and perusable from plain pi (`/resume`,
  `pi --session <path>`); the injected child extension names it
  `herdr/<spawn-name>` at boot so fleet sessions never masquerade as the
  user's own. The extension (loaded via `-e`, beside this package) provides:
  the `agent_done` completion declaration (writes the sidecar, exits), typed
  completion sidecars `<session>.exit` (`{type:"done"}` / `{type:"error",
  errorMessage, stopReason}` — provider-overload retry-exhaustion reaches the
  parent as a typed failure), auto-exit on `agent_settled` for
  **autonomous-stance** children (interactive ones never auto-close; an error
  settle waits a quiet 30 s grace window first so pi's retry machine isn't
  killed mid-backoff), and the identity/tools strip
  (`[scout] — 12 tools · 4 denied (Ctrl+H)`) above the child's editor. The
  spawn registry grows `sessionPath`, `activityPath` (reserved for the status
  projection), `launchPlan` (the exact composed argv), `stance`, and
  `deniedTools`; spawn responses report `sessionPath` + `stance`.
  **`herdr_get_agent_result`** is the new pull/inspection tool: it reads the
  EXACT last assistant message from the session JSONL (byte-identical, no tail
  heuristics), checks the sidecar before pane status (an auto-exited child is
  fleet-`gone` but `done`/`error` here), returns interim snapshots while the
  child works, and treats a failed attempt on a live pane as non-terminal
  (the child may still retry). Pane-tail reading survives only as the
  fallback for panes pi-herdr did not spawn and non-pi kinds; `gone` answers
  carry last-known registry metadata, and sessions are never deleted —
  closing a pane loses nothing. Surface: 10 → 9 tools (the legacy trio's
  `herdr_wait_agent` / `herdr_read_agent` are retired; `herdr_send_prompt`
  remains until `herdr_message_agent` absorbs it).

### Removed

- **`herdr_send_prompt` (breaking, v0.6 issue 05).** Absorbed by
  `herdr_message_agent` — same send machinery underneath (`agent prompt` /
  `pane send-text`), plus the envelope, the full resolution chain, and the
  reserved `orchestrator` role. `herdr_get_agent_result`'s blocked-answer
  text now points there. Surface stays at 9 tools; the count converges to 12
  as tickets 10/12 land.

- **`herdr_wait_agent` and `herdr_read_agent` (breaking, v0.6 issue 04).**
  Replaced by `herdr_get_agent_result` — `wait: true` blocks until
  done/failed/blocked/gone, and the result is the exact final assistant
  message rather than a screen scrape. Raw pane reads remain on
  `herdr_read_pane` (pane-sync quartet).

- **The `.md` agent registry + `herdr_save_agent` (v0.6 issue 03).** Agent
  definitions now load from YAML-frontmatter `.md` files: `.pi/agents/`
  (project) > `~/.pi/agent/agents/` (global) > bundled — first-hit-wins per
  name, project shadowing global, session inline definitions shadowing both,
  read-at-use (a saved file resolves without a reload). The frontmatter
  dialect is the full v0.6 field set — `model`, `thinking`, `session-mode`,
  `auto-exit`, `interactive`, `spawning`, `deny-tools`, `args` (raw CLI
  flags), `cwd`, `prompt_mode`, plus the identity/system-prompt fields, with
  the system prompt as the file body — and it is deliberately shared with the
  coinstallable prior art: unknown keys are ignored on both sides, list
  values accept JSON arrays or comma lists, a malformed file is skipped and
  reported without killing the rest of the registry. `herdr_save_agent`
  persists an inline definition or any registry `type` to the project
  (default) or global folder — ungated by decision (low risk, reversible by
  deleting the file), with an overwrite guard for existing files. Inline
  definitions gained the same v0.6 fields (`thinking`, `session_mode`,
  `auto_exit`, `interactive`, `spawning`, `cwd`); definition `cwd` feeds the
  spawn (spawn param wins), frontmatter `args` ride `agent_args` today.
  Surface: 9 → 10 tools.

### Removed

- **Breaking: the v0.6 surface cut — 43 tools → one deliberate surface of 9
  (12 at completion); `/herdr` became `/subagents config`.** One surface,
  nothing to switch to: the `surface: agents|full` setting is gone. Kept
  today: `herdr_spawn_agent`, the legacy result trio (`herdr_send_prompt` /
  `herdr_wait_agent` / `herdr_read_agent` — retired by `get_agent_result` in
  ticket 04), `herdr_list_agents` (the fleet's single introspection tool),
  and the pane-sync quartet (`herdr_run_command` / `herdr_read_pane` /
  `herdr_wait_output` / `herdr_send_keys`); later tickets register
  `get_agent_result`, `message_agent`, `interrupt`/`resume`, and
  `run_workflow`. Removed from the model surface, with replacements:
  `herdr_delegate` → spawn + `wait` (+ wait/read; push delivery makes it
  redundant); `herdr_start_agent` → `herdr_spawn_agent` (same single
  `agent start --kind` path); `herdr_get_agent` / `herdr_explain_agent` →
  `herdr_list_agents`; `herdr_stop_agent` → the confirmed Kill-all menu
  action or `herdr_send_keys ["ctrl+c"]`; `herdr_rename_agent` /
  `herdr_focus_agent` → the herdr UI; `herdr_split_pane` / `herdr_close_pane`
  → the herdr UI (drive existing panes by id); all 18 layout tools
  (panes/tabs/workspaces CRUD) → the herdr UI; worktree CRUD →
  `isolated: true` or `herdr worktree …`; `herdr_api_snapshot` /
  `herdr_session_*` → the `herdr` CLI. **Machinery survives internally —
  code deletion ≠ capability deletion**: worktree create/remove powers
  `isolated` (`src/tools/worktrees.ts` is machinery-only now), pane close
  powers kill-all, the `agent get` poll loop powers every wait;
  `src/tools/layout.ts` and `src/tools/introspection.ts` are deleted
  outright (no internal consumers). Tools keep the `herdr_` prefix; no
  runtime nagging, no shim tools. Decided by wayfinder ticket 09
  (surface-cut settings).

### Changed

- **Breaking: version floor — herdr ≥ 0.9.0, hard.** herdr below 0.9.0 now
  refuses to run: init probes `herdr --version` once and surfaces exactly one
  `HERDR_TOO_OLD` error naming the upgrade pointer (herdr.dev), in the same
  style as `HERDR_UNAVAILABLE`; the gate lives inside `herdr()` itself, so no
  tool can half-work below the floor and there are no degraded paths. An
  unparseable version is refused too (a hard floor doesn't guess); a missing
  binary keeps its single natural `HERDR_UNAVAILABLE`. Above the floor,
  everything goes through exactly one launch path on every OS —
  `agent start --kind <kind> --pane <id> [-- <agentArgs>]` — because 0.9.0 is
  the release that fixed Windows `agent start --kind` (npm-shim launch + flaky
  process-tree detection). The legacy forest dies with it: the 0.7.3 legacy
  `agent start`/`agent send`/`wait agent-status` API branches, the Windows
  0.7.5–0.8.x `pane run` + auto-detect spawn fallback (with its `agent rename`
  naming step), and the 0.8.2 `agent_not_ready` workarounds (pane-level prompt
  submission + screen-stability turn driving) are deleted. The `AGENT_NOT_READY`
  error code is removed from the normalized code set (spawn prompt-submission
  failures now surface as `AGENT_START_FAILED`). The version probe itself
  stays for diagnostics: the detected version still shows in the footer
  (`herdr: 3 agents (1 working) (0.9.0)`; below the floor it reads
  `herdr: too old (0.8.2 < 0.9.0)`). Self-report is untouched — orthogonal
  insurance against herdr's working→idle misses, not a version workaround.
- **Removed: agent preset/launcher machinery.** `HERDR_PRESET_<NAME>` env
  overrides, the Windows `cmd /c` preset wrappers, and `src/launcher.ts`
  (`expandAgentSpec`) are gone — they existed to build raw argv for launch
  paths that no longer exist. `agent start --kind` resolves the kind to its
  CLI on herdr's side; `agentArgs` after `--` is the supported way to pass
  native agent flags.

### Added

- **Settings: new key table — `models.*` routing, `idle_rearm_minutes`,
  `workflows_enabled`; `surface` and `allow_save_agent` die.** `models.default`
  (routing level 4, default unset = fall through to the parent session's
  model) and `models.agents.<name>` (per-agent model pins, routing level 3)
  resolve from nested JSON with deep-merge project-wins — per key, and per
  agent name for the record. `idle_rearm_minutes` (default 15) and
  `workflows_enabled` (default true) land for their consuming tickets. All
  are editable in the `/subagents config` menu: `models.default` takes a free
  model id (empty input unsets — absence, never a sentinel value), the
  `models.agents` row edits one agent-name pin at a time (empty model removes
  the pin), and every write persists nested into the owning file (unknown
  keys preserved, empty containers pruned). The `restart-required` marker is
  gone with `surface` — every key is hot. Stale `surface` /
  `allow_save_agent` entries in existing files are ignored harmlessly.
- **`/subagents config` — the command (was `/herdr`).** Bare `/subagents` and
  `/subagents config` both open the settings menu; an unknown sibling word is
  answered with a pointer (future words can grow). Kill-all stays a confirmed
  menu action. Still deliberately no `set key value` args form — settings are
  user knobs; hand-edit the JSON to script them.
- **`herdr_spawn_agent` — the v0.5 agent surface begins.** One call spawns a
  background agent pane, submits the task prompt, and returns
  `{name, paneId, status}`. The agent is specified by `type` (registry:
  built-in `general-purpose` / `Explore` / `Plan` with tintinweb-verbatim
  content — full descriptions, read-only allowlists, no model pins — plus
  session-ephemeral inline definitions from earlier spawns) xor an inline
  `agent: {...}` definition; exactly one, enforced. `name` is the pane handle
  (fallback chain spawn name → definition name → `agent-<timestamp>`,
  uniquified when taken). `kind`/`model` merge over the definition and the
  merged spec is validated enforce-or-error per kind — a field the kind
  can't enforce refuses the spawn naming the field (use `agent_args` or
  another kind; multiline pi system prompts ride a temp file through herdr's
  single-line-safe arg surface, other kinds refuse). Gates, checked in order
  before any side effect: kill-switch → spawn depth (`PI_HERDR_SPAWN_DEPTH`,
  unset = 1, child = +1) → parallel cap; at cap the spawn is accepted
  `status: "queued"` with no pane until a slot frees. `isolated: true`
  spawns into a fresh auto-created herdr-side git worktree. Background by
  default; `wait: true` blocks until done-or-blocked, `wait: <ms>` returns the
  current state on expiry. Children carry `PI_HERDR_SPAWN_DEPTH` (incremented)
  and `PI_HERDR_ORCHESTRATOR_PANE`.
- **Settings layer + `/herdr` menu.** Effective settings are the deep merge of
  `~/.pi/agent/herdr.json` (global) and `<project>/.pi/herdr.json` (project wins
  per key), with each value's source tracked (project | global | default). The
  bare `/herdr` command renders one flat interactive list — safety gates first,
  then behavior, then a confirmed **Kill all agents** action. Bool rows toggle,
  enum rows pick, number rows input; each write persists to the file that owns
  the key (a project checkout never mutates global config) and every key
  except `surface` is hot (read when it matters). `surface` is read once at
  init and its row is marked restart-required. Malformed JSON is reported and
  ignored, never silently clobbered. There is deliberately no `/herdr set key
  value` args form — settings are user knobs; hand-edit the JSON to script them.

## [0.5.0] - 2026-09-12

### Changed

- **Windows + herdr ≥0.9.0 now uses `agent start --kind`.** herdr 0.9.0 fixed the
  Windows `agent start --kind` launch (PowerShell `Start-Process` couldn't launch
  npm `.cmd` shims) and the flaky process-tree detection that made shim-launched
  agents intermittently drop out of the agents sidebar while still running
  (herdrdev/herdr #3032/#3205). On Windows with herdr ≥0.9.0, `herdr_start_agent`
  and `herdr_delegate` now register the agent with `agent start <name> --kind
  <kind> --pane <id> [-- <agentArgs>]` — proper named registration, lifecycle
  self-report, and native `--plan`/`-e` argument passthrough — identical to the
  macOS/Linux path. Windows herdr 0.7.5–0.8.x keeps the `pane run` + auto-detect
  fallback, and non-Windows platforms are unchanged. Validated e2e on Windows
  herdr 0.9.0: `--kind pi -- --plan` spawns named, stably-detected agents through
  a full plan-mode lifecycle (`tests/win-start.mjs` 13/13, plus a live `pi -e`
  self-host session spawning and driving a `--plan` agent).

### Fixed

- **Spawned panes landed in the herdr daemon's cwd, not the session's project.**
  When `cwd` was omitted, `herdr_start_agent`/`herdr_delegate`,
  `herdr_split_pane`, `herdr_create_tab`, and `herdr_create_workspace` let
  herdr default the new pane to the daemon process's cwd — which for a
  restored headless session is the user's home folder (e.g. an OPTOLINK
  session restored after reboot spawned agents in `C:\Users\Andrew`). All
  spawn surfaces now default `--cwd` to the pi process's own cwd, so panes
  land in the session root unless explicitly told otherwise.

## [0.4.0] - 2026-08-27

### Added

- **herdr 0.8.2 compatibility (Windows).** herdr 0.8.2's agent-surface readiness
  validation is broken for pi panes: `agent prompt` and `agent send-keys` fail with
  `agent_not_ready` ("no longer the pane foreground process") even on
  interactive-ready panes, and `agent start --kind`-launched panes additionally
  lose state self-reporting. Prompting now detects that error and transparently
  falls back to pane-level submission (`pane send-text` + 600 ms settle +
  `pane send-keys Enter` — the same bytes `agent prompt` sends), so
  `herdr_send_prompt` and `herdr_delegate` keep working. The fallback is
  self-gating: it only triggers on `agent_not_ready`, so healthy herdr versions
  are unaffected.
- **Degraded-mode turn driving in `herdr_delegate`.** On fallback-driven turns,
  lifecycle states are unreliable (stuck `idle`), so the delegate completes the
  turn by screen stability: 3 identical consecutive `agent read` polls after a
  10 s floor (a working TUI repaints continuously, so a stable screen means the
  turn settled). The driver samples `agent get` throughout, so an ask-user
  episode that resolves mid-turn still reports `details.wasBlocked: true`.
- **New `AGENT_NOT_READY` error code** in the normalized `HerdrErrorCode` set
  (mapped from herdr's `agent_not_ready`).
- **Validated multi-choice overlay semantics, documented everywhere relevant**
  (send_prompt guidelines, delegate blocked-relay instructions, docs):
  typed text never reaches a pi ask-user option list — bare `Enter` selects
  option 1 (preselected), `down`×n then `Enter` selects option n+1; typed text
  only lands in a focused freeform row. Answer freeform overlays with
  `herdr_send_prompt`, select options with `herdr_send_keys`.
- **`herdr_read_agent` now documents the alternate-screen scrollback limit**
  (in its tool description and docs): alternate-screen TUIs keep long answers
  off the host scrollback — ask the agent to write its response to a file and
  reply with the path, then read the file.

### Changed

- **Live test suite migrated to the herdr 0.7.5+/0.8.x CLI surface** — the
  legacy `agent start <name> --no-focus -- <argv>` form was removed upstream and
  all five affected tests now spawn through the current path. New shared helper
  `tests/_spawn.mjs` (split → `pane run` on Windows / `agent start --kind` on
  POSIX → detect → rename, plus `waitStatus`/`panePrompt`/overlay-answer
  helpers); `live.mjs` exercises the registered `herdr_start_agent` tool;
  `pong.mjs` drives `herdr_send_prompt` and polls the read; `selfreport.mjs`
  spawns with `-ne -e <local src>` (the global npm pi-herdr collides on tool
  names otherwise and crashes the spawned pi at boot); `blocked.mjs` answers
  overlays by key navigation with explicit `Red/Blue/Green` options and
  per-mode temp cwds.

### Verified

- Full offline gate: `typecheck` ✅, smoke 380/380 ✅.
- Full live suite on herdr 0.8.2 (stable, Windows): live 5/5, selfreport 4/4,
  pong 5/5, delegate 4/4, fallback 4/4, blocked 12/12, dev-load 11/11.
- Real-plugin QA sweep (`/herdr-qa all` in a fresh pi running the local
  extension): `FUNCTIONAL: pass`, `LIVE: pass`, `TOOLS: 43/43 pass`,
  `VERDICT: PASS`.

## [0.3.0] - 2026-08-11

### Added

- **`herdr_delegate` — `onBlocked` (`"wait"` \| `"return"`):** when a spawned agent
  blocks on `ask_user`, herdr 0.7.5's `agent prompt --wait` settles on `blocked` and
  returns ok — so previously the delegate treated the agent's *question text* as a
  successful answer and returned control to the orchestrator. The delegate now
  re-reads `agent get` after the turn settles and branches: `"wait"` (default) holds
  the call open with **no time bound** until a human answers in the spawned pane,
  then returns the final answer; `"return"` returns `{blocked, question, paneId}`
  immediately (`isError`, pane kept alive) for the orchestration session to relay.
  `timeoutMs` does not bound the `"wait"` phase.

### Fixed

- **Self-report now bridges `herdr:blocked`:** the current `pi-ask-user` (v0.14+)
  and `pi-subagents` emit `herdr:blocked`, but self-report only listened on the stale
  `rpiv:ask-user:blocked` channel — so blocked reporting silently relied on herdr's
  native TUI detection. Self-report now consumes `herdr:blocked` (the legacy
  `rpiv:ask-user:blocked` and `pi-cursor-sdk:ask-question:blocked` channels are kept
  for back-compat), making pi-herdr the single JS bridge that reports `blocked` to
  herdr.

### Tests

- `tests/blocked.mjs` (live): exercises both `onBlocked` modes against real spawned
  `pi` sessions (return-and-relay, and wait-then-inject).
- `tests/dev-load.mjs` (live): asserts `pi -ne -e <local pi-herdr> -e <pi-ask-user>`
  boots without conflicting with the globally-installed copy. Both wired into
  `test:live`; offline smoke gate grows to **380 checks**.

## [0.2.5] - 2026-08-02

The "full herdr 0.7.5 surface" release. The extension now wraps **43 tools** across
five tiers (was 11, orchestration-only) — pane/tab/workspace CRUD, raw pane sync,
git worktrees, and live introspection — plus bug fixes and refactors on the
redesigned 0.7.5 `agent` API. Offline smoke gate grows to **378 checks**; a full
**live sweep of all 43 tools** passed against herdr 0.7.5-preview.

### Added

- **Tier 3 — pane-sync (6 tools):** `herdr_split_pane`, `herdr_run_command`,
  `herdr_read_pane`, `herdr_wait_output`, `herdr_send_keys` (⚠️), `herdr_close_pane`
  (⚠️) — the raw-process surface 0.7.5 splits out from agents (use case: run a
  command in a pane and read its output on demand). Always emits `--timeout` so
  `wait_output` never hangs.
- **Tier 2 — layout (18 tools):** panes (`list`/`get`/`resize`/`zoom`/`move`/`swap`),
  tabs (`list`/`create`/`get`/`focus`/`rename`/`close` ⚠️), workspaces
  (`list`/`create`/`get`/`focus`/`rename`/`close` ⚠️). Pane `split`/`close` reuse
  Tier 3.
- **Tier 4 — git worktrees (4 tools):** `herdr_worktree_create`,
  `herdr_worktree_open`, `herdr_worktree_list`, `herdr_worktree_remove` (⚠️).
- **Tier 5 — introspection (4 tools):** `herdr_api_snapshot`, `herdr_session_list`,
  `herdr_session_stop` (⚠️), `herdr_session_delete` (⚠️). Interactive
  `session attach` is excluded.
- **User-facing wiki** under `docs/` — landing page, concepts (envelope, version
  branching, pane-vs-agent surface, targeting/naming, destructive tools),
  per-surface references for all 43 tools, and a development/testing guide.
- `tests/smoke.mjs` extended with argv-builder, normalizer, destructive-label, and
  registration-count assertions (84 → 378 checks).

### Fixed

- **`herdr_wait_agent` on herdr 0.7.5.** The removed `wait agent-status` group
  broke waits for `working`/`blocked`/`unknown` (only `idle`/`done` survived via
  the polling fallback). The new API now emits
  `agent wait <target> --until <s> [--until …] --timeout <ms>` (`idle`/`done` still
  race the `agent get` fallback); legacy keeps `wait agent-status`.

### Changed

- **`herdr_delegate` is atomic on 0.7.5.** Submit+wait is now a single
  `agent prompt <target> <text> --wait --timeout <ms>`; `agent_prompt_stalled`
  falls back to wait/poll instead of hanging, and the turn is re-sent up to 3× if
  it never starts. Legacy send → wait dance unchanged.
- **Dropped the dead `custom`/`argv` launch surface.** `agent:"custom"`+`argv` is
  rejected on 0.7.5; removed from the LLM schema. `agent` is now a free string
  **validated against the live `herdr agent` kind list** (cached per session,
  hardcoded fallback), else `VALIDATION_ERROR`. Use `agentArgs` to load a local
  extension.

### Docs

- README refreshed for the 0.7.5 command surface (real ~20 agent kinds,
  completion detection via `agent prompt --wait` / `agent wait --until`, the five
  shipped tiers, corrected stale examples).

## [0.2.4] - 2026-08-02

### Added

- **`agentArgs` on `herdr_start_agent` / `herdr_delegate`.** Pass extra flags to
  the spawned agent CLI — most importantly
  `agentArgs: ["-ne","-e","./src/index.ts"]` to launch a `pi` that loads a
  **local extension** instead of the installed copy (the dev / self-host loop, and
  the basis for the v0.2.5 self-driving task pipeline). Threaded through all three
  launch paths:
  - herdr ≥0.7.5 (macOS/Linux): `agent start <name> --kind <kind> --pane <id> --
    <agentArgs>` (herdr's documented native-args form — verified against herdr's
    `agent_start` source + official CLI reference, platform-independent).
  - herdr ≥0.7.5 (Windows): joined into the `pane run` command line (the
    auto-detect launch path, since `agent start --kind` is Windows-broken in the
    0.7.5 preview).
  - legacy `<0.7.5`: appended to the preset argv after `--`.
  Verified end-to-end on Windows: a tool-driven `herdr_start_agent` spawn with
  `agentArgs` loaded the local `./src` (boot showed `[Extensions] src`).
- `tests/smoke.mjs` asserts `agentArgs` is exposed on both tool schemas.

## [0.2.3] - 2026-07-29

### Fixed

- **Windows + herdr 0.7.5-preview: `herdr_start_agent` / `herdr_delegate` now
  spawn.** herdr 0.7.5-preview's `agent start --kind` is broken on Windows: it
  launches the agent via PowerShell `Start-Process -FilePath <kind>`, which can't
  run npm `.cmd` shims (`pi`, `claude`, …) — "%1 is not a valid Win32 application"
  (with no agent args it first surfaces as an empty `-ArgumentList`). On Windows
  the launch now splits a pane, runs the **bare** agent command via `pane run` (the
  pane's shell resolves the `.cmd` shim via PATHEXT), waits for herdr to
  auto-detect the agent, then names it. `agent prompt` / `get` / `read` / `rename`
  / `close` then work on the auto-detected pane as usual.
  - The bare command is used (e.g. `pi`), **not** the `cmd /c` wrapper — the
    wrapper nests a shell and herdr's auto-detection then sees `cmd`, not the
    agent.
  - macOS/Linux keep the working `agent start --kind` path: a
    `process.platform === "win32"` guard sits in front of it; the non-Windows
    code is unchanged.
  - The stale "Windows still ships 0.7.3" assumption in the comments was also
    corrected — Windows now runs the 0.7.5 preview channel.

### Added

- `tests/win-start.mjs` + `npm run test:win` — Windows-only live test that loads
  the edited `src` via jiti and exercises every orchestration tool against a pane
  created by the fixed launch path. Self-skips on non-Windows (safe inside
  `test:live` on macOS).

## [0.2.2] - 2026-07-29

### Fixed

- **herdr 0.7.5: `herdr_start_agent` / `herdr_delegate` now actually spawn.**
  0.2.1's new path splits a pane then calls `agent start`, but herdr returns
  `agent_pane_busy` while the freshly-split shell is still reaching its prompt
  (it fails fast instead of waiting), so spawning always failed on 0.7.5. The
  start now retries `agent start` briefly (≤6s) on `agent_pane_busy`.
- **herdr 0.7.5 error envelopes (emitted on stderr) are now parsed.** herdr 0.7.5
  writes error JSON to stderr (stdout empty, non-zero exit); the helper only
  parsed stdout, so every error collapsed to a generic
  `VALIDATION_ERROR: herdr error: {json}` with no usable code. Errors now map to
  their real code/message (e.g. `agent_pane_busy`, `protocol_mismatch`) — which
  is also what lets the start retry recognize `agent_pane_busy`.
- **herdr 0.7.5: `herdr_send_prompt` / `herdr_delegate` send step.** 0.7.5 removed
  `agent send` (replaced by `agent prompt`, which types + submits in one call). The
  send step now branches by version: 0.7.5 uses `agent prompt` (or `pane send-text`
  for type-only); legacy keeps `agent send` + `pane send-keys Enter`.

## [0.2.1] - 2026-07-29

### Added

- **Self-report `blocked` while a questionnaire awaits input.** Subscribe to
  `rpiv:ask-user:blocked` (`@juicesharp/rpiv-ask-user-question`) and
  `pi-cursor-sdk:ask-question:blocked` (`pi-cursor-sdk`), mapping
  `{ active: true }` → `blocked`, `{ active: false }` → `working` (turn still
  in progress). Requires a pi host that loads this extension plus the matching
  producer package.
- **Proactive herdr detection at session start.** The version probe now runs
  eagerly on `session_start` (`startup`/`reload`) instead of lazily on the first
  agent-start call, so an install/upgrade or a missing herdr is noticed
  immediately. If herdr is absent (or its version can't be parsed) a warning
  toast points to the install instructions (`herdr.dev` / `brew install herdr`);
  the footer always shows the detected version, e.g.
  `herdr: 3 agents (1 working) (0.7.5)`.

### Fixed

- **herdr 0.7.5 compatibility for `herdr_start_agent` / `herdr_delegate` (#2).**
  herdr 0.7.5 redesigned `agent start`: it no longer creates a pane or accepts
  `--cwd/--split/--tab/--workspace/--env/--focus`, and now requires `--kind`/
  `--pane` on an *existing* pane. The old code always passed `--focus`/
  `--no-focus`, so both tools unconditionally failed on 0.7.5 with
  `unknown option: --focus` (exit 2). The extension now detects the herdr version
  once and branches:
  - **legacy (`<0.7.5`)** — incl. the Windows beta — keeps the original
    one-call `agent start` (unchanged).
  - **new (`>=0.7.5`)** — splits a pane (`pane split --current --direction …`),
    then `agent start <name> --kind <preset> --pane <id>`. Custom `argv:` returns
    a clear `VALIDATION_ERROR` (0.7.5 has no raw-argv path).
  Both tools route through one shared, version-branched helper.

## [0.2.0] - 2026-07-13

### Added

- **macOS support (verified).** Launch herdr from your terminal, not `brew services`
  — a launchd-managed herdr server inherits macOS's minimal PATH (no `node`), so
  spawned `pi` agents (a `#!/usr/bin/env node` script) die silently. See README →
  Platform support / Requirements. (`claude`/`codex` are standalone binaries and are
  unaffected.)
- **`env` param on `herdr_delegate`** (parity with `herdr_start_agent`): pass extra
  environment variables (e.g. `PATH`) to the spawned agent — the recovery path on a
  minimal-PATH herdr server.
- **Polling fallback for completion detection.** `herdr_delegate` /
  `herdr_wait_agent` now race herdr's `wait agent-status` event against an
  `agent get` poll, so completion is detected reliably even when `wait agent-status`
  is flaky (e.g. herdr 0.7.3's `failed to decode pane get error`) or a state isn't
  derived (herdr ≥0.7.3 no longer renders `done`). Completion no longer depends on
  the event command firing, nor on timing out the budget.
- `tests/fallback.mjs` (live) validating the fallback; platform-aware test suite via
  a shared `tests/_platform.mjs` helper (no more hardcoded Windows `cmd /c` argv or
  `D:/...` paths).

### Changed

- README: platform badge + Platform support now "macOS & Windows tested"; macOS
  Requirements callout and Platform notes bullet; "How completion is detected"
  updated to describe the polling fallback.

## [0.1.1] - 2026-07-12

### Changed

- Renamed the npm package to the scoped **`@andrewjacop/pi-herdr`** (the
  unscoped `pi-herdr` is retired). Install with
  `pi install npm:@andrewjacop/pi-herdr`.
- README: comprehensive onboarding (what herdr is, install steps for each
  prerequisite, platform-support callout, worked examples) and fixed the license
  badge (now sourced from the GitHub LICENSE instead of the retired npm name).

No functional changes since 0.1.0.

## [0.1.0] - 2026-07-12

### Added

- **Tier 1 orchestration tools** for driving herdr agent panes from the pi LLM:
  `herdr_start_agent`, `herdr_send_prompt`, `herdr_read_agent`, `herdr_wait_agent`,
  `herdr_list_agents`, `herdr_get_agent`, `herdr_stop_agent` (destructive),
  `herdr_rename_agent`, `herdr_focus_agent`, `herdr_explain_agent`.
- **`herdr_delegate`** — composite one-shot: spawn → send → wait → harvest response.
- **Self-report** (`src/selfreport.ts`): a pi running inside a herdr pane pushes its
  real `working`/`idle` state to herdr so `agent_status` is reliable (fixes herdr's
  occasional `working → idle` miss that left finished panes stuck).
- Platform-aware launcher: Windows `cmd /c` wrapper for npm-shim agent CLIs
  (`pi`, `claude`, `codex`, `opencode`); `herdr` spawned directly as a native binary.
- Uniform `Result<T>` envelope and `HerdrErrorCode` set across all tools, with
  timeouts, abort support, and `HERDR_UNAVAILABLE` handling when herdr is missing.
- Configurability via environment: `HERDR_BIN`, `HERDR_PRESET_*`, `PI_HERDR_NO_SELF_REPORT`.
- Test suite: offline smoke (extension load, tools, argv, unavailable, timeout,
  envelope/error parsing), live integration, and parallel multi-agent stress tests
  with on-disk artifact verification.

[0.1.0]: https://github.com/AndrewJacop/pi-herdr/releases/tag/v0.1.0
[0.1.1]: https://github.com/AndrewJacop/pi-herdr/releases/tag/v0.1.1
[0.2.0]: https://github.com/AndrewJacop/pi-herdr/releases/tag/v0.2.0
[0.2.1]: https://github.com/AndrewJacop/pi-herdr/releases/tag/v0.2.1
[0.2.2]: https://github.com/AndrewJacop/pi-herdr/releases/tag/v0.2.2
