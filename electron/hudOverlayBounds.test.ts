import { describe, expect, it } from "vitest";
import { getHudOverlayResizedBounds } from "./hudOverlayBounds";

describe("HUD overlay content resizing", () => {
	it("preserves the bottom-centre anchor away from monitor edges", () => {
		expect(
			getHudOverlayResizedBounds(
				{ x: 1244, y: 1634, width: 587, height: 92 },
				{ x: 0, y: 0, width: 3072, height: 1728 },
				594,
				99,
			),
		).toEqual({ x: 1241, y: 1627, width: 594, height: 99 });
	});

	it("keeps an expanding popup inside the right edge of its display", () => {
		expect(
			getHudOverlayResizedBounds(
				{ x: 2800, y: 1600, width: 220, height: 100 },
				{ x: 0, y: 0, width: 3072, height: 1728 },
				600,
				200,
			),
		).toEqual({ x: 2472, y: 1500, width: 600, height: 200 });
	});

	it("supports work areas with negative mixed-monitor origins", () => {
		expect(
			getHudOverlayResizedBounds(
				{ x: -1910, y: -180, width: 220, height: 100 },
				{ x: -1920, y: -1040, width: 1920, height: 1040 },
				600,
				200,
			),
		).toEqual({ x: -1920, y: -280, width: 600, height: 200 });
	});

	it("clamps an oversized HUD to the display work area", () => {
		expect(
			getHudOverlayResizedBounds(
				{ x: 3200, y: -1500, width: 400, height: 120 },
				{ x: 3072, y: -1920, width: 1080, height: 1920 },
				1400,
				2200,
			),
		).toEqual({ x: 3072, y: -1920, width: 1080, height: 1920 });
	});
});
