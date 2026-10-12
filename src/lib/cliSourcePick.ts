// Which enumerated source `openscreen record` (and the MCP's startRecording) records: the first
// window whose title contains `windowTitle`, ignoring case, or else the display at `displayIndex`.

import type { CliRecordRequest } from "./cliContracts";

/**
 * Chromium's window enumeration skips minimized and hidden windows (WebRTC's Windows window
 * list does, for one), and the HUD's picker reads the same list. So a window the user can see in
 * the taskbar may still be missing here, and the miss says so rather than leaving the caller to
 * guess (#1140).
 */
export const HIDDEN_WINDOWS_NOTE =
	"Minimized and hidden windows are not listed: restore a window to record it.";

export function pickRecordingSource<T extends { id: string; name: string }>(
	sources: T[],
	request: Pick<CliRecordRequest, "windowTitle" | "displayIndex">,
): T {
	if (request.windowTitle) {
		const needle = request.windowTitle.toLowerCase();
		const windows = sources.filter((source) => source.id.startsWith("window:"));
		const match = windows.find((source) => source.name.toLowerCase().includes(needle));
		if (!match) {
			const listed = windows.map((source) => `  - ${source.name}`).join("\n");
			throw new Error(
				`No window title contains "${request.windowTitle}". ${HIDDEN_WINDOWS_NOTE} Open windows:\n${listed}`,
			);
		}
		return match;
	}

	const screens = sources.filter((source) => source.id.startsWith("screen:"));
	const screen = screens[request.displayIndex];
	if (!screen) {
		throw new Error(
			`Display index ${request.displayIndex} not found (${screens.length} screen(s) available)`,
		);
	}
	return screen;
}
