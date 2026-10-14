// Opening the app while a CLI run of it is alive, on macOS.
//
// `Openscreen mcp` (and `record`, `export`) run the app's own executable, so LaunchServices
// counts them as a running copy of OpenScreen. Finder, the Dock and `open` then hand a launch
// to that process, a hidden one with no window, instead of starting the GUI: the app looked
// dead for as long as an agent kept its MCP session open (#1214). Each such launch reaches the
// CLI process as `activate`, so it starts the GUI itself, as a new instance. When a GUI is
// already running, that instance loses the single-instance lock and brings it forward through
// `second-instance`.

import { spawn } from "node:child_process";
import path from "node:path";

/** The `.app` bundle an executable at `Contents/MacOS/<name>` belongs to, or null. */
export function appBundleOf(execPath: string): string | null {
	const macosDir = path.posix.dirname(execPath);
	const contentsDir = path.posix.dirname(macosDir);
	const bundle = path.posix.dirname(contentsDir);
	if (
		path.posix.basename(macosDir) !== "MacOS" ||
		path.posix.basename(contentsDir) !== "Contents" ||
		!bundle.endsWith(".app")
	) {
		return null;
	}
	return bundle;
}

/**
 * One launch can arrive as several `activate`s (a double-click, a Dock click while the GUI is
 * still starting). Every extra `open -n` would start an instance only for it to lose the
 * single-instance lock and quit, so the ones this soon after a launch are dropped.
 */
const LAUNCH_GUARD_MS = 2000;
let lastLaunchAt = Number.NEGATIVE_INFINITY;

/**
 * Start the GUI from its bundle as a new instance. A no-op outside a packaged `.app`.
 *
 * `afterLaunch` runs once `open` is done. Launching an app through LaunchServices turns the
 * launching process into a regular one, with its own Dock icon, for as long as it lives
 * (measured on macOS 26.5 with a hidden Electron 41 process, #1233; `open -g` does the same).
 * The CLI process hides its Dock icon again there.
 */
export function openGuiFromCli(
	execPath: string = process.execPath,
	now: number = Date.now(),
	afterLaunch?: () => void,
): void {
	const bundle = appBundleOf(execPath);
	if (!bundle) return;
	if (now - lastLaunchAt < LAUNCH_GUARD_MS) return;
	lastLaunchAt = now;
	const child = spawn("open", ["-n", bundle], { detached: true, stdio: "ignore" });
	child.on("error", () => {
		// Nothing to report to: stdout and stderr belong to the CLI protocol.
	});
	if (afterLaunch) child.on("exit", afterLaunch);
	child.unref();
}
