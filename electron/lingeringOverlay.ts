// The countdown overlay is created on the first take and only hidden between takes, so it is
// ready to paint the next countdown at once. A hidden window still counts for Electron, so
// once the HUD and the editor were gone `window-all-closed` never fired: OpenScreen stayed
// up with no window and only the tray icon left (issue #961). On Wayland the camera preview
// outlives its HUD too, parked while the editor is open (see CameraPreviewController).
// `main.ts` closes these overlays when they are the last windows standing.

/** The slice of `BrowserWindow` this needs, so the rule can be tested without Electron. */
export type LingeringWindow = { isDestroyed(): boolean };

/** True when only `overlays` are still open, so they alone hold the app up. */
export function isOnlyLingeringOverlay(
	open: readonly LingeringWindow[],
	overlays: readonly (LingeringWindow | null)[],
): boolean {
	const alive = open.filter((window) => !window.isDestroyed());
	return alive.length > 0 && alive.every((window) => overlays.includes(window));
}
