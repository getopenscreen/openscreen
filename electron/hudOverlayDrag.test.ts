import { describe, expect, it } from "vitest";
import { clampHudOverlayPosition, resolveHudOverlayDragPosition } from "./hudOverlayDrag";

const workArea = { x: 0, y: 0, width: 1920, height: 1080 };

describe("resolveHudOverlayDragPosition", () => {
	it("uses the cursor displacement from the fixed drag origin", () => {
		expect(
			resolveHudOverlayDragPosition(
				{ x: 600, y: 900, width: 600, height: 92 },
				{ x: 900, y: 946 },
				{ x: 1000, y: 946 },
			),
		).toEqual({ x: 700, y: 900 });
	});

	it("does not accumulate vertical drift when the cursor stays still", () => {
		const startBounds = { x: 600, y: 900, width: 600, height: 92 };
		const startCursor = { x: 900, y: 946 };
		const currentCursor = { x: 900, y: 946 };

		const first = resolveHudOverlayDragPosition(startBounds, startCursor, currentCursor);
		const repeated = resolveHudOverlayDragPosition(startBounds, startCursor, currentCursor);

		expect(first).toEqual({ x: 600, y: 900 });
		expect(repeated).toEqual(first);
	});

	it("keeps the complete HUD inside the active display work area", () => {
		expect(
			clampHudOverlayPosition({ x: 2200, y: 1354 }, { width: 600, height: 92 }, workArea),
		).toEqual({ x: 1320, y: 988 });
	});

	it("supports monitors positioned left of the primary display", () => {
		const leftMonitorWorkArea = { x: -1920, y: -120, width: 1920, height: 1080 };

		expect(
			clampHudOverlayPosition(
				{ x: -2100, y: -200 },
				{ width: 600, height: 92 },
				leftMonitorWorkArea,
			),
		).toEqual({ x: -1920, y: -120 });
	});
});
