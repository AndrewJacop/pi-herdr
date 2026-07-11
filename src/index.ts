// pi-herdr extension entry point.
// Registers the herdr tool surface and surfaces fleet status in the pi footer.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerOrchestration } from "./tools/orchestration.js";
import { herdr } from "./herdr.js";

export default function (pi: ExtensionAPI): void {
  registerOrchestration(pi);

  // NFR-6: optional footer status showing the herdr fleet while orchestrating.
  const updateStatus = (setStatus: (key: string, text: string) => void): void => {
    herdr<{ agents?: { agent_status?: string }[] }>(["agent", "list"], { timeoutMs: 5_000 })
      .then((r) => {
        if (!r.ok) {
          setStatus("pi-herdr", "herdr: unavailable");
          return;
        }
        const agents = r.data?.agents ?? [];
        const working = agents.filter((a) => a.agent_status === "working").length;
        const noun = agents.length === 1 ? "agent" : "agents";
        setStatus(
          "pi-herdr",
          `herdr: ${agents.length} ${noun}${working ? ` (${working} working)` : ""}`,
        );
      })
      .catch(() => {
        /* status is best-effort */
      });
  };

  pi.on("agent_start", (_e, ctx) => {
    updateStatus((k, t) => ctx.ui.setStatus(k, t));
  });
  pi.on("turn_end", (_e, ctx) => {
    updateStatus((k, t) => ctx.ui.setStatus(k, t));
  });
}
