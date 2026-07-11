# PRD — `pi-herdr`: herdr integration plugin for the pi coding agent

| | |
|---|---|
| **Status** | Draft / ready for implementation |
| **Date** | 2026-07-11 |
| **Owner** | Andrew |
| **Plugin name (proposed)** | `pi-herdr` (npm package `@andrew/pi-herdr` or `pi-herdr`) |
| **Target host** | pi coding agent (`@earendil-works/pi-coding-agent`) + herdr (`herdr.dev`) |

> **How to use this document:** this PRD is intentionally self-contained. A fresh
> agent session with no prior context should be able to read only this file and
> begin implementing. All external API surfaces (herdr CLI, pi extension API,
> platform quirks) are reproduced or precisely described in the body and appendices.

---

## 1. Overview

`pi-herdr` is a pi coding-agent **extension** that exposes
[herdr](https://herdr.dev) (a terminal workspace manager for AI coding agents) to
the LLM as a set of curated **custom tools**. With it, pi can:

- **Spawn** other AI agents (another `pi`, `claude`, `codex`, …) in real herdr
  panes/tabs/workspaces.
- **Drive** them by sending prompts and commands.
- **Wait** for them to finish using herdr's real agent-state machine
  (`idle`/`working`/`blocked`).
- **Harvest** their responses.
- **Manage** panes/tabs/workspaces, git worktrees, notifications, and workspace
  snapshots.

In short: **turn pi into an orchestrator over a fleet of agent panes running in
herdr.** Each spawned agent runs in its own visible terminal/CLI (not in-process),
so the user can watch, attach, and intervene.

### Relationship to `pi-subagents`

`pi-subagents` runs child agents **in-process** (same Node runtime, shared session
machinery). `pi-herdr` runs agents in **separate herdr panes** — each is an
independent CLI process the user can see and attach to. They are complementary:

- `pi-subagents`: tight, fast, shared-context delegation.
- `pi-herdr`: visible, heterogeneous (mix pi/claude/codex), resumable, panes the
  user can interact with directly.

---

## 2. Background & verified facts

These facts were established empirically during discovery and **must** be treated
as ground truth by the implementer.

### 2.1 herdr is a CLI over a local socket API

Every herdr operation is a subcommand that returns **JSON on stdout** in an
envelope of the form:

```jsonc
// success
{"id":"cli:agent:list","result":{ ... },"type":"agent_list"}
// error
{"error":{"code":"agent_start_failed","message":"..."},"id":"cli:agent:start"}
```

So the extension always shells out to `herdr <subcommand> ...`, parses stdout as
JSON, and re-raises/transforms the envelope. Full subcommand reference is in
**Appendix A**.

### 2.2 herdr auto-detects pi state (no integration needed on Windows)

`herdr agent list` returns a correct `agent_status` (`idle`/`working`/…) for pi
panes **without installing any integration**, because herdr detects pi's TUI.
Therefore `herdr wait agent-status <pane> --status idle` is a reliable completion
detector out of the box.

- `herdr integration install pi` returns **"pi integration is not supported on
  Windows"** → do NOT rely on it. State detection already works without it.
- Caveat: for the first ~1s after an agent pane starts, `agent_status` reads
  `"unknown"` (TUI not yet rendered). Code that waits for `idle` right after
  `start` must tolerate a brief `unknown` window (the `wait agent-status`
  subcommand already does).

### 2.3 Windows launch quirk (CRITICAL)

herdr's `agent start` uses `CreateProcessW` internally, which **cannot execute
npm `.cmd` shims directly**. Launching `pi` (an npm shim) fails with:

```
%1 is not a valid Win32 application. (os error 193)
```

Fix: launch via a `cmd /c` wrapper, i.e. argv `["cmd","/c","pi"]` on Windows.
On macOS/Linux use `["pi"]` directly. **The plugin must own this platform
expansion** (see `AgentPreset` in §6.1) so neither the LLM nor the user ever
deals with it.

> Note: a related but **separate** issue — Git Bash mangles a literal `/c`
> argument into `C:/` (so `cmd /c pi` typed in bash becomes `["cmd","C:/","pi"]`).
> This only affects *typing* the command in a POSIX shell. When the extension
> spawns herdr via Node `child_process`, argv is passed literally and this does
> not occur. The `cmd /c` wrapper is still required regardless (per §2.3).

### 2.4 Invoking herdr itself on Windows

`herdr` is also an npm `.cmd` shim on Windows. The extension must spawn it with
`shell: true` (or resolve `herdr.cmd`) so Node can execute it.

---

## 3. Goals & non-goals

### Goals

- G1. Expose herdr's capabilities to the pi LLM as a coherent, documented set of
  custom tools (full surface, Tiers 1–5).
- G2. Hide all platform quirks (Windows `cmd /c` wrapper, `.cmd` shims) inside the
  plugin.
- G3. Uniform, predictable tool contracts: one `target` model, one result/error
  envelope, consistent parameter naming, validated herdr output.
- G4. Provide at least one **composite** tool (`herdr_delegate`) that performs the
  common spawn→send→wait→read fan-out in a single call.
- G5. Optional: self-report richer pi session/state to herdr via pi lifecycle
  hooks (nice-to-have; state detection already works without it).

### Non-goals (v1)

- N1. Replacing or competing with `pi-subagents`.
- N2. Exposing herdr **admin** operations to the LLM: `integration
  install/uninstall`, `channel`, `server`, `config reset`, `update`. (These stay
  human-only.)
- N3. A GUI. This is a headless tool surface for the LLM (plus optional pi TUI
  status/widget rendering).
- N4. Auto-installing herdr. herdr is a hard prerequisite; the plugin detects it
  and reports `HERDR_UNAVAILABLE` if missing.

---

## 4. Personas & use cases

**Primary persona:** pi (the LLM agent) acting as an orchestrator, plus Andrew
(the user) watching/attaching.

| # | Scenario | Tools used |
|---|---|---|
| U1 | "Implement these 3 tasks in parallel" — spawn 3 pi agents on 3 git worktrees, each gets a task, wait for all, collect diffs | `worktree_create`, `start_agent`, `send_prompt`, `wait_agent`, `read_agent` |
| U2 | "Ask a claude pane to review my change" — find the claude pane, send review prompt, wait, read verdict | `list_agents`, `send_prompt`, `wait_agent`, `read_agent` |
| U3 | "Run the test suite in a side pane and tell me when it prints PASS" | `start_agent`/`split_pane`, `run_command`, `wait_output` |
| U4 | "One-shot delegate this research to a fresh pi and summarize" | `delegate` |
| U5 | "A pane is stuck; interrupt it" | `send_keys` (`Ctrl-C`) |
| U6 | "Show me everything running right now" | `list_agents` / `snapshot` |
| U7 | "Notify me when the long job finishes" | `wait_agent`, `notify` |

---

## 5. Functional requirements — tool surface (full, Tiers 1–5)

The full surface was selected by the user. Tools are grouped into tiers; Tier 1 is
the implementation **must-have** for v1, Tiers 2–5 follow.

### 5.1 Cross-cutting contracts (define once, use everywhere)

```ts
// Flexible addressing — herdr already resolves all three forms.
type Target = string; // paneId "w1:p3" | agent name "pi-research" | label "pi"

type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

// Uniform result envelope — single error strategy across every tool.
type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: HerdrErrorCode; message: string; details?: unknown } };

type HerdrErrorCode =
  | "TIMEOUT"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "AGENT_START_FAILED"
  | "HERDR_UNAVAILABLE"
  | "PANE_GONE";

// Platform-aware agent launcher. The plugin expands presets to OS-correct argv.
type AgentPreset = "pi" | "claude" | "codex" | "omp" | "custom";

type AgentSpec = {
  agent?: AgentPreset;   // default "pi". "custom" requires argv.
  argv?: string[];       // overrides preset expansion when agent="custom"
  cwd?: string;
  name?: string;
};
```

**AgentPreset → argv expansion (owned by the plugin):**

| Preset | Windows (win32) | macOS / Linux |
|---|---|---|
| `pi` | `["cmd","/c","pi"]` | `["pi"]` |
| `claude` | `["cmd","/c","claude"]` | `["claude"]` |
| `codex` | `["cmd","/c","codex"]` | `["codex"]` |
| `omp` | `["cmd","/c","opencode"]` | `["opencode"]` |
| `custom` | caller-supplied `argv` (caller is responsible for any wrapper) | caller-supplied `argv` |

> Make the preset→argv map **configurable** via the extension's settings so new
> agents (e.g. `gemini`, `qoder`) can be added without code changes.

### 5.2 Tier 1 — Orchestration (v1 must-have)

| Tool | herdr command | Input (key params) | Output `data` |
|---|---|---|---|
| `herdr_start_agent` | `agent start` | `AgentSpec & { split?: "right"\|"down", tabId?, workspaceId?, env?: Record<string,string>, focus?: boolean }` | `{ paneId, name, agent, agentStatus, cwd, tabId, workspaceId }` |
| `herdr_send_prompt` | `agent send` + `pane send-keys Enter` | `{ target, text, submit?: boolean = true }` | `{ paneId, submitted: boolean }` |
| `herdr_read_agent` | `agent read` | `{ target, source?: "recent"\|"visible"\|"recent-unwrapped" = "recent", lines?: number = 50, format?: "text"\|"ansi" = "text" }` | `{ paneId, text, truncated: boolean }` |
| `herdr_wait_agent` | `wait agent-status` | `{ target, status: AgentStatus, timeoutMs?: number = 60000 }` | `{ paneId, agentStatus }` (timeout → `TIMEOUT`) |
| `herdr_list_agents` | `agent list` | `{}` | `{ agents: Array<{ paneId, name?, agent, agentStatus, cwd, focused, tabId, workspaceId }> }` |
| `herdr_get_agent` | `agent get` | `{ target }` | single agent object |
| `herdr_stop_agent` ⚠️ | `pane close` | `{ target }` | `{ paneId, stopped: true }` |
| `herdr_rename_agent` | `agent rename` | `{ target, name?: string \| null }` | `{ paneId, name }` |
| `herdr_focus_agent` | `agent focus` | `{ target }` | `{ paneId, focused: true }` |
| `herdr_explain_agent` | `agent explain` | `{ target }` | `{ explanation: string }` |
| **`herdr_delegate`** *(composite)* | start → send_prompt(submit) → wait `working` → wait `idle` → read | `{ AgentSpec, prompt: string, timeoutMs?: number = 120000 }` | `{ paneId, response: string }` |

⚠️ = destructive; tool descriptions must say so and the plugin may gate behind
pi's tool-confirmation if desired.

### 5.3 Tier 2 — Layout & navigation

- Panes: `herdr_split_pane` (`pane split`), `herdr_list_panes` (`pane list`),
  `herdr_get_pane` (`pane get` + `process-info`), `herdr_resize_pane`
  (`pane resize --direction --amount`), `herdr_zoom_pane` (`pane zoom`),
  `herdr_move_pane` (`pane move --tab/--new-tab/--new-workspace`),
  `herdr_swap_panes` (`pane swap`), `herdr_close_pane` ⚠️ (`pane close`).
- Tabs: `herdr_new_tab` / `_list_tabs` / `_focus_tab` / `_rename_tab` / `_close_tab`.
- Workspaces: `herdr_new_workspace` / `_list_workspaces` / `_focus_workspace` /
  `_rename_workspace` / `_close_workspace`.

> Implementation note: this tier is repetitive CRUD. Consider **generating** these
> tool definitions from `herdr api schema` rather than hand-writing each, to stay
> DRY and survive herdr API additions.

### 5.4 Tier 3 — Sync & low-level control

| Tool | herdr command | Input | Notes |
|---|---|---|---|
| `herdr_wait_output` | `wait output --match` | `{ target, match: string, regex?: boolean, source?, lines?, timeoutMs?: number }` | Blocks until text appears — builds/tests/non-agent CLIs. Timeout → `TIMEOUT`. |
| `herdr_send_keys` ⚠️ | `pane send-keys` | `{ target, keys: string[] }` | Normalize friendly names: `"Ctrl-C"`,`"Enter"`,`"Escape"`,`"q"` → herdr key tokens. Interrupt/pager/confirm escape hatch. |
| `herdr_run_command` | `pane run` | `{ target, command: string }` | Shell command + Enter (distinct from agent `send_prompt`). |
| `herdr_notify` | `notification show` | `{ title: string, body?: string, position?: "top-left"\|"top-right"\|"bottom-left"\|"bottom-right", sound?: "none"\|"done"\|"request" }` | User alerts. |

### 5.5 Tier 4 — Git worktrees (parallel-branch workflows)

`herdr_worktree_create` (`worktree create`), `herdr_worktree_open` (`worktree open`),
`herdr_worktree_list` (`worktree list`), `herdr_worktree_remove` ⚠️ (`worktree remove`).
Pair with `herdr_start_agent` to run **one agent per worktree** (use U1).

### 5.6 Tier 5 — Introspection & sessions

- `herdr_snapshot` (`api snapshot`) → whole-workspace JSON.
- Sessions: `herdr_list_sessions` / `herdr_stop_session` / `herdr_delete_session`
  (`session list/stop/delete`). (`session attach` is interactive → exclude.)

---

## 6. Non-functional requirements

- **NFR-1 Platform:** works on Windows (primary — Andrew's env), macOS, Linux.
  All argv/spawn differences centralized in one launcher module.
- **NFR-2 Reliability:** every tool validates herdr's JSON output before returning
  (treat CLI output as **untrusted** data — never pass raw strings straight to the
  LLM without parsing the envelope).
- **NFR-3 Timeouts:** all blocking tools (`wait_*`, `delegate`, any spawn) enforce
  a `timeoutMs` with a sane default and return `TIMEOUT` rather than hanging.
- **NFR-4 Discoverability:** herdr binary resolved at load; if missing, tools
  return `HERDR_UNAVAILABLE` and the extension logs a clear notice.
- **NFR-5 No silent state:** destructive tools (`stop/close/send_keys Ctrl-C/
  worktree remove`) are explicitly labeled in their `description`.
- **NFR-6 Observability:** optional pi footer status (`ctx.ui.setStatus`) showing
  e.g. "herdr: 2 agents (1 working)" while orchestrating.
- **NFR-7 Configurability:** herdr binary path + preset→argv map overridable via
  the extension's settings/config, no code edits needed for common tweaks.

---

## 7. Technical architecture

### 7.1 Extension shape

A pi extension is a TypeScript module exporting a default factory. TypeScript is
loaded via jiti (no build step). See **Appendix B** for the full pi extension
quick reference.

```ts
// src/index.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { herdr, type Result } from "./herdr.js";
import { expandAgentSpec } from "./launcher.js";
import { registerOrchestration } from "./tools/orchestration.js";
import { registerLayout } from "./tools/layout.js";
import { registerSync } from "./tools/sync.js";
import { registerWorktrees } from "./tools/worktrees.js";
import { registerIntrospection } from "./tools/introspection.js";

export default function (pi: ExtensionAPI) {
  // Optional: surface fleet status in the pi footer
  pi.on("agent_start", async (_e, ctx) => {
    const r = await herdr<any>(["agent","list"]);
    if (r.ok) ctx.ui.setStatus("pi-herdr", `${r.data.agents.length} agents`);
  });

  registerOrchestration(pi);
  registerLayout(pi);
  registerSync(pi);
  registerWorktrees(pi);
  registerIntrospection(pi);
}
```

### 7.2 herdr invocation helper (the one spawn module)

```ts
// src/herdr.ts
import { spawn } from "node:child_process";

const IS_WIN = process.platform === "win32";

export interface Ok<T>  { ok: true;  data: T }
export interface Err    { ok: false; error: { code: string; message: string; details?: unknown } }
export type Result<T> = Ok<T> | Err;

// Run `herdr <args>`, parse the JSON envelope, map to Result<T>.
export function herdr<T>(args: string[], opts: { timeoutMs?: number } = {}): Promise<Result<T>> {
  return new Promise((resolve) => {
    const child = spawn("herdr", args, {
      shell: IS_WIN,            // npm .cmd shim on Windows (NFR-1, §2.4)
      windowsHide: true,
    });
    let out = "", err = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, error: { code: "TIMEOUT", message: `herdr ${args.join(" ")} timed out` } });
    }, opts.timeoutMs ?? 60_000);

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, error: { code: "HERDR_UNAVAILABLE", message: "herdr binary not found" } });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let json: any;
      try { json = JSON.parse(out); }
      catch {
        resolve({ ok: false, error: { code: "VALIDATION_ERROR",
          message: `unparseable herdr output`, details: { code, stderr: err, stdout: out } } });
        return;
      }
      if (json.error) {
        resolve({ ok: false, error: { code: String(json.error.code ?? "HERDR_UNAVAILABLE"),
          message: String(json.error.message ?? "herdr error"), details: json.error } });
      } else {
        resolve({ ok: true, data: (json.result ?? json) as T });
      }
    });
  });
}
```

### 7.3 Launcher (platform argv expansion)

```ts
// src/launcher.ts
const IS_WIN = process.platform === "win32";

const PRESETS_WIN: Record<string, string[]> = {
  pi:     ["cmd", "/c", "pi"],
  claude: ["cmd", "/c", "claude"],
  codex:  ["cmd", "/c", "codex"],
  omp:    ["cmd", "/c", "opencode"],
};
const PRESETS_POSIX: Record<string, string[]> = {
  pi: ["pi"], claude: ["claude"], codex: ["codex"], omp: ["opencode"],
};

export function expandAgentSpec(spec: { agent?: string; argv?: string[] }): string[] {
  if (spec.argv?.length) return spec.argv;                 // custom / explicit wins
  const map = IS_WIN ? PRESETS_WIN : PRESETS_POSIX;
  const preset = spec.agent ?? "pi";
  const v = map[preset];
  if (!v) throw new Error(`Unknown agent preset: ${preset}`);
  return v;
}
```

### 7.4 Example tool — `herdr_start_agent` (end-to-end template)

```ts
pi.registerTool({
  name: "herdr_start_agent",
  label: "Start herdr agent",
  description: "Launch a new AI agent (pi/claude/codex/...) in a herdr pane and return its pane id and state. Platform argv handling is automatic.",
  promptSnippet: "Spawn a herdr agent pane",
  promptGuidelines: ["Use herdr_start_agent to run another AI agent in a visible herdr pane; use herdr_delegate for one-shot fan-out."],
  parameters: Type.Object({
    name:        Type.Optional(Type.String()),
    agent:       Type.Optional(Type.Union([Type.Literal("pi"), Type.Literal("claude"),
                                            Type.Literal("codex"), Type.Literal("omp"), Type.Literal("custom")])),
    argv:        Type.Optional(Type.Array(Type.String())),
    cwd:         Type.Optional(Type.String()),
    split:       Type.Optional(Type.Union([Type.Literal("right"), Type.Literal("down")])),
    tabId:       Type.Optional(Type.String()),
    workspaceId: Type.Optional(Type.String()),
    focus:       Type.Optional(Type.Boolean()),
  }),
  async execute(_id, p, _signal, _onUpdate, _ctx) {
    const argv = expandAgentSpec(p);
    const args = ["agent","start", p.name ?? `agent-${Date.now()}`,
                  ...(p.cwd ? ["--cwd", p.cwd] : []),
                  ...(p.split ? ["--split", p.split] : []),
                  ...(p.tabId ? ["--tab", p.tabId] : []),
                  ...(p.workspaceId ? ["--workspace", p.workspaceId] : []),
                  ...(p.focus ? ["--focus"] : ["--no-focus"]),
                  "--", ...argv];
    const r = await herdr<{ agent: any }>(args, { timeoutMs: 15_000 });
    if (!r.ok) return { content: [{ type:"text", text:`Error: ${r.error.message}` }], details: { error: r.error } };
    return { content: [{ type:"text", text: `Started ${p.agent ?? "pi"} in pane ${r.data.agent.pane_id}` }],
             details: r.data.agent };
  },
});
```

### 7.5 Targeting & error mapping

- Every tool that operates on an existing pane takes `target`. Pass it straight to
  herdr (it accepts paneId, name, or label).
- Map herdr error codes to `HerdrErrorCode`:
  `agent_start_failed`→`AGENT_START_FAILED`, pane-missing→`NOT_FOUND`/`PANE_GONE`,
  timeouts from our own timer→`TIMEOUT`, missing binary→`HERDR_UNAVAILABLE`.

### 7.6 Optional: lifecycle self-report (G5)

Pi exposes `session_start`, `agent_start/end`, `agent_settled` hooks (Appendix B).
The plugin *may* call `herdr pane report-agent` / `report-agent-session` to push a
custom status or session path. **Not required** — herdr already auto-detects pi
state (§2.2). Treat as a phase-3 enhancement.

---

## 8. Out of scope / explicitly excluded from the LLM surface

- `integration install/uninstall`, `channel *`, `server *`, `config reset-keys`,
  `update`, `completion` — admin/human-only.
- `agent attach`, `session attach` — interactive; not LLM-callable.
- `pane report-agent / report-agent-session / report-metadata / release-agent` —
  these are for *agents self-reporting*; herdr auto-detects pi, so the LLM does
  not need them.
- `api schema` — internal; used by the plugin at build time if generating Tier 2.

---

## 9. Phasing / milestones

- **M1 — Skeleton + Tier 1 (vertical slice).** Extension loads, `herdr` helper +
  launcher + preset map, tools: `start_agent`, `send_prompt`, `wait_agent`,
  `read_agent`, `list_agents`, `delegate`. Manual test: reproduce the
  "ping → pong" orchestration from Appendix D via tools.
- **M2 — Finish orchestration.** `get_agent`, `stop_agent`, `rename_agent`,
  `focus_agent`, `explain_agent`.
- **M3 — Tier 3 sync.** `wait_output`, `send_keys`, `run_command`, `notify`.
- **M4 — Tier 2 layout** (ideally schema-generated).
- **M5 — Tier 4 worktrees + Tier 5 introspection/sessions.**
- **M6 — Polish:** configurable preset map & binary path, footer status widget,
  docs, `pi install` packaging (`packages.md`).

---

## 10. Success criteria / acceptance

- AC1. `pi -e ./src/index.ts` loads with no errors; all Tier-1 tools appear in pi's
  tool list.
- AC2. From a pi session, the LLM can: start a pi agent in a new pane, send
  "ping", wait for `idle`, and read back "pong" — fully via tools, no shell.
- AC3. `herdr_delegate` returns the spawned agent's response text in one call.
- AC4. On Windows, `herdr_start_agent` with `agent:"pi"` succeeds (no
  "Win32 application" error) thanks to the `cmd /c` wrapper.
- AC5. If herdr is not on PATH, every tool returns `HERDR_UNAVAILABLE` (no crash,
  no hang).
- AC6. Every blocking tool respects `timeoutMs` and returns `TIMEOUT`.
- AC7. Destructive tools are labeled in their descriptions.

---

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| herdr CLI envelope shape changes | Parse defensively; fail closed with `VALIDATION_ERROR` + raw output in `details`. Pin a known-good herdr version in docs. |
| `unknown` state right after spawn | `wait_agent` already tolerates it; `delegate` waits for `working` then `idle`, not `idle`-immediately. |
| Windows `.cmd` spawning hangs | `shell:true` + `windowsHide:true` + always-on timeout. |
| LLM misuse of destructive tools | Clear `description` + ⚠️ flags; optionally gate behind pi tool-confirmation. |
| Long reads blow up context | Default `lines: 50`, always return `truncated`, let the LLM re-read a slice. |
| Generating Tier 2 from schema drifts from real CLI | Cross-check generated tools against `herdr <sub> --help` in CI smoke tests. |

---

## 12. Open questions

- Q1. Package as npm (`pi install npm:pi-herdr`) or keep local (`extensions` array)
  for v1? → recommend local first, publish at M6.
- Q2. Should `herdr_delegate` default to keeping the spawned pane alive (for
  follow-ups) or auto-closing on success? → recommend keep-alive, add
  `closeOnSuccess?: boolean`.
- Q3. Multi-cursor fan-out helper (`delegate_many`) — in scope for v1 or later?
  → recommend later (M5+).
- Q4. Persist a name→paneId map so the LLM can address agents by the name it
  chose across turns? → herdr already resolves names; confirm names survive.

---

## Appendix A — herdr command reference (ground truth)

Top-level: `herdr` (launch/attach), `herdr status`, `herdr update`, `herdr completion <shell>`,
`herdr server stop`, `herdr server reload-config`, `herdr config *`, `herdr channel *`,
`herdr api *`, `herdr workspace *`, `herdr worktree *`, `herdr tab *`, `herdr notification *`,
`herdr agent *`, `herdr pane *`, `herdr wait *`, `herdr session *`, `herdr integration *`.

Config: `%APPDATA%\herdr\config.toml` (Windows) / `~/.config/herdr/config.toml`.

```
# agent
herdr agent list
herdr agent get <target>
herdr agent read <target> [--source visible|recent|recent-unwrapped] [--lines N] [--format text|ansi] [--ansi]
herdr agent send <target> <text>            # literal text, NO Enter
herdr agent rename <target> <name>|--clear
herdr agent focus <target>
herdr agent wait <target> --status <idle|working|blocked|unknown> [--timeout MS]
herdr agent attach <target> [--takeover]     # interactive — EXCLUDE from LLM tools
herdr agent start <name> [--cwd PATH] [--workspace ID] [--tab ID] [--split right|down]
                     [--env KEY=VALUE] [--focus|--no-focus] -- <argv...>
herdr agent explain <target> [--json]
# targets accept terminal ids, unique agent names, detected/reported agent labels, and legacy pane ids
# agent send writes literal text; use pane run when you want command text plus Enter

# pane
herdr pane list [--workspace <workspace_id>]
herdr pane current [--pane ID|--current]
herdr pane get <pane_id>
herdr pane layout [--pane ID|--current]
herdr pane process-info [--pane ID|--current]
herdr pane neighbor --direction left|right|up|down [--pane ID|--current]
herdr pane edges [--pane ID|--current]
herdr pane focus --direction left|right|up|down [--pane ID|--current]
herdr pane resize --direction left|right|up|down [--amount FLOAT] [--pane ID|--current]
herdr pane zoom [<pane_id>|--pane ID|--current] [--toggle|--on|--off]
herdr pane rename <pane_id> <label>|--clear
herdr pane read <pane_id> [--source visible|recent|recent-unwrapped] [--lines N] [--format text|ansi] [--ansi]
herdr pane split [<pane_id>|--pane ID|--current] --direction right|down [--ratio FLOAT] [--cwd PATH] [--env KEY=VALUE] [--focus] [--no-focus]
herdr pane swap --direction left|right|up|down [--pane ID|--current]
herdr pane swap --source-pane ID --target-pane ID
herdr pane move <pane_id> --tab <tab_id> --split right|down [--target-pane ID] [--ratio FLOAT] [--focus|--no-focus]
herdr pane move <pane_id> --new-tab [--workspace ID] [--label TEXT] [--focus|--no-focus]
herdr pane move <pane_id> --new-workspace [--label TEXT] [--tab-label TEXT] [--focus|--no-focus]
herdr pane close <pane_id>
herdr pane send-text <pane_id> <text>
herdr pane send-keys <pane_id> <key> [key ...]
herdr pane report-agent <pane_id> --source ID --agent LABEL --state idle|working|blocked|unknown [--message TEXT] [--custom-status TEXT] [--seq N] [--agent-session-id ID] [--agent-session-path PATH]
herdr pane report-agent-session <pane_id> --source ID --agent LABEL [--seq N] [--agent-session-id ID] [--agent-session-path PATH]
herdr pane release-agent <pane_id> --source ID --agent LABEL [--seq N]
herdr pane report-metadata <pane_id> --source ID [--agent LABEL] [--applies-to-source ID] [--title TEXT|--clear-title] [--display-agent TEXT|--clear-display-agent] [--custom-status TEXT|--clear-custom-status] [--state-label STATUS=TEXT] [--clear-state-labels] [--seq N] [--ttl-ms N]
herdr pane run <pane_id> <command>           # command text + Enter

# wait
herdr wait output <pane_id> --match <text> [--source visible|recent|recent-unwrapped] [--lines N] [--timeout MS] [--regex] [--raw]
herdr wait agent-status <pane_id> --status <idle|working|blocked|done|unknown> [--timeout MS]

# tab
herdr tab list [--workspace <workspace_id>]
herdr tab create [--workspace <workspace_id>] [--cwd PATH] [--label TEXT] [--env KEY=VALUE] [--focus] [--no-focus]
herdr tab get <tab_id>
herdr tab focus <tab_id>
herdr tab rename <tab_id> <label>
herdr tab close <tab_id>

# workspace
herdr workspace list
herdr workspace create [--cwd PATH] [--label TEXT] [--env KEY=VALUE] [--focus] [--no-focus]
herdr workspace get <workspace_id>
herdr workspace focus <workspace_id>
herdr workspace rename <workspace_id> <label>
herdr workspace close <workspace_id>

# worktree
herdr worktree list [--workspace ID | --cwd PATH] [--json]
herdr worktree create [--workspace ID | --cwd PATH] [--branch NAME] [--base REF] [--path PATH] [--label TEXT] [--focus] [--no-focus] [--json]
herdr worktree open [--workspace ID | --cwd PATH] (--path PATH | --branch NAME) [--label TEXT] [--focus] [--no-focus] [--json]
herdr worktree remove --workspace ID [--force] [--json]

# session
herdr session list [--json]
herdr session attach <name>          # interactive — EXCLUDE
herdr session stop <name> [--json]   # use 'default' to target default session
herdr session delete <name> [--json]

# notification
herdr notification show <title> [--body TEXT] [--position top-left|top-right|bottom-left|bottom-right] [--sound none|done|request]

# api / integration (mostly admin; api snapshot is useful)
herdr api snapshot
herdr api schema [--json | --output PATH]
herdr integration status [--outdated-only]
herdr integration install pi   # ❌ "not supported on Windows" — do not rely on
```

**JSON envelopes observed:**

```jsonc
// agent start success
{"id":"cli:agent:start","result":{"agent":{"agent_status":"unknown","cwd":"...","focused":false,"name":"pi-ping","pane_id":"w1:p2","revision":0,"tab_id":"w1:t1","terminal_id":"term_...","workspace_id":"w1"},"argv":["cmd","/c","pi"],"type":"agent_started"}}
// agent list success
{"id":"cli:agent:list","result":{"agents":[{"agent":"pi","agent_status":"working","cwd":"...","focused":true,"name":"...","pane_id":"w1:p1","revision":0,"tab_id":"w1:t1","terminal_id":"...","workspace_id":"w1"}],"type":"agent_list"}}
// wait agent-status event
{"event":"pane.agent_status_changed","data":{"pane_id":"w1:p5","workspace_id":"w1","agent_status":"idle","agent":"pi"}}
// error
{"error":{"code":"agent_start_failed","message":"CreateProcessW ... failed: %1 is not a valid Win32 application. (os error 193)"},"id":"cli:agent:start"}
```

---

## Appendix B — pi extension quick reference (ground truth)

- **Docs:** `docs/extensions.md`, `docs/packages.md` under the pi install, e.g.
  `C:\Users\Andrew\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\docs\`.
- **Shape:** default-export factory `(pi: ExtensionAPI) => void | Promise<void>`.
  TypeScript via jiti — **no build step**.
- **Locations (auto-discovered):**
  - `~/.pi/agent/extensions/*.ts` or `~/.pi/agent/extensions/*/index.ts` (global)
  - `.pi/extensions/*.ts` or `.pi/extensions/*/index.ts` (project, after trust)
  - `settings.json`: `{ "packages": ["npm:...", "git:..."], "extensions": ["/abs/path.ts", "/dir"] }`
- **Run/test during dev:** `pi -e ./src/index.ts` (or `--extension`).
- **Imports available:** `@earendil-works/pi-coding-agent` (types),
  `typebox` (`Type` for schemas), `@earendil-works/pi-ai` (`StringEnum` for
  Google-compatible enums), `@earendil-works/pi-tui` (renderers), node built-ins.
  npm deps work with a `package.json` + `npm install`.
- **Register a tool:**

  ```ts
  pi.registerTool({
    name, label, description,
    promptSnippet?: string,                 // one-line "Available tools" entry
    promptGuidelines?: string[],            // bullets appended to Guidelines (name the tool!)
    parameters: Type.Object({ ... }),       // typebox schema
    prepareArguments?(args),                // optional compat shim before validation
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type:"text", text:"..." }] });   // optional progress
      return { content: [{ type:"text", text:"..." }], details: { ... } };
    },
    renderCall?(args, theme, context),      // optional custom TUI rendering
    renderResult?(result, options, theme, context),
  });
  ```

- **Other registration:** `pi.registerCommand(name, {description, handler})`,
  `pi.registerShortcut(...)`, `pi.registerFlag(...)`, `pi.registerProvider(...)`.
- **Events / lifecycle (subset relevant to this plugin):**
  `session_start`, `agent_start`, `agent_end`, `agent_settled`, `turn_start`,
  `turn_end`, `tool_call` (can `{block:true,reason}`), `tool_result`.
- **Context helpers:** `ctx.ui.notify(msg, "info"|"warn"|"error")`,
  `ctx.ui.confirm(title, msg) → boolean`, `ctx.ui.setStatus(key, text)`,
  `ctx.ui.setWidget(key, lines[])`, `ctx.cwd`, `ctx.signal`.

---

## Appendix D — proven end-to-end flow (the contract the tools must reproduce)

This was executed manually during discovery and is the acceptance behavior for AC2.

```
# 1. start a pi agent pane (Windows: cmd /c wrapper is required)
herdr agent start pi-ping3 -- cmd //c pi
# -> {"pane_id":"w1:p5", "agent_status":"unknown" (briefly), ...}

