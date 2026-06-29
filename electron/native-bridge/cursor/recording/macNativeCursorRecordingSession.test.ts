import { describe, expect, it } from "vitest";
import { normalizeCursorToBounds } from "./macNativeCursorRecordingSession";

describe("normalizeCursorToBounds", () => {
	it("maps a point to [0,1] within the given bounds", () => {
		const bounds = { x: 0, y: 0, width: 1000, height: 500 };
		expect(normalizeCursorToBounds({ x: 0, y: 0 }, bounds)).toMatchObject({
			normalizedX: 0,
			normalizedY: 0,
			isOutsideBounds: false,
		});
		expect(normalizeCursorToBounds({ x: 500, y: 250 }, bounds)).toMatchObject({
			normalizedX: 0.5,
			normalizedY: 0.5,
			isOutsideBounds: false,
		});
	});

	it("accounts for the bounds origin offset", () => {
		const bounds = { x: 200, y: 100, width: 800, height: 600 };
		const { normalizedX, normalizedY, isOutsideBounds } = normalizeCursorToBounds(
			{ x: 600, y: 400 },
			bounds,
		);
		expect(normalizedX).toBeCloseTo(0.5);
		expect(normalizedY).toBeCloseTo(0.5);
		expect(isOutsideBounds).toBe(false);
	});

	it("flags points outside the bounds", () => {
		const bounds = { x: 200, y: 100, width: 800, height: 600 };
		expect(normalizeCursorToBounds({ x: 100, y: 50 }, bounds).isOutsideBounds).toBe(true);
		expect(normalizeCursorToBounds({ x: 1200, y: 800 }, bounds).isOutsideBounds).toBe(true);
	});

	// The window-capture bug: the recorded video is just the window, but the cursor
	// used to be normalized against the whole display, putting the overlay cursor far
	// from where the click actually landed. Normalizing against the window frame fixes it.
	it("normalizes against the window frame, not the display, for window capture", () => {
		// A 1920x1080 display with a window offset to (600, 300) sized 800x600.
		const display = { x: 0, y: 0, width: 1920, height: 1080 };
		const windowFrame = { x: 600, y: 300, width: 800, height: 600 };
		// Cursor sitting at the exact center of the window.
		const cursor = { x: windowFrame.x + 400, y: windowFrame.y + 300 };

		const againstWindow = normalizeCursorToBounds(cursor, windowFrame);
		expect(againstWindow.normalizedX).toBeCloseTo(0.5);
		expect(againstWindow.normalizedY).toBeCloseTo(0.5);

		const againstDisplay = normalizeCursorToBounds(cursor, display);
		// Against the display the same physical point maps to a very different spot,
		// which is the visible misalignment users reported.
		expect(againstDisplay.normalizedX).toBeCloseTo(1000 / 1920);
		expect(againstDisplay.normalizedY).toBeCloseTo(600 / 1080);
		expect(Math.abs(againstWindow.normalizedX - againstDisplay.normalizedX)).toBeGreaterThan(0.02);
	});
});
