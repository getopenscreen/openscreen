// The countdown overlay is created on the first take and only hidden between takes, so it is
// ready to paint the next countdown at once. A hidden window still counts for Electron, so
// once the HUD and the editor were gone `window-all-closed` never fired: OpenScreen stayed
// up with no window and only the tray icon left (issue #961). `main.ts` closes the overlay
// when it is the last window standing.

/** The slice of `BrowserWindow` this needs, so the rule can be tested without Electron. */
export type LingeringWindow = { isDestroyed(): boolean };

/** True when `overlay` is the only window still open, so it alone holds the app up. */
export function isOnlyLingeringOverlay(
	open: readonly LingeringWindow[],
	overlay: LingeringWindow | null,
): boolean {
	if (!overlay || overlay.isDestroyed()) return false;
	const alive = open.filter((window) => !window.isDestroyed());
	return alive.length === 1 && alive[0] === overlay;
}
