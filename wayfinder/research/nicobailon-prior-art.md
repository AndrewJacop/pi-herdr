# Prior art: nicobailon/pi-subagents (npm `pi-subagents` v0.66.0)

Studied from a fresh clone (commit 56f247a) plus git history for the removed env-var
contract. All paths relative to repo root. Tintinweb's fork is `@tintinweb/pi-subagents`
v0.19.0, cloned separately for §4. Informs tickets 04 (notifications) and 07 (coexistence).

## 1. Herdr integration (docs/extension-api.md:430-495)

Three separate mechanisms, all shell out to the `herdr` CLI via `createHerdrClient`
(src/inspectors/herdr/client.ts:44 — `HERDR_BIN` override, `shell:false`,
`windowsHide:true`, 15s default timeout+abort, typed `{ok,error:{code,...}}` envelope,
"parse last JSON line" stdout recovery):

- **Status bridge** (src/integrations/herdr-status.ts). Activates only when
  `HERDR_ENV=1 && HERDR_PANE_ID` set (L130-131); outside herdr it registers nothing.
  The *root interactive session only* publishes `herdr pane report-metadata <paneId>
  --source pi-subagents:herdr --state-label ... --token summary=/title-suffix=
  --ttl-ms 120000 --seq <monotonic>` (L206-235). Best-effort: enqueue newest snapshot,
  drain serially, errors swallowed (TTL refresh retries). Emits `herdr:busy`
  {active,label} while runs are active and `herdr:blocked` when a child needs
  attention (L250-273); "Pi remains the lifecycle authority". Labels are sanitized,
  bounded (80/42 chars), raw prompts never enter metadata.
- **Inspector panes** (src/inspectors/herdr/actions.ts:168-234). `inspector.open` →
  `herdr pane split --current --direction right --cwd <run cwd>` → `herdr pane run
  <paneId> <node inspector-runner.mjs --async-dir ... --run-id ... --allow-steer/
  --allow-stop --session-roots ...>`; binding JSON (schemaVersion, kind
  "herdr-inspector", paneId, command) persisted at `<asyncDir>/inspectors/herdr[-i].json`.
  Inspector is a raw dashboard pane reading lifecycle artifacts; steer/stop go through
  pi-subagents' own control inbox; "closing the pane never stops the run". Close
  re-verifies the pane id with `herdr pane get` and tolerates NOT_FOUND/PANE_GONE.
- **Project panes** (src/inspectors/herdr/project-panes.ts, 730 lines). `project.open`
  opens a peer Pi pane rooted in another repo (`pane split`+`pane run`), binding stored
  in `<projectRoot>/.pi/subagents/project-panes/herdr.json`. The parent "keeps
  coordination authority but does not own or control subagents inside the peer pane"
  (docs L473). Close fails closed unless the pane is verified + `agent_status: "idle"`.
  Focus: `pane get` → `tab focus`/`workspace focus` (focus.ts:33-46).

## 2. Background-child runner (src/runs/background/)

- **Detached spawn**: parent writes a 0600 JSON config file, then
  `spawn(node, [--import runner-peer-preload.mjs, jiti, subagent-runner.ts, cfgPath],
  {detached: platform!=="win32", windowsHide:true, stdio:[ignore, logFd, logFd]})`
  then `proc.unref()` (async-execution.ts:593-700; background-process-options.ts).
  Child sessions now run **in-process inside the runner** as pi SDK sessions
  (commit d9bc62f8 "run child agents as in-process pi sessions", Sep 2026).
- **Startup safety**: pid + `processTerminal {state:"pending"}` persisted to
  `<asyncDir>/status.json` before proceeding; a startup barrier
  (`runner-startup.json`/`-ack`/`-proceed` handshake + launch barrier token) aborts the
  runner if the parent dies before authorization; `close` handler reconciles terminal
  state and emits nested-run completion (stale-run-reconciler covers crashes).
- **Artifacts**: tmpdir `pi-subagents-<scope>/` with `async-subagent-runs/<runId>/`
  (status.json, control inbox) and `async-subagent-results/<runId>.json` plus index
  dirs by session/run/observer (shared/types.ts:2733-2740; result-files.ts).
- **Result retrieval + notification**: a result-watcher in the parent (fs.watch when
  native, else 3s poll; result-watcher.ts:18-22) reads result files; notify.ts batches
  completions (completion-batcher) and delivers via
  `pi.sendMessage({customType:"subagent-notify",...},{triggerTurn})` (L464-481).
  **The result file is deleted only after sendMessage accepts** — the bus is
  observation, file presence is the durable pending queue. Dedupe by completion key
  with TTL; completion-replay records redeliver notifications missed while no session
  was listening; `bg_wait` tool + agent_end auto-drain (30min cap) close the loop.

## 3. pi-intercom bridge env-var contract (historical; removed Sep 2026)

Introduced 1fd371d2 (May 2026), refined 6c8710e1, **removed** by d9bc62f8 in favor of
in-process `ChildSupervisorMetadata` (runs/shared/child-runtime-config.ts:95-104).

