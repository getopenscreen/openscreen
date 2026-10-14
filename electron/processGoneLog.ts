// One line for each process the app loses, in the Terminal output users paste into bug
// reports. Electron reports these events and prints nothing by default, and the HUD is a
// transparent window: a HUD renderer that dies leaves nothing on screen while the app keeps
// running, which reads exactly like a crash with no crash log (#1021).

/** The window a renderer drew, from its URL's `windowType`: never the URL, which can carry paths. */
export function windowTypeOf(url: string): string {
	try {
		return new URL(url).searchParams.get("windowType") ?? "unknown";
	} catch {
		return "unknown";
	}
}

export function describeRenderProcessGone(
	url: string,
	details: { reason: string; exitCode: number },
): string {
	return (
		`[app] the ${windowTypeOf(url)} window's renderer is gone ` +
		`(${details.reason}, exit code ${details.exitCode})`
	);
}

export function describeChildProcessGone(details: {
	type: string;
	reason: string;
	exitCode: number;
	name?: string;
}): string {
	const name = details.name ? ` "${details.name}"` : "";
	return (
		`[app] the ${details.type}${name} process is gone ` +
		`(${details.reason}, exit code ${details.exitCode})`
	);
}
