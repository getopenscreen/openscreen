import { BrowserWindow, type Rectangle } from "electron";
import { createKeystrokeOverlayWindow } from "./windows";

/**
 * Lifecycle of the keystroke overlay: one window, alive only while a take is live,
 * bounded to the display being recorded. The window is destroyed on hide rather than
 * cached — a hidden window would otherwise linger as the app's last window and block
 * quit on Windows, the same way the countdown overlay's lingering is special-cased in
 * `main.ts`. A take recreates it lazily, and the first badges may land during the
 * ~0.2 s the renderer needs to load: acceptable for a hint overlay.
 */
let overlayWindow: BrowserWindow | null = null;

async function ensureOverlayWindow(): Promise<BrowserWindow | null> {
	if (overlayWindow && !overlayWindow.isDestroyed()) {
		return overlayWindow;
	}
	overlayWindow = createKeystrokeOverlayWindow();
	if (overlayWindow.isDestroyed()) {
		overlayWindow = null;
		return null;
	}
	// Wait for the first frame before showing, else Chromium flashes a black
	// rectangle because it has not rendered any pixels yet.
	if (overlayWindow.webContents.isLoading()) {
		await new Promise<void>((resolve) => {
			overlayWindow?.once("ready-to-show", resolve);
		});
		if (!overlayWindow || overlayWindow.isDestroyed()) {
			return null;
		}
	}
	return overlayWindow;
}

export async function showKeystrokeOverlay(bounds: Rectangle): Promise<void> {
	const win = await ensureOverlayWindow();
	if (!win || win.isDestroyed()) {
		return;
	}

	win.setBounds(bounds);
	if (!win.isVisible()) {
		win.showInactive();
	}
}

export function hideKeystrokeOverlay(): void {
	const win = overlayWindow;
	overlayWindow = null;
	if (win && !win.isDestroyed()) {
		win.destroy();
	}
}

/** Forwarded live keydowns (`windowsNativeRecordingSession` → `handlers`). */
export function broadcastKeystroke(vk: number): void {
	const win = overlayWindow;
	if (win && !win.isDestroyed() && win.isVisible()) {
		win.webContents.send("keystroke-overlay-key", vk);
	}
}
