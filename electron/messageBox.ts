import { type BrowserWindow, dialog } from "electron";

/**
 * Transparent windows that must not own a dialog on macOS.
 *
 * On macOS an owned message box is a sheet, and AppKit dims the whole owning window behind
 * it. The HUD and the other overlays are mostly invisible padding around what they draw
 * (the HUD is ~900x700 for a bar ~60 px tall), so the dim paints a grey rectangle over the
 * desktop, far larger than anything the user sees of the app.
 *
 * Elsewhere they keep owning their dialogs: on Windows and most Linux WMs an unowned
 * dialog opens behind these `alwaysOnTop` windows, with no taskbar entry to recover it.
 * macOS has no such problem -- an unowned alert is app-modal and sits at the modal-panel
 * level, above the HUD's floating one.
 */
const sheetlessWindows = new WeakSet<BrowserWindow>();

export function markSheetless(win: BrowserWindow): void {
	sheetlessWindows.add(win);
}

/** The window a message box should be attached to, or null to show it unowned. */
export function messageBoxOwner(
	parent: BrowserWindow | null | undefined,
	platform: NodeJS.Platform = process.platform,
): BrowserWindow | null {
	if (!parent || parent.isDestroyed()) {
		return null;
	}
	if (platform === "darwin" && sheetlessWindows.has(parent)) {
		return null;
	}
	return parent;
}

export function showMessageBoxOver(
	parent: BrowserWindow | null | undefined,
	options: Electron.MessageBoxOptions,
): Promise<Electron.MessageBoxReturnValue> {
	const owner = messageBoxOwner(parent);
	return owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options);
}

/**
 * File panels follow the same ownership rules as message boxes. Unowned, a macOS save panel
 * is a free-floating window: one click on the editor behind it sends it behind the editor,
 * out of reach, while the caller waits on it forever (#743). Owned, it is a sheet on that
 * window and cannot be lost.
 */
export function showSaveDialogOver(
	parent: BrowserWindow | null | undefined,
	options: Electron.SaveDialogOptions,
): Promise<Electron.SaveDialogReturnValue> {
	const owner = messageBoxOwner(parent);
	return owner ? dialog.showSaveDialog(owner, options) : dialog.showSaveDialog(options);
}

export function showOpenDialogOver(
	parent: BrowserWindow | null | undefined,
	options: Electron.OpenDialogOptions,
): Promise<Electron.OpenDialogReturnValue> {
	const owner = messageBoxOwner(parent);
	return owner ? dialog.showOpenDialog(owner, options) : dialog.showOpenDialog(options);
}
