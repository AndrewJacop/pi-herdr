// The herdr-core (`hc`) backend: runs pi-herdr against the Herdr app instead
// of the herdr TUI server.
//
// The Herdr app keeps every terminal in herdr-core and has no `herdr` server,
// so inside one of its terminals (HC_TERMINAL_ID set, HERDR_PANE_ID not) each
// herdr argv that herdr() receives is translated here into `hc` calls (and
// `herdr-app do pane.split` to place a pane), and the answer is shaped like
// herdr's JSON so every caller keeps parsing it the same way. Agents report
// their status to the core themselves (OSC 7501: pi, Claude Code and Codex
// all do), so there is nothing to self-report.
//
// A "pane id" on this backend is an hc terminal address (`t7`). Agent names
// and kinds live on the terminal as `pi-herdr.name` / `pi-herdr.kind` labels.
//
// Set PI_HERDR_BACKEND=hc or =herdr to override the detection; HC_BIN and
// HERDR_APP_BIN override the binaries.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { HerdrErrorCode, Result } from "./env.js";

/** True when pi-herdr should talk to herdr-core (`hc`) instead of `herdr`. */
export function useHc(env: NodeJS.ProcessEnv = process.env): boolean {
	const b = env.PI_HERDR_BACKEND?.toLowerCase();
	if (b === "hc") return true;
	if (b === "herdr") return false;
	return Boolean(env.HC_TERMINAL_ID) && !env.HERDR_PANE_ID;
}

/** The pane (herdr) or terminal (hc) this pi session runs in, if any. */
export function selfPaneId(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	return env.HERDR_PANE_ID ?? (useHc(env) ? env.HC_TERMINAL_ID : undefined);
}

/** Agent kind → the command that starts it. Unlisted kinds run as named. */
export const HC_AGENT_COMMANDS: Readonly<Record<string, string>> = {
	pi: "pi",
	claude: "claude",
	codex: "codex",
	gemini: "gemini",
	opencode: "opencode",
	cursor: "cursor-agent",
};

// Every terminal pi-herdr starts carries OURS, so `agent list` finds it
// before its agent reports a status.
const OURS = "pi-herdr=1";
const NAME_LABEL = "pi-herdr.name";
const KIND_LABEL = "pi-herdr.kind";

// ---- pure helpers (unit-tested offline) --------------------------------------

/** Split a herdr argv into positionals and flags (`--k v`, repeatable). */
export function parseArgs(
	args: string[],
	bool: readonly string[] = [],
): { pos: string[]; flags: Record<string, string[]>; rest: string[] } {
	const pos: string[] = [];
	const flags: Record<string, string[]> = {};
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--") return { pos, flags, rest: args.slice(i + 1) };
		if (a.startsWith("--")) {
			const k = a.slice(2);
			const v = bool.includes(k) ? "true" : (args[++i] ?? "");
			(flags[k] ??= []).push(v);
		} else pos.push(a);
	}
	return { pos, flags, rest: [] };
}

/** herdr's status word for an hc terminal's 7501 status (`hc get` gives the
 * record, `hc ls` just its word). */
export function agentStatus(status: unknown): string {
	const state =
		status && typeof status === "object"
			? (status as { state?: unknown }).state
			: status;
	if (typeof state !== "string") return "unknown";
	// error ends the turn like idle; the rest are herdr's own words.
	return state === "error" ? "idle" : state;
}

/** The agent kind for an hc terminal: our label, else the app it reports. */
export function agentKind(t: HcTerminal): string | undefined {
	const label = t.labels?.[KIND_LABEL];
	if (label) return label;
	const app = typeof t.status === "object" ? t.status?.app : undefined;
	if (!app) return undefined;
	return app === "claude-code" ? "claude" : app;
}

/** An hc terminal as a herdr agent object (snake_case, like `agent get`). */
export function toHerdrAgent(t: HcTerminal): Record<string, unknown> {
	return {
		pane_id: t.address,
		name: t.labels?.[NAME_LABEL] ?? t.name ?? undefined,
		agent: agentKind(t),
		agent_status: agentStatus(t.status),
		cwd: t.foreground?.cwd ?? t.cwd,
		tab_id: t.labels?.["herdr.tab"],
		workspace_id: t.labels?.["herdr.space"],
	};
}

