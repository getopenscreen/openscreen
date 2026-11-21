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
// The first-frame wait, stored alongside the window so EVERY caller awaits it —
// including callers that receive an already-created window still mid-load. Without
// this, a second recording start could showInactive an unpainted window (#1633).
let overlayReady: Promise<void> | null = null;

async function ensureOverlayWindow(): Promise<BrowserWindow | null> {
	if (!overlayWindow || overlayWindow.isDestroyed()) {
		overlayWindow = createKeystrokeOverlayWindow();
		if (overlayWindow.isDestroyed()) {
			overlayWindow = null;
			return null;
		}
		// Wait for the first frame before showing, else Chromium flashes a black
		// rectangle because it has not rendered any pixels yet. The resolve is
		// idempotent and shared by all callers for this window's lifetime.
		overlayReady = new Promise<void>((resolve) => {
			const win = overlayWindow;
			if (!win || win.isDestroyed()) {
				resolve();
				return;
			}
			if (win.webContents.isLoading()) {
				win.once("ready-to-show", resolve);
				// A window destroyed before its first frame must not leave waiters
				// hanging; resolve on close too, the destroyed check below then bails.
				win.once("closed", resolve);
			} else {
				resolve();
			}
		});
	}
	// Capture the window we are about to wait on. A stop + start during the await
	// can replace `overlayWindow`; this continuation must not then pick up the new
	// window and show it with the old bounds before its own first frame (#1633).
	const awaited = overlayWindow;
	// Every caller, new window or reused, waits on the same readiness signal.
	await overlayReady;
	if (!awaited || awaited.isDestroyed() || overlayWindow !== awaited) {
		// Only clear the globals if the window we waited on is still the current one;
		// otherwise a replacement (with its own readiness wait) owns them.
		if (overlayWindow === awaited) {
			overlayWindow = null;
			overlayReady = null;
		}
		return null;
	}
	return awaited;
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
	overlayReady = null;
	if (win && !win.isDestroyed()) {
		win.destroy();
	}
}

/** Forwarded live keydowns (`windowsNativeRecordingSession` → `handlers`). */
export function broadcastKeystroke(vk: number, modifiers: number): void {
	const win = overlayWindow;
	if (win && !win.isDestroyed() && win.isVisible()) {
		win.webContents.send("keystroke-overlay-key", vk, modifiers);
	}
}
