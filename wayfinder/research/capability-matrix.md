# Capability→Flag Matrix: Launching Agent CLIs as Child Processes

Ticket: `wayfinder/tickets/08-capability-matrix.md`. Gates ticket `01` (`spawn_agent` param
surface) and `02` (default agents). Rule: a spawn param is only honest if the kind can enforce it.

Evidence sources (verified 2025, on this machine unless URL):

- **pi 0.85.1** — `pi --help` (local) + docs at `npm/node_modules/@earendil-works/pi-coding-agent/docs/`
- **claude 2.1.263** — `claude --help` (local) + code.claude.com/docs (cli-reference, model-config, env-vars, settings)
- **codex 0.135.0** — `codex --help`, `codex exec --help` (local) + developers.openai.com/codex/config-reference
- Kinds list (22): `herdr agent` output on this machine; fallback in `src/config.ts:AGENT_KINDS_FALLBACK`

## Matrix

| Capability | pi 0.85.1 | claude 2.1.263 | codex 0.135.0 |
|---|---|---|---|
| **1. Pin model** | `--provider <name>` + `--model <pattern\|ID>`; accepts `provider/id` (no --provider needed), fuzzy patterns & `:thinking` suffix (`sonnet:high`); `--list-models [search]` fuzzy-search. **[pi --help]** | `--model <model>` — alias (`sonnet`,`opus`,`haiku`,`fable`) or full name (`claude-sonnet-5`); overrides `model` setting & `ANTHROPIC_MODEL` env. **[claude --help; docs/en/cli-reference]** | `-m, --model <MODEL>`; also `-c model="o3"` (TOML override). Exact-ID; no alias syntax documented. **[codex --help]** |
| **2. System prompt** | Replace: `--system-prompt <text>`; append: `--append-system-prompt <text>` (repeatable, file contents OK). **[pi --help]** | Replace: `--system-prompt <prompt>`; append: `--append-system-prompt <prompt>`; `-file` variants referenced by `--bare` help text (`--system-prompt[-file]`) but absent from top-level options — verify per version. **[claude --help]** | **No CLI flag.** Config-only: `model_instructions_file` (path) "Replacement for built-in instructions instead of AGENTS.md"; `instructions` reserved. Set via `-c model_instructions_file=...`. **[codex --help; config-reference]** |
| **3. Allow/deny tools** | Allowlist: `--tools,-t <names>`; denylist: `--exclude-tools,-xt <names>`; `--no-tools`; `--no-builtin-tools`. Built-in names listed in help (read, bash, powershell, edit, write, grep, find, ls). **[pi --help]** | `--allowedTools <tools...>` / `--disallowedTools <tools...>` (comma/space; patterns like `Bash(git *)`); `--tools <tools...>` restricts built-in set (`""` = none); `--restricted` removes exec tools; `--permission-mode`. **[claude --help]** | **No general allow/deny CLI flag.** `--search` enables web_search tool; config: `tools.view_image`, `tools.web_search`, `web_search=disabled|live`,`features.shell_tool`, per-MCP`mcp_servers.<id>.enabled_tools/disabled_tools`. **[codex --help; config-reference]** |
| **4. Preload skills/instructions** | `--skill <path>` (repeatable, additive even with `--no-skills`); `--prompt-template <path>`; `--no-skills`; `--no-context-files,-nc` disables AGENTS.md/CLAUDE.md discovery. **[pi --help; docs/skills.md]** | **No `--skill` flag.** Skills load from cwd (`.claude/skills/`) and via `--plugin-dir <path>`; `--disable-slash-commands` = "Disable all skills"; CLAUDE.md auto-discovery (skipped by `--bare`). cwd/plug-in based only. **[claude --help]** | AGENTS.md discovered from cwd (no flag to preload extra file); skills via config `skills.config[].path` + `.enabled`; `-c skills.config=[{path="...",enabled=true}]`. **[codex --help; config-reference]** |
| **5. Disable extensions/MCP** | `--no-extensions,-ne` (explicit `-e` still load). pi has **no built-in MCP** ("intentionally does not include built-in MCP" — docs/usage.md) — MCP arrives via extensions, so `-ne` is the kill switch. `--mcp-config` appears only as an extension-registered flag in this install, not core. **[pi --help; docs/usage.md]** | `--strict-mcp-config` (only `--mcp-config` servers); `--mcp-config <configs...>` to inject; `--safe-mode` (all customizations incl. plugins/MCP off); `--bare` (minimal mode); `--setting-sources`. **[claude --help]** | Config: `mcp_servers.<id>.enabled=false`; `--ignore-user-config` skips config.toml entirely (drops MCP servers); `codex mcp` subcommand manages servers. No single `-ne`-style flag. **[codex --help; config-reference]** |
| **6. Headless / print** | `-p, --print` — prompt as argv positionals, process & exit; `--mode json\|rpc`; print mode merges piped stdin. **[pi --help; docs/usage.md]** | `-p, --print` — prompt as positional arg or stdin; `--output-format text\|json\|stream-json`; `--permission-prompts none` (auto-deny prompts headless); trust dialog skipped in -p. **[claude --help]** | `codex exec [PROMPT]` subcommand (stdin if omitted/`-`); `--json` (JSONL events); `-o,--output-last-message <FILE>`; `--ephemeral`; `--output-schema <FILE>`; pair with `-a never`. **[codex exec --help]** |
| **7. Worktree isolation** | No cwd/branch/worktree flag — cwd = process cwd; sessions keyed by path (`--session-dir`, per-path session files). Branch behavior: UNKNOWN (none). **[pi --help; docs/sessions.md]** | `-w, --worktree [name]` — creates a git worktree for the session; `--tmux` (requires --worktree); `--add-dir`; else cwd = process cwd. **[claude --help]** | `-C, --cd <DIR>` working root; `--add-dir`; `--skip-git-repo-check` (exec; codex otherwise expects a git repo). No worktree/branch creation flag: UNKNOWN. **[codex --help]** |