# 2. wait for it to finish booting
herdr wait agent-status w1:p5 --status idle --timeout 30000
# -> {"event":"pane.agent_status_changed","data":{"agent_status":"idle"}}

# 3. type a prompt and submit it
herdr agent send pi-ping3 "ping"
herdr pane send-keys w1:p5 Enter

# 4. trace the turn via the state machine
herdr wait agent-status w1:p5 --status working --timeout 30000   # idle -> working
herdr wait agent-status w1:p5 --status idle     --timeout 120000 # working -> idle

# 5. fetch the response
herdr agent read pi-ping3 --source recent --lines 40 --format text
# -> "... pong ..."
```

`herdr_delegate` must perform steps 1–5 atomically and return the `response` text.

---

## Appendix E — suggested project layout

```
pi-herdr/
├─ package.json                 # name, deps: typebox (peer), pi host (peer)
├─ tsconfig.json
├─ README.md                    # install + usage (extract from this PRD)
├─ src/
│  ├─ index.ts                  # default factory; registers all tools
│  ├─ herdr.ts                  # spawn + envelope parse + Result<T>  (§7.2)
│  ├─ launcher.ts               # AgentPreset -> argv (platform)      (§7.3)
│  ├─ config.ts                 # binary path + preset map overrides
│  ├─ keys.ts                   # friendly key-name -> herdr token map
│  └─ tools/
│     ├─ orchestration.ts       # Tier 1
│     ├─ layout.ts              # Tier 2 (ideally schema-generated)
│     ├─ sync.ts                # Tier 3
│     ├─ worktrees.ts           # Tier 4
│     └─ introspection.ts       # Tier 5
└─ tests/
   └─ smoke.ts                  # AC1–AC7 (requires herdr installed)
```

**Dev loop:** `pi -e ./src/index.ts` in a project, exercise tools from a pi
session, iterate. No build step needed (jiti).

---

*End of PRD.*
