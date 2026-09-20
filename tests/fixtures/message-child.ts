// message-live child extension: gives a spawned pi child the dev-tree
// `herdr_message_agent` without loading the whole package surface.
//
// Why it exists: a child pi auto-loads the GLOBALLY INSTALLED pi-herdr
// (0.5.x — it has no message tool yet), so the live round-trip test points
// the child at this file with `agent_args: ["-e", <this file>]`. pi's
// extension loader (jiti) resolves the relative import below exactly like it
// resolves the package entry's own ./tools/*.js imports.
//
// Not shipped on any surface — test fixture only.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMessageTool } from "../../src/tools/message.js";

export default function (pi: ExtensionAPI): void {
	registerMessageTool(pi);
}
