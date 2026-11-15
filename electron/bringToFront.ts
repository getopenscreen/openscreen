import type { BrowserWindow } from "electron";

/**
 * Brings back a window the user may have minimized or hidden. `focus()` alone does
 * neither: a minimized window stays in the taskbar and a hidden one stays hidden.
 */
export function bringToFront(
	win: Pick<BrowserWindow, "isMinimized" | "restore" | "show" | "focus">,
) {
	if (win.isMinimized()) win.restore();
	win.show();
	win.focus();
}