## Per-cell notes (ambiguities a spawn API must respect)

- **pi model**: pattern is fuzzy/glob (`anthropic/*`, `*sonnet*` used for `--models` cycling); a spawn API pinning an exact model should pass full `provider/id` to avoid fuzzy surprises.
- **claude system-prompt `-file` variants**: referenced only inside `--bare`'s description in 2.1.263; not top-level options. Don't build on them without per-version check.
- **codex rows 2–4 are config-key surface, not flags**: enforcement requires `-c key=value` (value parsed as TOML; quote strings). `--strict-config` errors on unknown keys — useful to fail fast on version drift.
- **claude skills (row 4)**: preloading requires either placing files in cwd (`.claude/skills/`, `CLAUDE.md`) or a `--plugin-dir` bundle — a herdr `--skill`-style param cannot map honestly to claude.
- **pi MCP (row 5)**: since MCP is extension-provided, `--no-extensions` transitively disables MCP; a spawn API "disable MCP" param maps cleanly for pi and claude (`--strict-mcp-config` / `--safe-mode`) but only via config TOML for codex.

## Brief survey: other kinds in `src/launcher.ts` presets

| Kind | Model | Headless | Tools / notes | Source |
|---|---|---|---|---|
| gemini | `--model` (precedence: flag > `GEMINI_MODEL` env > settings.json `model.name`) | One-shot prompt flag: UNKNOWN (not verified); `-y/--yolo` is approval mode, **not** headless (explicitly de-coupled in PR #18976) | `--yolo` auto-accepts tool exec; `-s` sandbox | github.com/google-gemini/gemini-cli docs/cli/model-routing.md, PR #695/#18976 |
| cursor | `--model`, `--list-models` | `-p, --print`; `--output-format text\|json\|stream-json`; `--trust` (headless) | `-f/--force`/`--yolo`; `--sandbox`; `--approve-mcps`; **worktree: `-w,--worktree [name]`, `--worktree-base <branch>`, `--skip-worktree-setup`**; no system-prompt/tool-allowlist flags (UNKNOWN) | cursor.com/docs/cli/reference/parameters |
| opencode | `--model,-m provider/model`; `--agent` | `opencode run [message..]` (non-interactive); `--continue`/`--session`/`--fork` | agent build `--permissions` (alias `--tools`), `--mode` | opencode.ai/docs/cli |
| copilot | Model flag: UNKNOWN (not captured) | Programmatic/headless mode documented; exact flag UNKNOWN | `--allow-tool=TOOL`, `--deny-tool=TOOL` (comma lists, `Kind(argument)` patterns), `--allow-all-tools`, `--allow-all`/`--yolo`, `--allow-url` | docs.github.com/en/copilot/reference/copilot-cli-reference |
| devin, agy, cline, omp, mastracode, kimi, kiro, droid, amp, grok, hermes, kilo, qodercli, qwen, maki | UNKNOWN | UNKNOWN | Not installed locally; no official flag surface captured — defer until a default-agent ticket needs them | — |

(Live `herdr agent` kind list adds `qwen` beyond the 21-entry `AGENT_KINDS_FALLBACK` in `src/config.ts` — keep fallback in sync.)

## Implications for `spawn_agent` (ticket 01)

1. **Portable params** (all three enforce): model pin, append/replace system prompt, headless+prompt-argv, cwd.
2. **Portable-ish**: tool allow/deny — pi/claude have flags; codex needs `-c` TOML (a launcher can synthesize `tools.*`/`web_search=disabled` but not a general allowlist → degrade to deny-known-list or mark unsupported for codex).
3. **Kind-specific**: skills preload (pi only), extension disable (pi/claude; codex=`--ignore-user-config`), MCP disable (claude flags / pi `-ne` / codex config).
4. **Do not promise**: branch/worktree creation (claude & cursor only); codex system-prompt & skills (config-file only, no flag); claude skill preload by path.
