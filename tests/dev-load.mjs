// Dev-workflow gate: confirm a pi can load the LOCAL pi-herdr (-e) together with
// the ask-user plugin (-e) WITHOUT conflicting with the globally-installed
// @andrewjacop/pi-herdr. The unlock is `-ne` (skip auto-loads, which include the
// global pi-herdr that collides on tool names) + explicit `-e` for both.
//
// What this checks (deterministic, no LLM driving):
//   1. `pi -ne -e <local pi-herdr> -e <pi-ask-user>` boots and reaches idle.
//   2. Pane output has NO "Failed to load extension" / "conflicts" errors.
//   3. The [Extensions] list shows BOTH the local pi-herdr and pi-ask-user.
//
// The blocked-handling flow itself is covered by tests/blocked.mjs (which runs
// the edited delegate logic via jiti). This test is the dev-load prerequisite:
// "can I even run my local build alongside ask-user?"
//
// Run: node tests/dev-load.mjs   (requires a running herdr session + `pi`)

import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { mkdtempSync, existsSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url);
const { herdr } = await jiti.import(join(ROOT, "src/herdr.ts"), {
	parent: ROOT,
});

// Forward slashes — `pane run` types the line into a shell; backslashes escape
// badly in the typed command line.
const LOCAL_SRC = join(ROOT, "src/index.ts").replace(/\\/g, "/");
const ASK_USER = join(
	homedir(),
	".pi/agent/npm/node_modules/pi-ask-user/index.ts",
).replace(/\\/g, "/");

let pass = 0;
let fail = 0;
const check = (c, m) => {
	pass += c ? 1 : 0;
	fail += c ? 0 : 1;
	console.log((c ? "  ✓ " : "  ✗ ") + m);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractPaneId(d) {
	const o = d && typeof d === "object" ? (d.pane ?? d) : null;
	if (!o) return undefined;
	return o.pane_id ?? o.paneId ?? o.id;
}

async function getStatus(target) {
	const r = await herdr(["agent", "get", target], { timeoutMs: 10_000 });
	if (!r.ok) return null;
	const a = r.data?.agent ?? r.data;
	return a?.agent_status ?? null;
}

try {
	console.log("=== dev-load: pi -ne -e <local pi-herdr> -e <pi-ask-user> ===");
	console.log("    local:", LOCAL_SRC);
	console.log("    ask-user:", ASK_USER);
	check(existsSync(LOCAL_SRC), "local src/index.ts exists");
	check(existsSync(ASK_USER), "pi-ask-user index.ts exists");

	if (!existsSync(LOCAL_SRC) || !existsSync(ASK_USER)) {
		console.error("    aborting: a required entry path is missing");
		process.exit(1);
	}

	const CWD = mkdtempSync(join(homedir(), "AppData/Local/Temp/pi-herdr-dev-"));

	// 1. split a raw pane, then launch the bare `pi` with -ne + two -e flags.
	const splitR = await herdr(
		["pane", "split", "--current", "--direction", "right", "--cwd", CWD],
		{ timeoutMs: 20_000 },
	);
	check(splitR.ok, "pane split ok");
	const paneId = extractPaneId(splitR.data);
	check(!!paneId, `split returned paneId (${paneId})`);
	if (!paneId) process.exit(1);

	const cmdLine = `pi -ne -e ${LOCAL_SRC} -e ${ASK_USER}`;
	const runR = await herdr(["pane", "run", paneId, cmdLine], {
		timeoutMs: 15_000,
	});
	check(runR.ok, `pane run launched: ${cmdLine}`);

	// 2. wait for herdr to detect the agent, then reach idle (boot).
	let detected = false;
	for (let i = 0; i < 40 && !detected; i++) {
		if ((await getStatus(paneId)) !== null) detected = true;
		else await sleep(1500);
	}
	check(detected, "herdr detected the dev-loaded pi agent");

	let settled = false;
	for (let i = 0; i < 60 && detected; i++) {
		const s = await getStatus(paneId);
		if (s === "idle" || s === "done") {
			settled = true;
			break;
		}
		await sleep(1500);
	}
	check(settled, "dev-loaded pi reached idle (booted cleanly)");

	// 3. read the pane and assert NO load conflicts and BOTH extensions present.
	const readR = await herdr(
		[
			"agent",
			"read",
			paneId,
			"--source",
			"recent",
			"--lines",
			"60",
			"--format",
			"text",
		],
		{ timeoutMs: 15_000, textOk: true },
	);
	const text = readR.ok ? String(readR.data?.text ?? readR.data ?? "") : "";
	check(
		!/Failed to load extension/i.test(text),
		"no 'Failed to load extension' errors",
	);
	check(!/conflicts with/i.test(text), "no tool-name conflicts");
	check(/pi-ask-user/i.test(text), "[Extensions] lists pi-ask-user");
	check(
		/(^|\s)src(\s|$)/i.test(text),
		"[Extensions] lists the local pi-herdr (as 'src')",
	);

	if (!settled || /Failed to load extension|conflicts with/i.test(text)) {
		console.log("    --- pane output (for diagnosis) ---");
		console.log(
			text
				.split("\n")
				.slice(0, 30)
				.map((l) => "      " + l)
				.join("\n"),
		);
	}

	await herdr(["pane", "close", paneId], { timeoutMs: 10_000 }).catch(() => {});
} catch (e) {
	console.error("dev-load test threw:", e);
	fail += 1;
}

console.log(
	`\n${fail === 0 ? "✅ ALL PASS" : "❌ SOME FAILED"} (${pass}/${pass + fail})`,
);
process.exit(fail === 0 ? 0 : 1);
