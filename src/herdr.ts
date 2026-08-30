// The single module that shells out to the herdr CLI.
// Spawns the native herdr binary directly (shell:false), enforces a timeout,
// honors an AbortSignal, parses the JSON envelope into a uniform Result<T>,
// and maps herdr errors to our HerdrErrorCode set.

import { spawn, type ChildProcess } from "node:child_process";
import { resolveHerdrBin } from "./config.js";
import type { HerdrErrorCode, Result } from "./env.js";

export interface HerdrOpts {
	/** Hard timeout for the child process (ms). Default 60s. */
	timeoutMs?: number;
	/** Optional abort signal (e.g. ctx.signal) to cancel the call. */
	signal?: AbortSignal;
	/**
	 * If true and stdout is non-JSON with exit code 0, treat stdout as successful
	 * raw text data (used by `agent read` / `pane read` which may emit plain text).
	 */
	textOk?: boolean;
}

/** Map a raw herdr error code string to our normalized code set. */
function mapCode(rawCode: string): HerdrErrorCode {
	const c = rawCode.toLowerCase();
	if (c === "agent_start_failed") return "AGENT_START_FAILED";
	if (c === "agent_not_ready") return "AGENT_NOT_READY";
	if (c.includes("not_found") || c === "no_such_agent" || c === "no_such_pane")
		return "NOT_FOUND";
	if (c.includes("gone")) return "PANE_GONE";
	if (c.includes("timeout") || c.includes("timed_out")) return "TIMEOUT";
	return "VALIDATION_ERROR";
}

/**
 * Run `herdr <args>`, parse the JSON envelope, and return a Result<T>.
 * Never throws — every failure path resolves to `{ ok:false, error }`.
 */
export function herdr<T = unknown>(
	args: string[],
	opts: HerdrOpts = {},
): Promise<Result<T>> {
	const timeoutMs = opts.timeoutMs ?? 60_000;
	return new Promise<Result<T>>((resolve) => {
		let bin: string;
		try {
			bin = resolveHerdrBin();
		} catch {
			resolve(err("HERDR_UNAVAILABLE", "herdr binary could not be resolved"));
			return;
		}

		let child: ChildProcess;
		try {
			child = spawn(bin, args, {
				shell: false,
				windowsHide: true,
				env: process.env,
			});
		} catch (e) {
			resolve(err("HERDR_UNAVAILABLE", `failed to spawn herdr: ${msg(e)}`));
			return;
		}

		let out = "";
		let stderr = "";
		let settled = false;

		const finish = (r: Result<T>) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
			resolve(r);
		};

		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {
				/* ignore */
			}
			finish(
				err("TIMEOUT", `herdr ${args.join(" ")} timed out after ${timeoutMs}ms`),
			);
		}, timeoutMs);

		const onAbort = () => {
			try {
				child.kill();
			} catch {
				/* ignore */
			}
			finish(err("TIMEOUT", `herdr ${args.join(" ")} aborted`));
		};
		if (opts.signal) {
			if (opts.signal.aborted) onAbort();
			else opts.signal.addEventListener("abort", onAbort, { once: true });
		}

		child.stdout?.on("data", (d) => {
			out += d;
		});
		child.stderr?.on("data", (d) => {
			stderr += d;
		});

		child.on("error", (e) => {
			const code = (e as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				finish(
					err("HERDR_UNAVAILABLE", "herdr binary not found on PATH (set HERDR_BIN)"),
				);
			} else {
				finish(err("HERDR_UNAVAILABLE", `failed to run herdr: ${msg(e)}`));
			}
		});

		child.on("close", (exitCode) => {
			// herdr may emit trailing non-JSON lines; parse the last JSON object.
			let parsed = parseLastJson(out);
			// herdr 0.7.5+ emits error envelopes on stderr (stdout empty, non-zero
			// exit). Parse that so the error code/message map correctly instead of
			// surfacing raw JSON as a generic VALIDATION_ERROR.
			if (parsed === null && exitCode !== 0) {
				const alt = parseLastJson(stderr);
				if (
					alt &&
					typeof alt === "object" &&
					"error" in (alt as Record<string, unknown>)
				) {
					parsed = alt;
				}
			}
			if (parsed === null) {
				// Some commands (e.g. `pane send-keys`) return empty output on success.
				// Empty stdout + exit 0 + no stderr => silent success.
				if (exitCode === 0 && !out.trim() && !stderr.trim()) {
					finish({ ok: true, data: {} as T });
					return;
				}
				if (opts.textOk && exitCode === 0 && out.trim()) {
					// SAFETY: callers pass textOk only when T is string/unknown; the raw
					// stdout text is exactly the payload they expect.
					finish({ ok: true, data: out as unknown as T });
					return;
				}
				// If there's a stderr line, surface it (e.g. herdr server not running)
				// so the caller gets an actionable message instead of "unparseable".
				const firstErr = stderr.split(/\r?\n/).find((l) => l.trim());
				const message = firstErr
					? `herdr error: ${firstErr.trim()}`
					: "herdr returned unparseable output";
				finish(
					err("VALIDATION_ERROR", message, {
						exitCode,
						stderr,
						stdout: out,
					}),
				);
				return;
			}
			const json = parsed as {
				error?: { code?: string; message?: string };
				result?: unknown;
			};
			if (json.error) {
				finish(
					err(
						mapCode(String(json.error.code ?? "")),
						String(json.error.message ?? "herdr error"),
						json.error,
					),
				);
				return;
			}
			finish({ ok: true, data: (json.result ?? json) as T });
		});
	});
}

function err(
	code: HerdrErrorCode,
	message: string,
	details?: unknown,
): Result<never> {
	return { ok: false, error: { code, message, details } };
}

function msg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** Parse the last JSON object in a possibly-mixed stdout buffer. */
function parseLastJson(s: string): unknown | null {
	const text = s.trim();
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		/* fall through to line scan */
	}
	const lines = text.split(/\r?\n/).filter((l) => l.trim());
	for (let i = lines.length - 1; i >= 0; i--) {
		try {
			return JSON.parse(lines[i]);
		} catch {
			/* keep scanning */
		}
	}
	return null;
}
