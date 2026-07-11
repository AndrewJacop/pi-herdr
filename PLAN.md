# Plan — `pi-herdr` extension (herdr → pi LLM tool surface)

> Source of intent: `pi-herdr-PRD.md`. This plan turns it into an actionable
> implementation. Ground-truth facts below were **re-verified** against the live
> environment on 2026-07-11; deviations from the PRD are flagged with ⚠️.

## Context

`pi-herdr` is a pi coding-agent **extension** that exposes [herdr](https://herdr.dev)
(a terminal workspace manager for AI coding agents) to the LLM as curated custom
tools. With it, pi becomes an orchestrator over a fleet of visible agent panes:
spawn (pi/claude/codex/…) → send prompt → wait for state (`idle`/`working`) →
harvest response → manage panes/tabs/workspaces/worktrees.

It is **complementary** to `pi-subagents` (which runs children in-process). Here
each agent runs in its own real terminal pane the user can watch/attach to.

## Verified ground truth (deviations from PRD flagged ⚠️)

| Fact | Status | Notes |
|---|---|---|
| herdr CLI returns JSON envelope `{id,result,type}` / `{error,id}` on stdout | ✅ confirmed (Appendix A) | parse defensively |
| `herdr integration install pi` unsupported on Windows; state detection works anyway | ✅ confirmed (memory) | do NOT rely on integration |
| `cmd /c` wrapper required for **agent** CLIs (they are npm `.cmd` shims) | ✅ confirmed | `pi.cmd` exists at npm global dir |
| ⚠️ herdr is a **native `.exe`**, not an npm `.cmd` shim | **PRD §2.4 is WRONG** | `C:\Users\Andrew\AppData\Local\Programs\Herdr\bin\herdr.exe`; spawn **directly**, no `shell:true` needed (safer — avoids arg-quoting issues) |
| herdr 0.7.2-preview, pi 0.80.6 installed | ✅ | herdr `status` shows server `not running` until a herdr session launches — agent cmds need a running server (auto-starts) |
| Extension API: `registerTool`, `pi.on`, `ctx.ui.setStatus/notify/confirm`, `Type` (typebox), `StringEnum` (`@earendil-works/pi-ai`) | ✅ confirmed vs `extensions.md` + `dynamic-tools.ts` | TS via jiti, no build step |

## Approach

- **One spawn module** (`herdr.ts`) owns every CLI invocation: spawn the native
  `herdr.exe` directly (`shell:false`), enforce a per-call timeout, parse the JSON
  envelope into a uniform `Result<T>`, map errors to a fixed `HerdrErrorCode` set.
- **One launcher module** (`launcher.ts`) owns `AgentPreset → argv` expansion with
  the Windows `cmd /c` wrapper. Preset map is **configurable** via env overrides.
- **Tiered tool registration**, one file per tier. v1 delivers **Tier 1
  (orchestration) incl. the `herdr_delegate` composite** — the vertical slice that
  proves the whole spawn→send→wait→read loop (acceptance AC2/AC3).
- **herdr availability** resolved at first use; every tool returns
  `HERDR_UNAVAILABLE` (no crash/hang) if the binary is missing.
- **Destructive tools** (`stop/close/send_keys/worktree remove`) get explicit ⚠️
  labels in `description`; optional lightweight `ctx.ui.confirm` gate.

## Project layout (mirrors PRD Appendix E)

```
pi-herdr/
├─ package.json          # typebox + pi host as peerDeps
├─ tsconfig.json
├─ README.md
└─ src/
   ├─ index.ts           # default factory; registers all tier modules + footer status
   ├─ herdr.ts           # spawn native herdr.exe + envelope parse → Result<T>
   ├─ launcher.ts        # AgentPreset → argv (platform), configurable
   ├─ config.ts          # binary path + preset-map overrides (env + PATH)
   ├─ keys.ts            # friendly key-name ("Ctrl-C") → herdr token
   ├─ env.ts             # shared types: Result, HerdrErrorCode, AgentStatus, Target
   └─ tools/
      ├─ orchestration.ts   # Tier 1  (M1+M2)
      ├─ sync.ts            # Tier 3
      ├─ layout.ts          # Tier 2
      ├─ worktrees.ts       # Tier 4
      └─ introspection.ts   # Tier 5
```

## Cross-cutting contracts (src/env.ts)

```ts
type Target = string;            // paneId "w1:p3" | agent name | label
type AgentStatus = "idle"|"working"|"blocked"|"done"|"unknown";
type Result<T> = { ok:true; data:T } | { ok:false; error:{ code:HerdrErrorCode; message:string; details?:unknown } };
type HerdrErrorCode = "TIMEOUT"|"NOT_FOUND"|"VALIDATION_ERROR"|"AGENT_START_FAILED"|"HERDR_UNAVAILABLE"|"PANE_GONE";
type AgentPreset = "pi"|"claude"|"codex"|"omp"|"custom";
```

## Tier 1 tools (v1 deliverable)

| Tool | herdr cmd | Notes |
|---|---|---|
| `herdr_start_agent` | `agent start` | expand preset→argv; build argv with `--`, options flags |
| `herdr_send_prompt` | `agent send` + `pane send-keys Enter` | `submit` default true (send + Enter) |
| `herdr_read_agent` | `agent read` | `source`/`lines`(50)/`format`; return `truncated` |
| `herdr_wait_agent` | `wait agent-status` | tolerate brief `unknown` after spawn; TIMEOUT on expiry |
| `herdr_list_agents` | `agent list` | |
| `herdr_get_agent` | `agent get` | |
| `herdr_stop_agent` ⚠️ | `pane close` | |
| `herdr_rename_agent` | `agent rename` | |
| `herdr_focus_agent` | `agent focus` | |
| `herdr_explain_agent` | `agent explain` | |
| **`herdr_delegate`** | start→send→wait working→wait idle→read | one-shot fan-out; returns `response` |

## Reuse / patterns found

- `pi.registerTool({name,label,description,promptSnippet,promptGuidelines,parameters,execute})` — confirmed shape (`extensions.md` §Custom Tools, `dynamic-tools.ts`).
- `StringEnum([...])` from `@earendil-works/pi-ai` for Google-compatible enum params (preferred over `Type.Union(Type.Literal)` used in PRD).
- `ctx.ui.setStatus("pi-herdr", …)` for footer fleet status (NFR-6).
- `ctx.ui.confirm(title,msg)` for optional destructive-tool gating.
- `ctx.signal` — pass into long `wait_*` calls so Esc cancels.
- Tool state for branching: store pane maps in result `details` (extensions.md §State Management).

## Steps

### Phase 1 — Core infra (v1 spine)

- [x] 1. `package.json` — `name`, `peerDependencies`: `@earendil-works/pi-coding-agent`, `typebox`; `pi.extensions: ["./src/index.ts"]`. `tsconfig.json` (module `nodenext`, strict). `README.md` skeleton.
- [x] 2. `src/env.ts` — shared types: `Target`, `AgentStatus`, `Result<T>`, `HerdrErrorCode`, `AgentPreset`, plus an `unwrap<T>()` helper that turns a `Result<T>` into a tool `execute()` return (`{content, details}` on ok; error text + `{error}` details on fail) so no tool repeats this.
- [x] 3. `src/herdr.ts` — **the one spawn module** (see Design A below).
- [x] 4. `src/launcher.ts` — `expandAgentSpec(spec)` (see Design B below).
- [x] 5. `src/config.ts` — resolve binary + presets (see Design C below).

### Phase 2 — Tier 1 orchestration (v1 deliverable)

- [x] 6. `src/tools/orchestration.ts` — register the 10 atomic tools (`start/send_prompt/read/wait/list/get/stop/rename/focus/explain`), each a thin wrapper: build argv → `herdr()` → `unwrap()`. `herdr_start_agent` is the template (full param schema in Design D).
- [x] 7. `herdr_delegate` composite (see Design E).
- [x] 8. `src/index.ts` — `export default function(pi)` that calls `registerOrchestration(pi)` and wires the footer-status hook (`agent_start`/`turn_end` → `herdr agent list` → `ctx.ui.setStatus`).
- [x] 9. Smoke-test the Appendix D ping→pong flow via tools from a live `pi -e ./src/index.ts` session.

### Follow-on phases (NOT in v1 scope — listed for sequencing only)

- **Tier 3 sync** (`src/keys.ts` + `src/tools/sync.ts`): `wait_output`, `send_keys` ⚠️, `run_command`, `notify`.
- **Tier 2 layout** (`src/tools/layout.ts`): panes/tabs/workspaces CRUD — consider generating from `herdr api schema --json` to stay DRY.
- **Tier 4/5** (`src/tools/worktrees.ts`, `introspection.ts`): worktrees, `api snapshot`, sessions.
- **Polish**: lifecycle self-report to herdr (G5, optional), npm packaging (`pi install`).

## Key implementation design

### Design A — `herdr.ts` (spawn + envelope)

- Resolve binary once via `config.getHerdrBin()` (native `.exe` on Windows → spawn **directly**, `shell:false`; pass-through `argv` literally, no shell quoting pitfalls). On posix use `"herdr"`.
- `herdr<T>(args, {timeoutMs=60_000, signal?}) → Promise<Result<T>>`:
  - `spawn(bin, args, { windowsHide:true, env: process.env })`.
  - Buffer stdout/stderr; `setTimeout` → kill child, resolve `TIMEOUT`.
  - On `child.on('error')` (ENOENT) → `HERDR_UNAVAILABLE`.
  - On close: `JSON.parse(stdout)`; if `json.error` → map code; else `data = json.result ?? json`.
  - Unparseable → `VALIDATION_ERROR` with `{code,stderr,stdout}` in `details` (NFR-2: treat CLI output as untrusted).
  - Honor an `AbortSignal` (tie to `ctx.signal` so Esc cancels long waits).

### Design B — `launcher.ts` (preset → argv)

- `expandAgentSpec({agent?, argv?})`: explicit `argv` wins; else lookup preset in the platform map; unknown preset → throw `VALIDATION_ERROR`. Defaults: win `pi→["cmd","/c","pi"]`, posix `pi→["pi"]`; same shape for `claude`/`codex`/`omp` (`opencode`).

### Design C — `config.ts` (no settings.json API exists)

- Binary: `HERDR_BIN` env var → else PATH lookup (`herdr.exe`/`herdr`).
- Preset overrides: env `HERDR_PRESET_<NAME>` (JSON argv), merged over built-in map; allows adding `gemini`/`qoder` with no code change (PRD §5.1 note). Documented in README.

### Design D — `herdr_start_agent` param schema (template)

- `StringEnum` enums where possible. Params: `name?`, `agent?` (`pi|claude|codex|omp|custom`), `argv?` (`string[]`, required-ish when `custom`), `cwd?`, `split?` (`right|down`), `tabId?`, `workspaceId?`, `focus?` (`boolean`).
- Build: `["agent","start", name ?? "agent-<ts>", ...opts, "--", ...expandAgentSpec(p)]`. Map herdr `agent_start_failed` → `AGENT_START_FAILED`. Return `{paneId,name,agent,agentStatus,cwd,...}` (normalize snake_case → camelCase in `details`).

### Design E — `herdr_delegate` (composite)

- `params: AgentSpec & { prompt: string, timeoutMs?=120_000, closeOnSuccess?:boolean }`.
- Steps (each herdr call is a sub-`Result`; fail-fast on any non-ok):
  1. `agent start` (no focus) → `paneId`.
  2. `wait agent-status --status idle` (small budget) — gate past the post-spawn `unknown` window (PRD §2.2).
  3. `agent send <paneId> <prompt>` + `pane send-keys <paneId> Enter`.
  4. `wait agent-status --status working` then `wait agent-status --status idle` (remaining budget).
  5. `agent read --source recent --lines 50 --format text` → `response`.
  6. If `closeOnSuccess` → `pane close`.
- Overall `timeoutMs` is split across the waits; on overall expiry return the partial `paneId` + `TIMEOUT` so the caller can inspect/retry. Default keep-alive (PRD Q2).

## Verification (acceptance AC1–AC7)

- [x] `pi -e ./src/index.ts` loads with no errors; Tier-1 tools appear in tool list (AC1).
- [x] From a pi session: start pi agent → send "ping" → wait idle → read "pong", all via tools (AC2). Reproduce Appendix D flow.
- [x] `herdr_delegate` returns spawned agent's response in one call (AC3).
- [x] Windows: `herdr_start_agent agent:"pi"` succeeds — no "Win32 application" error (AC4).
- [x] herdr missing from PATH → every tool returns `HERDR_UNAVAILABLE`, no crash/hang (AC5).
- [x] Every blocking tool respects `timeoutMs` → `TIMEOUT` (AC6).
- [x] Destructive tools labeled ⚠️ in `description` (AC7).

**Manual smoke:** launch `herdr` (so server is running), then `pi -e ./src/index.ts` in a test project and exercise the ping→pong loop from a pi session.

## Decisions (resolved)

- **Scope:** v1 = Tier 1 orchestration + `herdr_delegate` (vertical slice). Tiers 2–5 are follow-on, not detailed here.
- **herdr binary:** native `.exe` — spawn **directly** (`shell:false`). **Corrects PRD §2.4** (which wrongly assumed an npm `.cmd` shim). The `cmd /c` wrapper is still required for the **agent** CLIs (§2.3), owned by the launcher.
- **Destructive gating:** descriptive ⚠️ `description` labels for v1 (AC7). Optional `ctx.ui.confirm` gate deferred — easy to add later per tool.
- **Config:** env vars + PATH (no pi settings API). Binary `HERDR_BIN`; presets `HERDR_PRESET_*`.
- **`delegate` lifecycle:** keep spawned pane alive by default (`closeOnSuccess?:boolean`) — PRD Q2.
- **Enum params:** `StringEnum` (`@earendil-works/pi-ai`) instead of `Type.Union(Type.Literal)` for Google-model compatibility.

## Open risks to confirm in build

- `wait agent-status` stdout shape on Windows (single envelope vs trailing event line) — confirm parse with a live `herdr` during Phase 2 smoke test; `herdr.ts` parses the **last** JSON object to be safe.
- Agent names persist across turns for re-addressing (PRD Q4) — verify names survive in `agent list`; if not, return `paneId` prominently from `start`/`delegate`.

## Implementation findings (verified during build — read before Tier 2–5)

- **`wait agent-status` waits for a state *change*, not current state.** Waiting for `idle` when *already* idle times out ("timed out waiting for agent status change"). So `delegate` drives turns with `wait working` then `wait idle` (both transitions), and checks the boot-idle result rather than assuming. `agent get` reads current state if you ever need a snapshot.
- **`agent read` result nests text under a wrapper key** (`result.read.text` / `result.pane_read.text`), not top-level. `extractText()` searches shallowly for `text`/`output`/`content`.
- **`pane send-keys` returns empty stdout/stderr on success** (exit 0). `herdr.ts` treats empty-stdout + exit 0 + no-stderr as silent success `{}`. (Server-down, by contrast, prints a Rust error to stderr → `VALIDATION_ERROR` with that message.)
- **Git Bash mangles `cmd /c` → `cmd C:/`** (PRD §2.3) — confirmed. Any herdr call made *from a POSIX shell* with a literal `/c` is corrupted; Node `spawn(shell:false)` is unaffected (verified: argv arrives as `["cmd","/c","pi"]`). All diagnostics/tests must go through Node, not bash.
- **Spawned pi boot is fast (~2s) via Node**, but a spawned pi **inherits the host's global config** (extensions/skills/model) — with a slow model or near-full context a turn can take minutes. `delegate` retries the send if the turn never starts and always reads on timeout; pass a generous `timeoutMs` for slow agents.
- **herdr is a native `.exe`** at `C:\Users\Andrew\AppData\Local\Programs\Herdr\bin\herdr.exe` (PRD §2.4 wrong) — spawned directly, no shell.

## Status

**v1 (Tier 1) complete — all AC1–AC7 validated.** `npm test` (server-less, 48 checks) + live `tests/{live,pong,delegate}.mjs` (require a running herdr session; `pong`/`delegate` also need a working model/API key for the spawned pi).