/** Quote one word for a POSIX shell line (also fine for fish and zsh). */
export function shellQuote(s: string): string {
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The argv a split pane runs: the user's login shell, started in `cwd` with
 * `env` set, so an agent typed into it gets both (like a herdr pane).
 */
export function shellArgv(
	cwd: string,
	env: string[],
	shell = process.env.SHELL || "/bin/sh",
): string[] {
	return [
		"/bin/sh",
		"-c",
		'cd "$1" 2>/dev/null; shift; exec env "$@"',
		"pi-herdr",
		cwd,
		...env,
		shell,
		"-l",
	];
}

/** The shell line that starts agent `kind` with `args`. */
export function agentLine(kind: string, args: string[]): string {
	const cmd = HC_AGENT_COMMANDS[kind] ?? kind;
	return [cmd, ...args].map(shellQuote).join(" ");
}

/** Branch name → folder name, as the Herdr app's worktree dialog does it. */
export function slug(s: string): string {
	return s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** The first line of `text` that matches, or undefined. */
export function matchLine(
	text: string,
	match?: string,
	regex?: string,
): string | undefined {
	const re = regex ? new RegExp(regex) : undefined;
	return text
		.split(/\r?\n/)
		.find((l) => (re ? re.test(l) : match ? l.includes(match) : false));
}

// ---- running hc / herdr-app / git -------------------------------------------

export interface HcTerminal {
	address: string;
	name?: string | null;
	cwd?: string;
	labels?: Record<string, string>;
	status?: { state?: string; app?: string } | string | null;
	foreground?: { cwd?: string } | null;
	state?: string;
}

interface Ran {
	code: number | null;
	stdout: string;
	stderr: string;
}

export interface HcOpts {
	timeoutMs?: number;
	signal?: AbortSignal;
}

/** Runs a program; tests replace it. */
export type Runner = (
	bin: string,
	args: string[],
	opts: HcOpts & { cwd?: string },
) => Promise<Ran>;

const run: Runner = (bin, args, opts) =>
	new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(bin, args, {
				shell: false,
				windowsHide: true,
				cwd: opts.cwd,
				signal: opts.signal,
				timeout: opts.timeoutMs ?? 60_000,
			});
		} catch (e) {
			resolve({ code: null, stdout, stderr: String(e) });
			return;
		}
		child.stdout?.on("data", (d) => (stdout += d));
		child.stderr?.on("data", (d) => (stderr += d));
		child.on("error", (e) => resolve({ code: null, stdout, stderr: String(e) }));
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});

let runner: Runner = run;

/** Swap the program runner (tests only); null restores the real one. */
export function setRunnerForTests(r: Runner | null): void {
	runner = r ?? run;
}

function bin(name: "hc" | "herdr-app"): string {
	const override =
		name === "hc" ? process.env.HC_BIN : process.env.HERDR_APP_BIN;
	if (override) return override;
	// The Herdr app installs both here; its terminals may not have it on PATH.
	const local = join(homedir(), ".local", "bin", name);
	return existsSync(local) ? local : name;
}

function err(
	code: HerdrErrorCode,
	message: string,
	details?: unknown,
): Result<never> {
	return { ok: false, error: { code, message, details } };
}

/** hc's error kind → herdr's error code (what callers look for). */
function codeOf(kind: string): HerdrErrorCode {
	if (kind === "not_found") return "NOT_FOUND";
	if (kind === "unavailable") return "HERDR_UNAVAILABLE";
	return "VALIDATION_ERROR";
}

/** `hc <args> --json`, parsed; hc's error envelope becomes an Err. */
async function hc<T>(args: string[], opts: HcOpts): Promise<Result<T>> {
	// --json goes before `--`, which ends hc's own flags (`run -- argv`).
	const dash = args.indexOf("--");
	const withJson =
		dash < 0
			? [...args, "--json"]
			: [...args.slice(0, dash), "--json", ...args.slice(dash)];
	const r = await runner(bin("hc"), withJson, opts);
	let json: unknown;
	try {
		// Errors come as JSON on stderr.
		json = JSON.parse(r.stdout.trim() || r.stderr);
	} catch {
		if (r.code === null)
			return err("HERDR_UNAVAILABLE", `hc could not run: ${r.stderr.trim()}`);
		return err("VALIDATION_ERROR", `hc ${args[0]}: ${r.stderr.trim() || "no output"}`);
	}
	const e = (json as { error?: { kind?: string; message?: string } }).error;
	if (e) {
		const kind = String(e.kind ?? "");
		return err(codeOf(kind), String(e.message ?? `hc ${args[0]} failed`), {
			code: kind,
			...e,
		});
	}
	return { ok: true, data: json as T };
}

