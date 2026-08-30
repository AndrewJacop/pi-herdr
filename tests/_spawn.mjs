// Shared live-test spawn: create a shell pane and start `pi` in it the way the
// extension itself does on herdr 0.7.5+ (see startAgentNew in
// src/tools/orchestration.ts). Windows types the bare command into the pane
// shell (`pane run`) because `agent start --kind` launching breaks both
// `agent prompt` readiness AND self-report env flow there; POSIX uses the
// native `agent start --kind`. Legacy `agent start <name> -- <argv>` was
// removed in herdr 0.7.5+, so tests must not call it.
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url);
const { herdr } = await jiti.import(join(ROOT, "src/herdr.ts"), {
	parent: ROOT,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const close = (paneId) =>
	herdr(["pane", "close", paneId], { timeoutMs: 10_000 }).catch(() => {});

/**
 * Spawn a named pi agent in a fresh right-split pane. Resolves to
 * `{ paneId, close }` once herdr tracks the pane as an agent, or
 * `{ error }` (pane cleaned up) on failure.
 */
export async function spawnPiAgent(name, { agentArgs = [], cwd = ROOT } = {}) {
	const split = await herdr(
		["pane", "split", "--current", "--direction", "right", "--cwd", cwd],
		{ timeoutMs: 20_000 },
	);
	if (!split.ok) return { error: split.error };
	const paneId = split.data?.pane?.pane_id;
	if (!paneId) {
		return {
			error: { code: "PANE_GONE", message: "pane split returned no pane id" },
		};
	}

	let started = false;
	if (process.platform === "win32") {
		const cmd = ["pi", ...agentArgs].join(" ");
		started = (await herdr(["pane", "run", paneId, cmd], { timeoutMs: 15_000 }))
			.ok;
	} else {
		const args = ["agent", "start", name, "--kind", "pi", "--pane", paneId];
		if (agentArgs.length) args.push("--", ...agentArgs);
		started = (await herdr(args, { timeoutMs: 60_000 })).ok;
	}
	if (!started) {
		await close(paneId);
		return {
			error: { code: "AGENT_START_FAILED", message: "pi launch failed" },
		};
	}

	const t0 = Date.now();
	let detected = false;
	while (Date.now() - t0 < 20_000) {
		if ((await herdr(["agent", "get", paneId], { timeoutMs: 8_000 })).ok) {
			detected = true;
			break;
		}
		await sleep(500);
	}
	if (!detected) {
		await close(paneId);
		return {
			error: {
				code: "AGENT_START_FAILED",
				message: "herdr did not detect the agent within 20s",
			},
		};
	}
	// Name it (pane-run launches are unnamed; `agent start` already took <name>).
	await herdr(["agent", "rename", paneId, name], { timeoutMs: 10_000 });
	return { paneId, close: () => close(paneId) };
}

/** Wait until `agent get` reports one of `statuses` (poll, no event wait). */
export async function waitStatus(paneId, statuses, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const r = await herdr(["agent", "get", paneId], { timeoutMs: 8_000 });
		const a = r.ok ? (r.data?.agent ?? r.data) : null;
		if (statuses.includes(a?.agent_status)) return a?.agent_status;
		await sleep(1_500);
	}
	return null;
}

/**
 * Submit a prompt pane-level: `send-text` + settled Enter. This is the
 * extension's AGENT_NOT_READY fallback (paneLevelSubmit) — tests use it
 * directly when they need to drive a spawned pane without exercising the
 * orchestration tools (`agent prompt` is broken on herdr 0.8.2 Windows).
 */
export async function panePrompt(paneId, text) {
	const tx = await herdr(["pane", "send-text", paneId, text], {
		timeoutMs: 15_000,
	});
	if (!tx.ok) return tx;
	await sleep(600);
	return herdr(["pane", "send-keys", paneId, "Enter"], { timeoutMs: 15_000 });
}
