// The herdr version floor — pure classification, no I/O.
//
// pi-herdr requires herdr >= 0.9.0 (the release that fixed Windows
// `agent start --kind`) and refuses to run tools against anything older:
// one `HERDR_TOO_OLD` error naming the upgrade pointer, no degraded paths.
// The probe that feeds this lives in herdr.ts (the exec choke point — the
// floor gate sits inside herdr() itself so no tool can half-work); this
// module holds the parse/compare/error logic so it stays offline-testable
// with no herdr binary at all. The detected version also feeds the footer
// readout (herdr ships fast; knowing the version stays cheap).

import type { Err } from "./env.js";

export interface HerdrVersion {
	major: number;
	minor: number;
	patch: number;
}

export type HerdrProbe =
	| { state: "ok"; version: HerdrVersion }
	| { state: "missing" } // binary not found / won't run
	| { state: "unknown" }; // ran, but version string unparseable

/** The oldest herdr this extension talks to (hard floor). */
export const MIN_HERDR_VERSION: HerdrVersion = { major: 0, minor: 9, patch: 0 };

/** Where the upgrade pointer in every HERDR_TOO_OLD error leads. */
export const HERDR_UPGRADE_POINTER = "https://herdr.dev";

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
 * True when `v` is at least MAJOR.MINOR (patch ignored — the floor gates on
 * feature-level releases like the 0.9.0 Windows `agent start --kind` fix).
 */
export function isAtLeast(
	v: HerdrVersion | null,
	major: number,
	minor: number,
): boolean {
	if (!v) return false;
	return v.major > major || (v.major === major && v.minor >= minor);
}

function tooOld(message: string, details?: unknown): Err {
	return { ok: false, error: { code: "HERDR_TOO_OLD", message, details } };
}

/**
 * The version-floor verdict for a probe result:
 * - `ok` + at or above the floor → null (run normally);
 * - `ok` + below the floor → `HERDR_TOO_OLD` naming the detected version and
 *   the upgrade pointer;
 * - `unknown` → `HERDR_TOO_OLD` (an unverifiable herdr can't prove it meets
 *   the floor — a hard floor refuses rather than guess);
 * - `missing` → null — the binary won't spawn anyway, so the natural
 *   `HERDR_UNAVAILABLE` error stays the single failure (one clean error, not two).
 */
export function floorError(probe: HerdrProbe): Err | null {
	if (probe.state === "missing") return null;
	const need = `pi-herdr requires herdr >= ${formatVersion(MIN_HERDR_VERSION)} — upgrade from ${HERDR_UPGRADE_POINTER}, then restart pi (/reload).`;
	if (probe.state === "unknown") {
		return tooOld(
			`herdr is installed but its version could not be determined, and ${need}`,
			probe,
		);
	}
	if (
		!isAtLeast(probe.version, MIN_HERDR_VERSION.major, MIN_HERDR_VERSION.minor)
	) {
		return tooOld(
			`herdr ${formatVersion(probe.version)} is too old: ${need}`,
			probe,
		);
	}
	return null;
}
