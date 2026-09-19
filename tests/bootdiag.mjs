// Node-only boot diagnostic (avoids Git Bash /c -> C:/ mangling).
// Spawns pi via the real herdr.ts, polls agent get for status, then sends a
// prompt and watches for working. Prints the ground-truth timeline.

import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { piArgv } from "./_platform.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url);
const herdr = (await jiti.import(join(ROOT, "src/herdr.ts"), { parent: ROOT }))
	.herdr;
const extractText = (
	await jiti.import(join(ROOT, "src/env.ts"), { parent: ROOT })
).extractText;

const statusOf = async (pane) => {
	const r = await herdr(["agent", "get", pane], { timeoutMs: 8_000 });
	if (!r.ok) return `ERR:${r.error.code}`;
	const a = r.data?.agent ?? r.data;
	return a?.agent_status ?? "?";
};

const start = await herdr(
	["agent", "start", "bootdiag", "--no-focus", "--", ...piArgv()],
	{
		timeoutMs: 20_000,
	},
);
const pane = start.data?.agent?.pane_id;
console.log("pane=", pane, "start ok=", start.ok);

const t0 = Date.now();
console.log("--- boot poll (agent get, current status) ---");
let booted = false;
for (let i = 0; i < 45; i++) {
	const s = await statusOf(pane);
	const el = ((Date.now() - t0) / 1000).toFixed(0);
	console.log(`t=${el}s status=${s}`);
	if (s === "idle" && i > 2) {
		booted = true;
		break;
	}
	await new Promise((r) => setTimeout(r, 2_000));
}

console.log("--- visible content after boot ---");
const vis = await herdr(
	[
		"agent",
		"read",
		pane,
		"--source",
		"visible",
		"--lines",
		"12",
		"--format",
		"text",
	],
	{
		timeoutMs: 10_000,
		textOk: true,
	},
);
console.log(extractText(vis.data).split("\n").slice(-12).join("\n"));

if (booted) {
	console.log("--- send + enter, then watch for working ---");
	await herdr(["agent", "prompt", pane, "Reply with exactly one word: pong"], {
		timeoutMs: 15_000,
	});
	for (let i = 0; i < 20; i++) {
		const s = await statusOf(pane);
		console.log(`t=${((Date.now() - t0) / 1000).toFixed(0)}s status=${s}`);
		if (s === "idle" && i > 1) break;
		await new Promise((r) => setTimeout(r, 2_000));
	}
	const rd = await herdr(
		[
			"agent",
			"read",
			pane,
			"--source",
			"recent",
			"--lines",
			"30",
			"--format",
			"text",
		],
		{
			timeoutMs: 10_000,
			textOk: true,
		},
	);
	console.log("--- recent tail ---");
	console.log(extractText(rd.data).split("\n").slice(-15).join("\n"));
}

await herdr(["pane", "close", pane], { timeoutMs: 10_000 });
console.log("cleanup done");