async function herdrApp<T>(
	args: string[],
	opts: HcOpts,
): Promise<Result<T>> {
	const r = await runner(bin("herdr-app"), ["do", ...args], opts);
	try {
		const json = JSON.parse(r.stdout) as { error?: string };
		if (json.error || r.code !== 0)
			return err("VALIDATION_ERROR", `herdr-app: ${json.error ?? r.stderr}`);
		return { ok: true, data: json as T };
	} catch {
		return err("HERDR_UNAVAILABLE", `herdr-app: ${r.stderr.trim() || "no answer"}`);
	}
}

async function git(
	cwd: string,
	args: string[],
	opts: HcOpts,
): Promise<Result<string>> {
	const r = await runner("git", args, { ...opts, cwd });
	if (r.code !== 0)
		return err("VALIDATION_ERROR", `git ${args[0]}: ${r.stderr.trim()}`);
	return { ok: true, data: r.stdout.trim() };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- terminals ----------------------------------------------------------------

/** One terminal by address, name, or `pi-herdr.name` label. */
async function getTerminal(
	target: string,
	opts: HcOpts,
): Promise<Result<HcTerminal>> {
	const r = await hc<HcTerminal>(["get", target], opts);
	if (r.ok || r.error.code !== "NOT_FOUND") return r;
	const byLabel = await hc<{ terminals?: HcTerminal[] }>(
		["ls", "--label", `${NAME_LABEL}=${target}`],
		opts,
	);
	const t = byLabel.ok ? byLabel.data.terminals?.[0] : undefined;
	if (!t) return err("NOT_FOUND", `no agent or pane "${target}"`, { code: "agent_not_found" });
	return { ok: true, data: t };
}

async function listTerminals(
	opts: HcOpts,
	label?: string,
): Promise<Result<HcTerminal[]>> {
	const args = label ? ["ls", "--label", label] : ["ls"];
	const r = await hc<{ terminals?: HcTerminal[] }>(args, opts);
	return r.ok ? { ok: true, data: r.data.terminals ?? [] } : r;
}

/** Agents (terminals reporting a status) and the terminals we started, in
 * full: `hc ls` leaves out labels, so each one is read with `hc get`. */
async function listAgents(opts: HcOpts): Promise<Result<HcTerminal[]>> {
	const [all, ours] = await Promise.all([
		listTerminals(opts),
		listTerminals(opts, OURS),
	]);
	if (!all.ok) return all;
	const mine = new Set(ours.ok ? ours.data.map((t) => t.address) : []);
	const got = await Promise.all(
		all.data
			.filter((t) => t.status || mine.has(t.address))
			.map((t) => hc<HcTerminal>(["get", t.address], opts)),
	);
	// One that ended between the two calls is just left out.
	return { ok: true, data: got.flatMap((r) => (r.ok ? [r.data] : [])) };
}

/** The Herdr app's pane showing terminal `t`, if the app is up and shows it. */
async function appPaneOf(t: string, opts: HcOpts): Promise<string | undefined> {
	const r = await runner(bin("herdr-app"), ["ls"], opts);
	try {
		const ls = JSON.parse(r.stdout) as {
			spaces?: { tabs?: { terminals?: { terminal?: string; pane?: string }[] }[] }[];
		};
		for (const s of ls.spaces ?? [])
			for (const tab of s.tabs ?? [])
				for (const term of tab.terminals ?? [])
					if (term.terminal === t && term.pane) return term.pane;
	} catch {
		/* the app isn't running: no pane */
	}
	return undefined;
}

// ---- the herdr commands ----------------------------------------------------

/**
 * `pane split`: a login shell in `--cwd` with `--env`, next to the target
 * pane in the Herdr app. Without the app (or a pane to split), it runs as a
 * sub-agent terminal the app lists under this one.
 */
async function paneSplit(args: string[], opts: HcOpts): Promise<Result<unknown>> {
	const { pos, flags } = parseArgs(args, ["current", "focus"]);
	const from = pos[0] ?? selfPaneId();
	const cwd = flags.cwd?.[0] ?? process.cwd();
	const argv = shellArgv(cwd, flags.env ?? []);
	const direction = flags.direction?.[0] === "down" ? "down" : "right";
	const pane = from ? await appPaneOf(from, opts) : undefined;
	if (pane) {
		const r = await herdrApp<{ terminal?: string }>(
			["pane.split", "--direction", direction, "--pane", pane, "--argv", JSON.stringify(argv)],
			opts,
		);
		if (r.ok && r.data.terminal) return { ok: true, data: { pane: { pane_id: r.data.terminal } } };
	}
	const r = await hc<HcTerminal>(
		["run", "--bg", "--no-notify", "--cwd", cwd, "--", ...argv],
		opts,
	);
	if (!r.ok) return r;
	return { ok: true, data: { pane: { pane_id: r.data.address } } };
}

/** `agent start <name> --kind k --pane p [-- args]`: type it into the shell. */
async function agentStart(args: string[], opts: HcOpts): Promise<Result<unknown>> {
	const { pos, flags, rest } = parseArgs(args);
	const name = pos[0];
	const kind = (flags.kind?.[0] ?? "pi").toLowerCase();
	const pane = flags.pane?.[0];
	if (!pane) return err("VALIDATION_ERROR", "agent start needs --pane");
	const labels = [OURS, `${KIND_LABEL}=${kind}`];
	if (name) labels.push(`${NAME_LABEL}=${name}`);
	const labeled = await hc(["label", pane, ...labels], opts);
	if (!labeled.ok) return labeled;
	const sent = await hc(["send", pane, agentLine(kind, rest)], opts);
	if (!sent.ok) return err("AGENT_START_FAILED", sent.error.message, sent.error.details);
	return {
		ok: true,
		data: { agent: { pane_id: pane, name, agent: kind, agent_status: "unknown" } },
	};
}

interface SendResult {
	started?: boolean | null;
	wait?: { ended?: boolean; reason?: string } | null;
}

/** `agent prompt <t> <text> [--wait --timeout ms]` → `hc send`. */
async function agentPrompt(args: string[], opts: HcOpts): Promise<Result<unknown>> {
	const { pos, flags } = parseArgs(args, ["wait"]);
	const [target, text] = pos;
	const t = await getTerminal(target, opts);
	if (!t.ok) return t;
	const send = ["send", t.data.address, text ?? ""];
	let runOpts = opts;
	if (flags.wait) {
		const ms = Number(flags.timeout?.[0] ?? 180_000);
		send.push("--wait", "--timeout", String(Math.max(1, Math.ceil(ms / 1000))));
		// hc checks in at its own timeout: don't kill it before that.
		runOpts = { ...opts, timeoutMs: Math.max(opts.timeoutMs ?? 0, ms + 15_000) };
	}
	const r = await hc<SendResult>(send, runOpts);
	if (!r.ok || !flags.wait) return r;
	const w = r.data.wait;
	if (w?.ended) return r;
	// It never started working, or a message to us ended the wait early:
	// herdr calls both a stalled prompt, and the caller drives the turn.
	if (w?.reason === "not_started" || w?.reason === "message")
		return err("VALIDATION_ERROR", "prompt submitted but no turn observed", {
			code: "agent_prompt_stalled",
		});
	return err("TIMEOUT", `agent prompt timed out (${w?.reason ?? "no wait"})`);
}

/** `agent wait <t> --until s... --timeout ms`: poll the status word. */
async function agentWait(args: string[], opts: HcOpts): Promise<Result<unknown>> {
	const { pos, flags } = parseArgs(args);
	const want = new Set(flags.until ?? ["idle"]);
	const deadline = Date.now() + Number(flags.timeout?.[0] ?? 60_000);
	while (true) {
		const t = await getTerminal(pos[0], opts);
		if (!t.ok) return t;
		const st = agentStatus(t.data.status);
		if (want.has(st)) return { ok: true, data: { agent: toHerdrAgent(t.data) } };
		if (Date.now() >= deadline || opts.signal?.aborted)
			return err("TIMEOUT", `timed out waiting for ${[...want].join("/")} (now ${st})`);
		await sleep(400);
	}
}

/** `pane read` / `agent read <t> [--source s] [--lines n]` → `hc read`. */
async function read(args: string[], opts: HcOpts): Promise<Result<unknown>> {
	const { pos, flags } = parseArgs(args);
	const t = await getTerminal(pos[0], opts);
	if (!t.ok) return t;
	const lines = flags.source?.[0] === "visible" ? "0" : (flags.lines?.[0] ?? "50");
	const r = await hc<{ text?: string; complete?: boolean }>(
		["read", t.data.address, "--lines", lines],
		opts,
	);
	if (!r.ok) return r;
	return { ok: true, data: { text: r.data.text ?? "", truncated: r.data.complete === false } };
}

/** `pane wait-output <p> --match|--regex x --timeout ms`: poll the screen. */
async function waitOutput(args: string[], opts: HcOpts): Promise<Result<unknown>> {
	const { pos, flags } = parseArgs(args, ["raw"]);
	const match = flags.match?.[0];
	const regex = flags.regex?.[0];
	const deadline = Date.now() + Number(flags.timeout?.[0] ?? 30_000);
	const readArgs = [pos[0], "--lines", flags.lines?.[0] ?? "200"];
	while (true) {
		const r = await read(readArgs, opts);
		if (!r.ok) return r;
		const text = (r.data as { text: string }).text;
		const line = matchLine(text, match, regex);
		if (line !== undefined) return { ok: true, data: { matched_line: line, read: { text } } };
		if (Date.now() >= deadline || opts.signal?.aborted)
			return err("TIMEOUT", `no output matching ${regex ?? match} in ${pos[0]}`);
		await sleep(500);
	}
}

/** `worktree create [--cwd] [--branch] [--base] [--path]`, with git. */
async function worktreeCreate(args: string[], opts: HcOpts): Promise<Result<unknown>> {
	const { flags } = parseArgs(args, ["focus", "no-focus", "json"]);
	const cwd = flags.cwd?.[0] ?? process.cwd();
	const common = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], opts);
	if (!common.ok) return common;
	const repo = basename(dirname(common.data));
	const branch = flags.branch?.[0] ?? `pi-herdr/${Date.now().toString(36)}`;
	// Where the Herdr app's worktree dialog puts them.
	const path =
		flags.path?.[0] ?? join(homedir(), ".herdr", "worktrees", repo, slug(branch));
	const add = await git(
		cwd,
		["worktree", "add", "-b", branch, path, flags.base?.[0] ?? "HEAD"],
		opts,
	);
	if (!add.ok) return add;
	return { ok: true, data: { worktree: { path, branch, is_linked_worktree: true } } };
}

