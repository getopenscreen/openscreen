import { describe, expect, it } from "vitest";
import {
	getHudOverlayDragBounds,
	getHudOverlayDragPosition,
	parseHudOverlayDragPoint,
} from "./hudOverlayDrag";

describe("HUD overlay anchored dragging", () => {
	it("moves by the OS cursor delta without a scale multiplier", () => {
		expect(
			getHudOverlayDragPosition({ x: 1244, y: 1634 }, { x: 1272, y: 1671 }, { x: 1372, y: 1671 }),
		).toEqual({ x: 1344, y: 1634 });
	});

	it("supports negative mixed-monitor origins", () => {
		expect(
			getHudOverlayDragPosition({ x: -1800, y: -560 }, { x: -1760, y: -520 }, { x: -1300, y: 80 }),
		).toEqual({ x: -1340, y: 40 });
	});

	it("always resolves from the start instead of accumulating prior frames", () => {
		const startWindow = { x: 1244, y: 1634 };
		const startCursor = { x: 1272, y: 1671 };
		expect(getHudOverlayDragPosition(startWindow, startCursor, { x: 1273, y: 1672 })).toEqual({
			x: 1245,
			y: 1635,
		});
		expect(getHudOverlayDragPosition(startWindow, startCursor, { x: 1274, y: 1673 })).toEqual({
			x: 1246,
			y: 1636,
		});
	});

	it("rounds only the final DIP position", () => {
		expect(
			getHudOverlayDragPosition({ x: 10.25, y: 20.25 }, { x: 5.5, y: 8.5 }, { x: 7, y: 10 }),
		).toEqual({ x: 12, y: 22 });
	});

	it("keeps the full BrowserWindow size immutable while moving", () => {
		expect(
			getHudOverlayDragBounds(
				{ x: 1244, y: 1202, width: 220, height: 526 },
				{ x: 1272, y: 1220 },
				{ x: 1372, y: 1320 },
			),
		).toEqual({ x: 1344, y: 1302, width: 220, height: 526 });
	});

	it("accepts only finite renderer screen coordinates", () => {
		expect(parseHudOverlayDragPoint(1278.7, 1681.2)).toEqual({ x: 1278.7, y: 1681.2 });
		expect(parseHudOverlayDragPoint(Number.NaN, 1)).toBeNull();
		expect(parseHudOverlayDragPoint(1, Number.POSITIVE_INFINITY)).toBeNull();
		expect(parseHudOverlayDragPoint("1278.7", 1681.2)).toBeNull();
	});
});
