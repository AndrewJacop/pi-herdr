// Configuration: resolve the herdr binary and the agent preset -> argv map.
// No pi settings.json API exists for extensions, so config is via env + PATH.

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { herdr } from "./herdr.js";

const IS_WIN = process.platform === "win32";

const DEFAULT_PRESETS_WIN: Record<string, string[]> = {
	pi: ["cmd", "/c", "pi"],
	claude: ["cmd", "/c", "claude"],
	codex: ["cmd", "/c", "codex"],
	omp: ["cmd", "/c", "opencode"],
};

const DEFAULT_PRESETS_POSIX: Record<string, string[]> = {
	pi: ["pi"],
	claude: ["claude"],
	codex: ["codex"],
	omp: ["opencode"],
};

const ENV_PREFIX = "HERDR_PRESET_";

/**
 * Built-in presets merged with HERDR_PRESET_<NAME> overrides.
 * Each override value is a JSON argv array, e.g.
 *   HERDR_PRESET_GEMINI='["cmd","/c","gemini"]'
 * Allows adding new agents with no code change.
 */
export function getPresets(): Record<string, string[]> {
	const base = IS_WIN ? DEFAULT_PRESETS_WIN : DEFAULT_PRESETS_POSIX;
	const merged: Record<string, string[]> = { ...base };
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith(ENV_PREFIX) || !value) continue;
		const name = key.slice(ENV_PREFIX.length).toLowerCase();
		if (!name) continue;
		try {
			const parsed: unknown = JSON.parse(value);
			if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
				merged[name] = parsed as string[];
			}
		} catch {
			/* ignore malformed overrides */
		}
	}
	return merged;
}

/**
 * Resolve the herdr binary path.
 * 1. HERDR_BIN env override.
 * 2. PATH walk (honoring PATHEXT on Windows) for herdr(.exe/.cmd/...).
 * 3. Fall back to the bare name "herdr" (spawn ENOENT -> HERDR_UNAVAILABLE).
 */
export function resolveHerdrBin(): string {
	const override = process.env.HERDR_BIN;
	if (override) return override;

	const name = "herdr";
	const exts = IS_WIN
		? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
		: [""];
	const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
	for (const dir of dirs) {
		for (const ext of exts) {
			const candidate = join(dir, ext ? name + ext : name);
			try {
				if (existsSync(candidate)) return candidate;
			} catch {
				/* ignore unreadable dirs */
			}
		}
	}
	return name;
}

// ---- agent-kind validation (herdr 0.7.5+ `agent start --kind`) ------------
// `agent: "custom"` + a raw `argv` is rejected on herdr 0.7.5 (no --kind for
// "custom"), and the old hardcoded 4-preset enum couldn't list the ~20 kinds
// 0.7.5 actually supports. We now validate `agent` against the LIVE kind list
// emitted by `herdr agent` (trailing `kinds: a|b|c` line), cached per session
// with a hardcoded fallback when herdr is unavailable / pre-0.7.5.

/**
 * Hardcoded fallback: the agent kinds herdr 0.7.5 knows. Used when the live
 * `herdr agent` kind list can't be fetched (no server, missing binary, or a
 * pre-0.7.5 build whose `agent start` has no --kind). Keep roughly in sync with
 * the live `herdr agent` output; the live list is authoritative when available.
 */
export const AGENT_KINDS_FALLBACK: readonly string[] = [
	"pi",
	"claude",
	"codex",
	"gemini",
	"cursor",
	"devin",
	"agy",
	"cline",
	"omp",
	"mastracode",
	"opencode",
	"copilot",
	"kimi",
	"kiro",
	"droid",
	"amp",
	"grok",
	"hermes",
	"kilo",
	"qodercli",
	"maki",
];

let kindsCache: string[] | null = null;

/**
 * Parse the trailing `kinds: a|b|c` line emitted by `herdr agent` (no
 * subcommand) into a lowercased kind list. Returns null when the line is absent.
 */
export function parseAgentKinds(text: string): string[] | null {
	if (typeof text !== "string") return null;
	const line = text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.reverse()
		.find((l) => l.toLowerCase().startsWith("kinds:"));
	if (!line) return null;
	const kinds = line
		.slice("kinds:".length)
		.split("|")
		.map((k) => k.trim().toLowerCase())
		.filter(Boolean);
	return kinds.length ? kinds : null;
}

/**
 * The valid `agent start --kind` values for this herdr: fetched once per
 * session (cached) and falling back to {@link AGENT_KINDS_FALLBACK} when herdr
 * is unavailable or emits no kinds line. Never throws.
 */
export async function getAgentKinds(): Promise<string[]> {
	if (kindsCache) return kindsCache;
	const r = await herdr<string>(["agent"], {
		textOk: true,
		timeoutMs: 4_000,
	});
	const parsed =
		r.ok && typeof r.data === "string" ? parseAgentKinds(r.data) : null;
	kindsCache = parsed ?? [...AGENT_KINDS_FALLBACK];
	return kindsCache;
}

/** Drop the cached kind list so the next getAgentKinds() re-fetches (tests). */
export function resetAgentKindsCache(): void {
	kindsCache = null;
}
