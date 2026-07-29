// Cached herdr version probe + per-session refresh.
// `agent start` was redesigned in 0.7.5 (needs --kind/--pane, no focus); the
// Windows beta still ships 0.7.3, so callers branch on the detected version.
//
// The probe runs eagerly at session_start (see index.ts) so a missing herdr or
// a version change is surfaced immediately (toast + footer) rather than only as
// a tool error on the first agent-start.

import { herdr } from "./herdr.js";

export interface HerdrVersion {
	major: number;
	minor: number;
	patch: number;
}

export type HerdrProbe =
	| { state: "ok"; version: HerdrVersion }
	| { state: "missing" } // binary not found / won't run
	| { state: "unknown" }; // ran, but version string unparseable

let cached: Promise<HerdrProbe> | null = null;

/** Parse the first `MAJOR.MINOR.PATCH` out of a `herdr --version` string. */
export function parseVersion(s: string): HerdrVersion | null {
	const m = /(\d+)\.(\d+)\.(\d+)/.exec(s ?? "");
	return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null;
}

/** Format a version as `MAJOR.MINOR.PATCH` (for footer display). */
export function formatVersion(v: HerdrVersion): string {
	return `${v.major}.${v.minor}.${v.patch}`;
}

/**
 * Probe `herdr --version` once and cache it. `--version` is client-local (never
 * touches the server), so this is cheap and safe even with no herdr server.
 */
export function probeHerdr(): Promise<HerdrProbe> {
	if (cached) return cached;
	cached = (async () => {
		const r = await herdr<string>(["--version"], {
			textOk: true,
			timeoutMs: 3_000,
		});
		if (!r.ok) return { state: "missing" }; // HERDR_UNAVAILABLE / spawn fail
		const v = parseVersion(r.data);
		return v ? { state: "ok", version: v } : { state: "unknown" };
	})();
	return cached;
}

/** Drop the cached probe and re-run it (use at session_start to catch updates). */
export function refreshHerdrProbe(): Promise<HerdrProbe> {
	cached = null;
	return probeHerdr();
}

/**
 * Read the detected version (null if missing or unparseable). Triggers a probe
 * on first use if session_start hasn't already warmed the cache.
 */
export async function detectHerdrVersion(): Promise<HerdrVersion | null> {
	const p = await probeHerdr();
	return p.state === "ok" ? p.version : null;
}

/**
 * True when herdr uses the redesigned `agent start` (>= 0.7.5).
 * Unknown version -> false (safe default: keeps the 0.7.3 Windows beta working
 * rather than guessing the new API and breaking the only known-good path).
 */
export function isNewAgentApi(v: HerdrVersion | null): boolean {
	if (!v) return false;
	return v.major > 0 || v.minor > 7 || (v.minor === 7 && v.patch >= 5);
}
