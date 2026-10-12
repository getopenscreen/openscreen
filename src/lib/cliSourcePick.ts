// Which enumerated source `openscreen record` (and the MCP's startRecording) records: the first
// window whose title contains `windowTitle`, ignoring case, or else the display at `displayIndex`.

import type { CliRecordRequest } from "./cliContracts";

/**
 * Chromium's window enumeration lists on-screen windows only, and the HUD's picker reads the
 * same list. WebRTC's Windows list skips minimized and hidden windows; on macOS,
 * ThumbnailCapturerMac asks ScreenCaptureKit for on-screen windows, so a window on another Space
 * or behind a full-screen app is missing too. A window the user can see in the taskbar or the
 * Dock may still be absent here, and the miss says so rather than leaving the caller to guess
 * (#1140).
 */
export const HIDDEN_WINDOWS_NOTE =
	"Windows that are minimized, hidden, on another desktop or Space, or behind a full-screen app are not listed: bring a window on screen to record it.";

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