- **Who sets**: the parent/runner, in `buildPiArgs` (src/runs/shared/pi-args.ts @
  1fd371d2:130-141), on every detached child pi process:
  `PI_SUBAGENT_CHILD=1` (sentinel: ambient pi-subagents copies stay inert in children),
  `PI_SUBAGENT_ORCHESTRATOR_TARGET=<supervisor intercom session name>` (e.g.
  `subagent-chat-<sessionId[0:18]>`, intercom-bridge.ts:62-71), `PI_SUBAGENT_RUN_ID=<runId>`,
  `PI_SUBAGENT_CHILD_AGENT=<agent name>`, `PI_SUBAGENT_CHILD_INDEX=<flat index, decimal>`,
  plus `PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR`, `PI_SUBAGENT_ORCHESTRATOR_SESSION_ID`,
  `PI_SUBAGENT_INTERCOM_SESSION_NAME` (child's own intercom name).
- **What the child does**: extension entry sees `PI_SUBAGENT_CHILD=1` and registers
  child-side hooks; `readChildMetadata()` (native-supervisor-channel.ts @ 6c8710e1:108-135)
  reads the vars and **fails closed** — returns undefined unless channel dir, run id,
  agent, orchestrator session id, and a numeric index are all present, leaving the
  channel inactive. It then registers the `contact_supervisor` tool: writes a request
  JSON to `<channelDir>/requests/`, notifies via intercom `ask` to the orchestrator
  target, polls `replies/<requestId>.json` (≤500ms poll, 10min default ask timeout),
  and signs messages with Run/Agent/Child-index/child-target.
- At HEAD the same metadata flows as a typed in-process object; only
  `PI_INTERCOM_SESSION_ID` (set by the separate pi-intercom package) is still read
  from env. Takeaway: the author moved *away* from env-var contracts across process
  boundaries (leak/sanitization tests were needed; see
  test/integration/in-process-child.test.ts:45-70).

## 4. Agent .md frontmatter vs tintinweb's

Both read the same dirs — project `.pi/agents/` and user `~/.pi/agent/agents/`
(nicobailon agents.ts:2220, utils.ts:90-97; tintinweb custom-agents.ts:45-52, which
also reads `.agents/agents/`). Neither has a `kind:` field (herdr's `--kind` is
herdr-native); nicobailon's analogue is `runner: {type: pi|external-cli|external-job,
adapter, command...}` (agents.ts:1844-1900).

- **nicobailon** (camelCase, agent-serializer.ts KNOWN_FIELDS:5-48): requires BOTH
  `name` and `description` or the file is **silently skipped** (agents.ts:1971). ~40
  fields: tools/excludeTools (with `mcp:` direct-tool selectors), model/fallbackModels,
  thinking, systemPromptMode, inherit* flags, output, acceptance, toolBudget,
  permissions, memory, async, interactive, maxSubagentDepth, … Unknown fields are
  preserved on re-serialization.
- **tintinweb** (snake_case, Claude-Code-compatible, custom-agents.ts:107-139):
  `name` optional — falls back to filename; description falls back to name.
  disallowed_tools, max_turns, prompt_mode, persist_session, run_in_background,
  isolated, isolation, allowed_subagents, enabled, color, display_name.
- **Coexistence edges (ticket 07)**: each ignores the other's dialect (tintinweb file
  without `name:`+`description:` is invisible to nicobailon; nicobailon's
  `excludeTools`/`systemPromptMode` are inert under tintinweb, which wants
  `disallowed_tools`/`prompt_mode`). Same-name shadowing rules differ (tintinweb:
  project > workspace > global with override warnings). A shared `.pi/agents/` dir
  works only if every file carries name+description and authors accept cross-dialect
  no-ops.

## 5. Borrow / avoid for pi-herdr v0.5

**Borrow**

- HerdrClient shape: typed ok/error envelope, HERDR_BIN override, timeouts+abort,
  last-JSON-line parsing (client.ts).
- Inspector/project-pane recipe: split → `pane run` → persist a binding JSON
  (schemaVersion+kind+paneId+command) next to run artifacts; verify pane liveness
  before acting; display pane ≠ lifecycle owner ("closing never stops the run").
- Status-bridge discipline: single publisher (root session), best-effort newest-wins
  queue, ttl+seq on report-metadata, sanitized/bounded labels, `herdr:busy`/
  `herdr:blocked` events, no raw prompts in metadata.
- Notification reliability: durable result file deleted only after the parent
  *acknowledges* delivery; dedupe key+TTL; replay records for missed deliveries;
  batching; triggerTurn to wake the parent (ticket 04).
- Fail-closed child-metadata validation (all-or-nothing) and the `PI_SUBAGENT_CHILD=1`
  inert-ambient-copy sentinel, if pi-herdr ever passes config via env.
- Trust checks on cross-process paths: realpath-within-registered-roots, no symlinks
  (actions.ts isTrustedAsyncDir).

**Avoid**

- The detached-runner machinery: startup barriers, revival leases, launch tokens,
  jiti preloads/module aliasing, capacity ownership. Herdr panes give pi-herdr process
  lifecycle, logs, and visibility for free — that is the whole point of v0.5.
- The temp-dir result index fan-out (sessions/runs/observers/tool-calls dirs) and 3s
  polling watcher; keep at most one small envelope file per run on the herdr-native
  channel.
- Env-var contracts for structured child config — upstream abandoned them for
  in-process typed metadata (d9bc62f8); pi-herdr's herdr-native channel should carry
  structured payloads instead.
- Dual-ownership ambiguity: pi-subagents explicitly disclaims control of agents inside
  peer panes; pi-herdr must state who owns a spawned pane's lifecycle (agent vs herdr)
  up front, or it will re-derive this boundary painfully later.
