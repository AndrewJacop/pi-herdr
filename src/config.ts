// Configuration: resolve the herdr binary and the agent preset -> argv map.
// No pi settings.json API exists for extensions, so config is via env + PATH.

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

const IS_WIN = process.platform === "win32";

const DEFAULT_PRESETS_WIN: Record<string, string[]> = {
  pi: ["cmd", "/c", "pi"],
  claude: ["cmd", "/c", "claude"],
  codex: ["cmd", "/c", "codex"],
  omp: ["cmd", "/c", "opencode"],
};

const DEFAULT_PRESETS_POSIX: Record<string, string[]> = {
  pi: ["pi"],
  claude: ["claude"],
  codex: ["codex"],
  omp: ["opencode"],
};

const ENV_PREFIX = "HERDR_PRESET_";

/**
 * Built-in presets merged with HERDR_PRESET_<NAME> overrides.
 * Each override value is a JSON argv array, e.g.
 *   HERDR_PRESET_GEMINI='["cmd","/c","gemini"]'
 * Allows adding new agents with no code change.
 */
export function getPresets(): Record<string, string[]> {
  const base = IS_WIN ? DEFAULT_PRESETS_WIN : DEFAULT_PRESETS_POSIX;
  const merged: Record<string, string[]> = { ...base };
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith(ENV_PREFIX) || !value) continue;
    const name = key.slice(ENV_PREFIX.length).toLowerCase();
    if (!name) continue;
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
        merged[name] = parsed as string[];
      }
    } catch {
      /* ignore malformed overrides */
    }
  }
  return merged;
}

/**
 * Resolve the herdr binary path.
 * 1. HERDR_BIN env override.
 * 2. PATH walk (honoring PATHEXT on Windows) for herdr(.exe/.cmd/...).
 * 3. Fall back to the bare name "herdr" (spawn ENOENT -> HERDR_UNAVAILABLE).
 */
export function resolveHerdrBin(): string {
  const override = process.env.HERDR_BIN;
  if (override) return override;

  const name = "herdr";
  const exts = IS_WIN
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, ext ? name + ext : name);
      try {
        if (existsSync(candidate)) return candidate;
      } catch {
        /* ignore unreadable dirs */
      }
    }
  }
  return name;
}
