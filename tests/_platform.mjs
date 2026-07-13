// Shared platform-aware argv for the live tests.
// Windows: the agent CLIs are npm `.cmd` shims and need a `cmd /c` wrapper.
// POSIX (macOS/Linux): the bare CLI is on PATH, no wrapper.
// Keeping this in one place is what lets the same test run on both.
const isWin = process.platform === "win32";

export const isWindows = isWin;

/** pi launch argv, optionally with extra args (e.g. ["-e", path]). */
export const piArgv = (extra = []) =>
	isWin ? ["cmd", "/c", "pi", ...extra] : ["pi", ...extra];
