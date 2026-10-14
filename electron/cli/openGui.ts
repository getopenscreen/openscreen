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

/** Start the GUI from its bundle as a new instance. A no-op outside a packaged `.app`. */
export function openGuiFromCli(execPath: string = process.execPath): void {
	const bundle = appBundleOf(execPath);
	if (!bundle) return;
	const child = spawn("open", ["-n", bundle], { detached: true, stdio: "ignore" });
	child.on("error", () => {
		// Nothing to report to: stdout and stderr belong to the CLI protocol.
	});
	child.unref();
}
