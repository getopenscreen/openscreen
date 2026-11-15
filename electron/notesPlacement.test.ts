import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	PLACEMENT_FALLBACK_MS,
	type PlacedWindow,
	shrinkOncePlaced,
	topEdgeOpeningHeight,
} from "./notesPlacement";

const SETTLED = {
	size: { width: 400, height: 417 },
	min: { width: 360, height: 400 },
	max: { width: 640, height: 720 },
};

function fakeWindow({ destroyed = false } = {}) {
	let configure: (() => void) | undefined;
	const win = {
		configure: () => configure?.(),
		isDestroyed: () => destroyed,
		once: vi.fn((_event: "resize", listener: () => void) => {
			configure = listener;
		}),
		setSize: vi.fn(),
		setMinimumSize: vi.fn(),
		setMaximumSize: vi.fn(),
	};
	return win satisfies PlacedWindow;
}

describe("topEdgeOpeningHeight", () => {
	it("is taller than every display, so the compositor has to clamp it", () => {
		expect(topEdgeOpeningHeight([1080, 1440])).toBe(1441);
		expect(topEdgeOpeningHeight([])).toBe(1);
	});
});

describe("shrinkOncePlaced (GNOME Wayland Notes)", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("waits for the compositor's first configure, then shrinks on the next turn", () => {
		const win = fakeWindow();
		shrinkOncePlaced(win, () => SETTLED);
		expect(win.setSize).not.toHaveBeenCalled();

		win.configure();
		// Not inside the configure itself: a resize sent before the compositor placed the
		// window is overwritten (rc.3 probe: Notes stayed full height).
		expect(win.setSize).not.toHaveBeenCalled();
		vi.advanceTimersByTime(0);

		expect(win.setSize).toHaveBeenCalledWith(400, 417);
		expect(win.setMinimumSize).toHaveBeenCalledWith(360, 400);
		expect(win.setMaximumSize).toHaveBeenCalledWith(640, 720);
		// The minimum goes first, so a target below the old one is not clamped back up.
		expect(win.setMinimumSize.mock.invocationCallOrder[0]).toBeLessThan(
			win.setSize.mock.invocationCallOrder[0],
		);
	});

	it("reads the size when it shrinks, not when it was asked to", () => {
		const win = fakeWindow();
		let height = 417;
		shrinkOncePlaced(win, () => ({
			...SETTLED,
			size: { width: 400, height },
			min: { width: 360, height: Math.min(400, height) },
		}));
		// The HUD reported a lower stack top before the compositor placed Notes.
		height = 288;
		win.configure();
		vi.advanceTimersByTime(0);

		expect(win.setSize).toHaveBeenCalledWith(400, 288);
		expect(win.setMinimumSize).toHaveBeenCalledWith(360, 288);
	});

	it("shrinks anyway when no configure comes, and only once", () => {
		const win = fakeWindow();
		shrinkOncePlaced(win, () => SETTLED);

		vi.advanceTimersByTime(PLACEMENT_FALLBACK_MS - 1);
		expect(win.setSize).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(win.setSize).toHaveBeenCalledTimes(1);

		win.configure();
		vi.runAllTimers();
		expect(win.setSize).toHaveBeenCalledTimes(1);
	});

	it("leaves a window closed before it was placed alone", () => {
		const win = fakeWindow({ destroyed: true });
		shrinkOncePlaced(win, () => SETTLED);
		win.configure();
		vi.runAllTimers();
		expect(win.setSize).not.toHaveBeenCalled();
		expect(win.setMaximumSize).not.toHaveBeenCalled();
	});
});
