// Keeping an always-on-top window always on top on Windows.
//
// `alwaysOnTop: true` sets WS_EX_TOPMOST once, at creation, and nothing in Electron ever
// checks it again. Windows takes it away behind the app's back:
//
// - Electron's default level, "floating", re-inserts the window right under the taskbar
//   (SetWindowPos with Shell_TrayWnd as insert-after) on every activation, so the window
//   inherits whatever band the taskbar is in at that instant.
// - Windows moves owners and owned windows between the topmost and normal bands together,
//   and every Chromium popup of a window (tooltip, menu, bubble) is owned by it: one of
//   them made non-topmost takes the owner down with it (measured with bare Win32 windows).
//
// Measured on the HUD (#1193): WS_EX_TOPMOST gone after its language notice closed and
// after the source picker closed, the bar sunk behind Notepad, and still not topmost once
// Ctrl+Shift+O had brought it back.
//
// So the window gets a level Electron does not tuck under the taskbar ("pop-up-menu" is
// plain WS_EX_TOPMOST on Windows; Chromium collapses every level to that), and the bit is
// put back whenever the window changes state. `isAlwaysOnTop()` reads the live style, so
// the check is free and a window that kept its bit is never re-ordered.

const LEVEL = "pop-up-menu";

/** The slice of `BrowserWindow` this needs, so the rule can be tested without Electron. */
export type TopmostWindow = {
	isDestroyed(): boolean;
	isAlwaysOnTop(): boolean;
	setAlwaysOnTop(flag: boolean, level?: typeof LEVEL): void;
	on(event: "focus" | "blur" | "show" | "restore", listener: () => void): unknown;
};

/** Puts WS_EX_TOPMOST back if Windows took it. A no-op anywhere else. */
export function reassertAlwaysOnTop(
	win: TopmostWindow,
	platform: NodeJS.Platform = process.platform,
): void {
	if (platform !== "win32" || win.isDestroyed() || win.isAlwaysOnTop()) return;
	win.setAlwaysOnTop(true, LEVEL);
}

/** For a window created with `alwaysOnTop: true`. */
export function keepAlwaysOnTop(
	win: TopmostWindow,
	platform: NodeJS.Platform = process.platform,
): void {
	if (platform !== "win32") return;
	win.setAlwaysOnTop(true, LEVEL);
	const reassert = () => reassertAlwaysOnTop(win, platform);
	for (const event of ["focus", "blur", "show", "restore"] as const) {
		win.on(event, reassert);
	}
}
