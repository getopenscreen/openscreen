import type { CursorCaptureMode } from "./recordingSession";

/** Linux's legacy Chromium desktop stream always embeds the OS pointer. A
 * supplementary position sampler cannot turn those pixels into an editable take.
 * Native Linux capture negotiates its own cursor-free mode and must not use this guard.
 */
export function browserCursorCaptureError(
	platform: string,
	mode: CursorCaptureMode,
): string | null {
	return platform === "linux" && mode === "editable-overlay"
		? "Editable cursor is not supported by Linux browser capture because it includes the system cursor. Use native Linux capture, or turn off Editable cursor to deliberately record the system cursor (--cursor system in the CLI)."
		: null;
}
