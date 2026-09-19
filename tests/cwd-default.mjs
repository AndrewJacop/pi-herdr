// Live test: the launch path's cwd default (startHerdrAgent machinery).
// Regression: without --cwd, herdr spawns panes in the DAEMON's cwd (home for a
// restored headless session), not the caller's project. The machinery now
// defaults cwd to process.cwd(). (herdr_start_agent died with the v0.6 surface
// cut; startHerdrAgent is the same code every spawn goes through.)
// Run this from a cwd DIFFERENT from the herdr daemon's cwd, else the two are
// indistinguishable:
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

const NAME = `cwd-fix-${Date.now()}`;
const r = await orch.startHerdrAgent({ name: NAME, agent: "pi" });
const agentObj = r.ok && r.data?.agent ? r.data.agent : {};
const paneId = agentObj.pane_id ?? agentObj.paneId ?? null;
if (!r.ok || !paneId) {
	console.log(
		"✗ startHerdrAgent failed:",
		JSON.stringify(r.ok ? r.data : r.error),
	);
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
