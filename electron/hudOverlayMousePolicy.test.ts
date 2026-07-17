import { describe, expect, it } from "vitest";
import {
	isPointInsideHudOverlayBounds,
	shouldIgnoreHudOverlayMouseEvents,
} from "./hudOverlayMousePolicy";

describe("HUD overlay mouse policy", () => {
	const bounds = { x: 1244, y: 1634, width: 587, height: 92 };

	it("turns click-through off while the cursor is inside the HUD window", () => {
		expect(shouldIgnoreHudOverlayMouseEvents(true, { x: 1278, y: 1680 }, bounds)).toBe(false);
	});

	it("restores click-through outside the HUD window", () => {
		expect(shouldIgnoreHudOverlayMouseEvents(true, { x: 3370, y: -1057 }, bounds)).toBe(true);
	});

	it("keeps the HUD interactive when the renderer has an open control", () => {
		expect(shouldIgnoreHudOverlayMouseEvents(false, { x: 3370, y: -1057 }, bounds)).toBe(false);
	});

	it("supports negative monitor origins without scale conversion", () => {
		const negativeBounds = { x: -1920, y: -600, width: 640, height: 100 };
		expect(isPointInsideHudOverlayBounds({ x: -1600, y: -550 }, negativeBounds)).toBe(true);
		expect(isPointInsideHudOverlayBounds({ x: -1279, y: -550 }, negativeBounds)).toBe(false);
	});

	it("uses an exclusive right and bottom edge", () => {
		expect(isPointInsideHudOverlayBounds({ x: 1244, y: 1634 }, bounds)).toBe(true);
		expect(isPointInsideHudOverlayBounds({ x: 1831, y: 1725 }, bounds)).toBe(false);
		expect(isPointInsideHudOverlayBounds({ x: 1830, y: 1726 }, bounds)).toBe(false);
	});

	it("rejects empty bounds", () => {
		expect(
			isPointInsideHudOverlayBounds({ x: 0, y: 0 }, { x: 0, y: 0, width: 0, height: 92 }),
		).toBe(false);
	});
});
