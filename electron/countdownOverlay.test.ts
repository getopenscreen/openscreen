import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	COUNTDOWN_OVERLAY_CLEAR_TIMEOUT_MS,
	COUNTDOWN_OVERLAY_CLEARED_CHANNEL,
	hideCountdownOverlay,
} from "./countdownOverlay";

/** Records every call on the overlay in order, which is what this suite is about. */
function fakeOverlay({ visible = true } = {}) {
	const calls: string[] = [];
	const ipc = new EventEmitter();
	let destroyed = false;
	const overlay = {
		isDestroyed: () => destroyed,
		isVisible: () => visible,
		hide: vi.fn(() => {
			calls.push("hide");
		}),
		webContents: {
			send: vi.fn((channel: string, value: unknown, runId: unknown) => {
				calls.push(`send ${channel} ${String(value)} ${String(runId)}`);
			}),
			ipc,
		},
	};
	return {
		overlay,
		calls,
		cleared: (runId: number) => ipc.emit(COUNTDOWN_OVERLAY_CLEARED_CHANNEL, {}, runId),
		destroy: () => {
			destroyed = true;
		},
	};
}

/** Lets the hide's pending awaits run without advancing any timer. */
const settle = () => vi.advanceTimersByTimeAsync(0);

describe("hideCountdownOverlay", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	describe("on Linux, where only ordering keeps the overlay out of the capture", () => {
		it("clears the digit and hides only once the renderer has painted the cleared frame", async () => {
			const { overlay, calls, cleared } = fakeOverlay();
			let done = false;
			const hiding = hideCountdownOverlay(overlay, 7, { platform: "linux" }).then(() => {
				done = true;
			});

			await settle();
			expect(calls).toEqual(["send countdown-overlay-value null 7"]);
			expect(overlay.hide).not.toHaveBeenCalled();
			// The caller starts the capture when this resolves, so it must still be pending.
			expect(done).toBe(false);

			cleared(7);
			await hiding;
			expect(calls).toEqual(["send countdown-overlay-value null 7", "hide"]);
			expect(overlay.webContents.ipc.listenerCount(COUNTDOWN_OVERLAY_CLEARED_CHANNEL)).toBe(0);
		});

		it("listens for the report before asking for the clear, so a fast renderer is not missed", async () => {
			const { overlay, calls } = fakeOverlay();
			overlay.webContents.send.mockImplementation((channel, value, runId) => {
				calls.push(`send ${channel} ${String(value)} ${String(runId)}`);
				overlay.webContents.ipc.emit(COUNTDOWN_OVERLAY_CLEARED_CHANNEL, {}, runId);
			});

			await hideCountdownOverlay(overlay, 3, { platform: "linux" });

			expect(calls).toEqual(["send countdown-overlay-value null 3", "hide"]);
		});

		it("ignores a cleared report from another countdown run", async () => {
			const { overlay, cleared } = fakeOverlay();
			const hiding = hideCountdownOverlay(overlay, 8, { platform: "linux" });

			cleared(7);
			await settle();
			expect(overlay.hide).not.toHaveBeenCalled();

			cleared(8);
			await hiding;
			expect(overlay.hide).toHaveBeenCalledTimes(1);
		});

		it("hides anyway when the renderer never reports, so the take still starts", async () => {
			const { overlay } = fakeOverlay();
			const hiding = hideCountdownOverlay(overlay, 1, { platform: "linux" });

			await vi.advanceTimersByTimeAsync(COUNTDOWN_OVERLAY_CLEAR_TIMEOUT_MS - 1);
			expect(overlay.hide).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(1);
			await hiding;
			expect(overlay.hide).toHaveBeenCalledTimes(1);
			expect(overlay.webContents.ipc.listenerCount(COUNTDOWN_OVERLAY_CLEARED_CHANNEL)).toBe(0);
		});

		it("leaves the overlay up when a newer countdown showed it during the wait", async () => {
			const { overlay, cleared } = fakeOverlay();
			let superseded = false;
			const hiding = hideCountdownOverlay(overlay, 4, {
				platform: "linux",
				isSuperseded: () => superseded,
			});

			superseded = true;
			cleared(4);
			await hiding;

			expect(overlay.hide).not.toHaveBeenCalled();
		});

		it("does not touch a window destroyed during the wait", async () => {
			const { overlay, cleared, destroy } = fakeOverlay();
			const hiding = hideCountdownOverlay(overlay, 5, { platform: "linux" });

			destroy();
			cleared(5);
			await hiding;

			expect(overlay.hide).not.toHaveBeenCalled();
		});

		it("hides at once when the overlay is not on screen, since nothing is left to paint", async () => {
			const { overlay, calls } = fakeOverlay({ visible: false });

			await hideCountdownOverlay(overlay, 2, { platform: "linux" });

			expect(calls).toEqual(["send countdown-overlay-value null 2", "hide"]);
			expect(overlay.webContents.ipc.listenerCount(COUNTDOWN_OVERLAY_CLEARED_CHANNEL)).toBe(0);
		});
	});

	it.each([
		"win32",
		"darwin",
	] as const)("keeps the immediate, synchronous hide on %s", (platform) => {
		const { overlay, calls } = fakeOverlay();

		// Not awaited: the hide must already have happened synchronously.
		void hideCountdownOverlay(overlay, 6, { platform });

		expect(calls).toEqual(["send countdown-overlay-value null 6", "hide"]);
		expect(overlay.webContents.ipc.listenerCount(COUNTDOWN_OVERLAY_CLEARED_CHANNEL)).toBe(0);
	});
});
