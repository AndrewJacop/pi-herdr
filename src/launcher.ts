// Platform-aware agent launcher: expand an AgentSpec into the OS-correct argv.
// Owns the Windows `cmd /c` wrapper so neither the LLM nor the user deals with it.

import { getPresets } from "./config.js";
import type { Result } from "./env.js";

export interface AgentSpec {
  /** Preset name (default "pi"). "custom" requires an explicit argv. */
  agent?: string;
  /** Explicit argv — overrides preset expansion (required for "custom"). */
  argv?: string[];
}

/**
 * Expand an AgentSpec into a spawn argv.
 * - Explicit `argv` always wins.
 * - Otherwise look up the preset in the platform map (win vs posix).
 * - Unknown preset -> VALIDATION_ERROR Result (never throws).
 */
export function expandAgentSpec(spec: AgentSpec): Result<string[]> {
  if (spec.argv && spec.argv.length > 0) {
    return { ok: true, data: [...spec.argv] };
  }
  const presets = getPresets();
  const preset = spec.agent ?? "pi";
  const v = presets[preset];
  if (!v) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: `Unknown agent preset: "${preset}". Known presets: ${Object.keys(presets).join(", ")}`,
      },
    };
  }
  return { ok: true, data: [...v] };
}
