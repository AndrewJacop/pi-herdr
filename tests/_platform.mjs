// Shared platform-aware argv for the live tests.
// Windows: the agent CLIs are npm `.cmd` shims and need a `cmd /c` wrapper.
// POSIX (macOS/Linux): the bare CLI is on PATH, no wrapper.
// Keeping this in one place is what lets the same test run on both.
import { createJiti } from "jiti";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const isWin = process.platform === "win32";

export const isWindows = isWin;

/** pi launch argv, optionally with extra args (e.g. ["-e", path]). */
export const piArgv = (extra = []) =>
	isWin ? ["cmd", "/c", "pi", ...extra] : ["pi", ...extra];

/**
 * Launch a plain pi (optionally with extra agent args) in a fresh pane via
 * the herdr >= 0.9.0 path — `pane split --current`, then `agent start --kind
 * pi --pane <id>` — the same path the product's spawn engine uses (issue 01:
 * one launch path; the old `agent start --no-focus` flag is gone).
 *
 * cwd is the home dir (the pre-0.9 default): these tests probe the GLOBAL
 * install in isolation, away from any project `.pi` config.
 */
export async function startPlainPi(name, extraArgs = []) {
	const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
	const jiti = createJiti(import.meta.url);
	const { herdr } = await jiti.import(join(ROOT, "src/herdr.ts"), {
		parent: ROOT,
	});
	const split = await herdr(
		["pane", "split", "--current", "--direction", "right", "--cwd", homedir()],
		{ timeoutMs: 20_000 },
	);
	if (!split.ok) return split;
	const paneId = split.data?.pane?.pane_id ?? split.data?.pane_id;
	if (!paneId) {
		return {
			ok: false,
			error: { code: "PANE_GONE", message: "pane split returned no id" },
		};
	}
	const args = ["agent", "start", name, "--kind", "pi", "--pane", paneId];
	// extraArgs are pi's OWN flags (e.g. ["-e", path]) — `agent start --kind pi`
	// resolves the canonical pi CLI itself, so no cmd/c wrapper here.
	if (extraArgs.length) args.push("--", ...extraArgs);
	const started = await herdr(args, { timeoutMs: 20_000 });
	if (!started.ok) return started;
	return { ok: true, paneId, data: started.data };
}