/** The herdr agent kinds, as `herdr agent` prints them. */
function kinds(): Result<string> {
	return { ok: true, data: `kinds: ${Object.keys(HC_AGENT_COMMANDS).join("|")}` };
}

/**
 * Run one herdr argv against herdr-core. Same contract as herdr(): never
 * throws, herdr-shaped data or a normalized Err.
 */
export async function hcHerdr<T = unknown>(
	args: string[],
	opts: HcOpts = {},
): Promise<Result<T>> {
	const [group, cmd, ...rest] = args;
	const key = cmd === undefined ? group : `${group} ${cmd}`;
	const out = (await (async (): Promise<Result<unknown>> => {
		switch (key) {
			case "--version": {
				const r = await runner(bin("hc"), ["--version"], opts);
				return r.code === 0
					? { ok: true, data: r.stdout.trim() }
					: err("HERDR_UNAVAILABLE", "hc not found (set HC_BIN)");
			}
			case "agent":
				return kinds();
			case "agent list": {
				const r = await listAgents(opts);
				return r.ok ? { ok: true, data: { agents: r.data.map(toHerdrAgent) } } : r;
			}
			case "pane list": {
				const r = await listTerminals(opts);
				if (!r.ok) return r;
				return { ok: true, data: { panes: r.data.map((t) => ({ pane_id: t.address })) } };
			}
			case "agent get": {
				const r = await getTerminal(rest[0], opts);
				return r.ok ? { ok: true, data: { agent: toHerdrAgent(r.data) } } : r;
			}
			case "pane split":
				return paneSplit(rest, opts);
			case "agent start":
				return agentStart(rest, opts);
			case "agent prompt":
				return agentPrompt(rest, opts);
			case "pane run": {
				const t = await getTerminal(rest[0], opts);
				return t.ok ? hc(["send", t.data.address, rest[1] ?? ""], opts) : t;
			}
			case "pane send-keys":
			case "agent send-keys": {
				const t = await getTerminal(rest[0], opts);
				return t.ok ? hc(["keys", t.data.address, ...rest.slice(1)], opts) : t;
			}
			case "pane send-text":
				return err(
					"VALIDATION_ERROR",
					"herdr-core can't type text without pressing Enter; send it with submit",
				);
			case "agent wait":
				return agentWait(rest, opts);
			case "agent read":
			case "pane read":
				return read(rest, opts);
			case "pane wait-output":
				return waitOutput(rest, opts);
			case "pane close": {
				const t = await getTerminal(rest[0], opts);
				return t.ok ? hc(["kill", t.data.address], opts) : t;
			}
			case "pane report-agent":
				// The agent reports to the core itself (OSC 7501).
				return { ok: true, data: {} };
			case "worktree create":
				return worktreeCreate(rest, opts);
			default:
				return err("VALIDATION_ERROR", `herdr ${key} has no herdr-core equivalent`);
		}
	})()) as Result<T>;
	return out;
}
