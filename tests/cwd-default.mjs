// Live test: herdr_start_agent / pane-split cwd default.
// Regression: without --cwd, herdr spawns panes in the DAEMON's cwd (home for a
// restored headless session), not the caller's project. The extension now
// defaults cwd to process.cwd(). Run this from a cwd DIFFERENT from the herdr
// daemon's cwd, else the two are indistinguishable:
//   cd some-temp-dir && node tests/cwd-default.mjs
// Requires a running herdr session. Closes the pane it creates.

import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url);
const orch = await jiti.import(join(ROOT, "src/tools/orchestration.ts"), {
	parent: ROOT,
});
const { herdr } = await jiti.import(join(ROOT, "src/herdr.ts"), {
	parent: ROOT,
});

const tools = [];
const mockPi = { registerTool: (d) => tools.push(d), on: () => {} };
orch.registerOrchestration(mockPi);
const start = tools.find((t) => t.name === "herdr_start_agent");
if (!start) throw new Error("herdr_start_agent not registered");

const NAME = `cwd-fix-${Date.now()}`;
const r = await start.execute("t", { name: NAME, agent: "pi" }, undefined);
const paneId = r.details?.paneId;
if (r.isError || !paneId) {
	console.log("✗ herdr_start_agent failed:", JSON.stringify(r.details));
	process.exit(1);
}

try {
	const get = await herdr(["pane", "get", paneId], { timeoutMs: 10_000 });
	const cwd = get.ok ? (get.data?.pane?.cwd ?? get.data?.cwd) : undefined;
	const pass = cwd === process.cwd();
	console.log(
		`${pass ? "✓" : "✗"} pane ${paneId} cwd=${cwd} (expected ${process.cwd()})`,
	);
	if (!pass) process.exitCode = 1;
} finally {
	await herdr(["pane", "close", paneId], { timeoutMs: 10_000 });
}
