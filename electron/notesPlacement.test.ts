import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	PLACEMENT_FALLBACK_MS,
	type PlacedWindow,
	shrinkOncePlaced,
	topEdgeOpeningHeight,
} from "./notesPlacement";

const SIZE = { width: 400, height: 417 };
const MAX = { width: 640, height: 720 };

function fakeWindow({ destroyed = false } = {}) {
	let configure: (() => void) | undefined;
	const win = {
		configure: () => configure?.(),
		isDestroyed: () => destroyed,
		once: vi.fn((_event: "resize", listener: () => void) => {
			configure = listener;
		}),
		setSize: vi.fn(),
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
		shrinkOncePlaced(win, SIZE, MAX);
		expect(win.setSize).not.toHaveBeenCalled();

		win.configure();
		// Not inside the configure itself: a resize sent before the compositor placed the
		// window is overwritten (rc.3 probe: Notes stayed full height).
		expect(win.setSize).not.toHaveBeenCalled();
		vi.advanceTimersByTime(0);

		expect(win.setSize).toHaveBeenCalledWith(400, 417);
		expect(win.setMaximumSize).toHaveBeenCalledWith(640, 720);
	});

	it("shrinks anyway when no configure comes, and only once", () => {
		const win = fakeWindow();
		shrinkOncePlaced(win, SIZE, MAX);

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
		shrinkOncePlaced(win, SIZE, MAX);
		win.configure();
		vi.runAllTimers();
		expect(win.setSize).not.toHaveBeenCalled();
		expect(win.setMaximumSize).not.toHaveBeenCalled();
	});
});
