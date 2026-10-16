// Hiding the countdown overlay before a take starts.
//
// On Linux nothing keeps the overlay out of a capture: `setContentProtection` does nothing
// there, so the one protection is ordering — the overlay has to be gone from the compositor's
// output before the first frame is taken. `hide()` alone does not get there. The renderer was
// told to clear the digit in the same tick the window was hidden, so it never painted the empty
// state, and the last buffer the compositor held still showed the "1". GNOME Shell then animates
// the closing window out from that buffer — a fade of ~150 ms — and the capture armed right
// after `hide()` returned recorded it: the first frames of a full-screen take carried a "1"
// fading out (GNOME 46, Wayland).
//
// So on Linux the overlay is cleared first, and hidden only once its renderer reports that a
// frame without the digit has been painted. Whatever the compositor animates after that is
// transparent, for however long its animation runs. Windows and macOS keep the immediate hide.

/** Sent by the overlay's renderer once a frame without the digit has been painted. */
export const COUNTDOWN_OVERLAY_CLEARED_CHANNEL = "countdown-overlay-cleared";

/**
 * How long to wait for that report before hiding anyway. A cleared frame normally takes a few
 * display frames; this only bounds a renderer that never answers, which would otherwise keep
 * the take from starting at all.
 */
export const COUNTDOWN_OVERLAY_CLEAR_TIMEOUT_MS = 500;

type ClearedListener = (event: unknown, runId: unknown) => void;

/** The slice of `BrowserWindow` this needs, so the ordering can be tested without Electron. */
export type CountdownOverlayWindow = {
	isDestroyed(): boolean;
	isVisible(): boolean;
	hide(): void;
	webContents: {
		send(channel: string, ...args: unknown[]): void;
		/** `webContents.ipc`: only this window's messages, so no sender check is needed. */
		ipc: {
			on(channel: string, listener: ClearedListener): unknown;
			removeListener(channel: string, listener: ClearedListener): unknown;
		};
	};
};

export type HideCountdownOverlayOptions = {
	platform: NodeJS.Platform;
	/**
	 * True once a newer countdown has shown the overlay while this hide waited for the clear.
	 * Hiding then would take the new countdown off the screen.
	 */
	isSuperseded?: () => boolean;
	timeoutMs?: number;
};

export async function hideCountdownOverlay(
	overlay: CountdownOverlayWindow,
	runId: number,
	{
		platform,
		isSuperseded = () => false,
		timeoutMs = COUNTDOWN_OVERLAY_CLEAR_TIMEOUT_MS,
	}: HideCountdownOverlayOptions,
): Promise<void> {
	// Listening before the clear is sent, so a fast renderer cannot answer into nothing.
	const cleared =
		platform === "linux" && overlay.isVisible()
			? waitForCleared(overlay.webContents.ipc, runId, timeoutMs)
			: null;

	overlay.webContents.send("countdown-overlay-value", null, runId);

	if (cleared) {
		await cleared;
		if (overlay.isDestroyed() || isSuperseded()) {
			return;
		}
	}

	overlay.hide();
}

function waitForCleared(
	ipc: CountdownOverlayWindow["webContents"]["ipc"],
	runId: number,
	timeoutMs: number,
): Promise<void> {
	return new Promise<void>((resolve) => {
		let timer: ReturnType<typeof setTimeout> | null = null;
		const finish = () => {
			if (timer) {
				clearTimeout(timer);
			}
			ipc.removeListener(COUNTDOWN_OVERLAY_CLEARED_CHANNEL, onCleared);
			resolve();
		};
		// Another run's report says nothing about the frame this hide is waiting for.
		const onCleared: ClearedListener = (_event, clearedRunId) => {
			if (clearedRunId === runId) {
				finish();
			}
		};
		ipc.on(COUNTDOWN_OVERLAY_CLEARED_CHANNEL, onCleared);
		timer = setTimeout(() => {
			console.warn(
				`[countdown-overlay] no cleared frame within ${timeoutMs} ms; hiding the overlay anyway`,
			);
			finish();
		}, timeoutMs);
	});
}
