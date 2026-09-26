// Offline validation for the MANUAL E2E pipeline script (S6b) — the REAL
// runtime, a marker-aware stub host. Proves the user's saved file parses,
// runs to completion, passes fan-out results into the synthesis, and returns
// the assertion object the manual pass judges. Run: node tests/e2e-script-check.mjs
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = process.argv[2] ?? "D:/tmp/e2e/workflow-test-2.js";
const jiti = createJiti(import.meta.url);
const rt = await jiti.import(join(ROOT, "src/workflow/runtime.ts"), { parent: ROOT });

const script = readFileSync(SCRIPT_PATH, "utf8");
const MARKERS = ["risks-done", "ui-done", "settings-done"];

let n = 0;
const labels = [];
const host = {
	async spawnAgent(request) {
		const i = ++n;
		labels.push(request.label ?? "(derived)");
		// researchers echo their marker; the merge sees all three and repeats
		// them; the judge returns schema-valid JSON.
		if (request.label === "merge") {
			return {
				ok: true,
				text: `Recommendation: ship it. " + ${JSON.stringify(MARKERS.join(", "))} — all markers seen.`,
			};
		}
		if (request.label === "judge") {
			return { ok: true, text: '{"score":7,"risk":"prompt-injection via pane content"}' };
		}
		const marker = MARKERS[i - 1] ?? "unknown-done";
		return { ok: true, text: `Note ${i}. ${marker}` };
	},
};

const run = await rt.runWorkflow({ script, host });
console.log("status:", run.status);
if (run.error) console.log("error:", run.error);
console.log("return:", JSON.stringify(run.value));
console.log("agent labels requested:", labels.join(", "));

let pass = 0;
let fail = 0;
const check = (c, m) => {
	pass += c ? 1 : 0;
	fail += c ? 0 : 1;
	console.log(`  ${c ? "✓" : "✗"} ${m}`);
};

check(run.status === "completed", "the script runs to completion (no DSL/shape errors)");
const r = run.value ?? {};
check(r.notesCollected === 3, `notesCollected === 3 (got ${JSON.stringify(r.notesCollected)})`);
check(r.markersOk === true, `markersOk === true (fan-out results reached the synthesis)`);
check(typeof r.spentMidFinite === "boolean", "spentMidFinite present (stub host reports no usage → false is CORRECT offline; the live run proves true)");
check(
	r.verdict !== null && typeof r.verdict === "object" && Number.isFinite(r.verdict.score) && typeof r.verdict.risk === "string",
	`verdict is the parsed structured object (got ${JSON.stringify(r.verdict)})`,
);
check(labels.filter((l) => l === "merge" || l === "judge").length === 2 && labels.length === 5,
	"5 agents requested: 3 researchers + merge + judge");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
