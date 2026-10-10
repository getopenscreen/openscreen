import { isWaylandSession } from "../wayland";

// Issue #462. On X11, one desktopCapturer.getSources call asking for both
// "screen" and "window" runs Chromium's two X11 capturers together, and the
// screen capturer's thumbnail grab then intermittently fails ("Failed to
// initialize pixel buffer"). What that costs depends on the Electron version:
// 41 never settles the call at all, 43 settles after its 3s ready timer with the
// screen silently missing. Measured under Xvfb, 8 runs per cell: the combined
// call failed 3/8 (Electron 43) and 4/8 (Electron 41); asked one type per call,
// 32 runs across both versions and both orders never lost the screen.
//
// So on X11 each type gets its own call, one after the other. Not on Wayland:
// there Electron serves both types from a single PipeWire capturer, and one
// call per type would raise the portal picker twice. Not on Windows or macOS
// either, where nothing points at this and the combined call is what ships.
export function shouldEnumerateSourceTypesSeparately(
	platform: NodeJS.Platform,
	env: Partial<NodeJS.ProcessEnv>,
): boolean {
	// The same test that turns on the PipeWire capturer at startup, whichever Ozone
	// backend the app runs on.
	return platform === "linux" && !isWaylandSession(env);
}

export async function getSourcesByType<T>(
	opts: Electron.SourcesOptions,
	getSources: (opts: Electron.SourcesOptions) => Promise<T[]>,
	separately: boolean,
): Promise<T[]> {
	if (!separately || opts.types.length < 2) return getSources(opts);
	const sources: T[] = [];
	// Sequential on purpose: running them in parallel is the failure.
	for (const type of opts.types) {
		sources.push(...(await getSources({ ...opts, types: [type] })));
	}
	return sources;
}
