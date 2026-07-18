import { describe, expect, it, vi } from "vitest";
import {
	normalizePhysicalPoint,
	resolveWindowsCursorPhysicalBounds,
} from "./windowsCursorCoordinates";

describe("normalizePhysicalPoint", () => {
	it.each([
		1,
		1.1,
		1.25,
		4 / 3,
		1.5,
		1.75,
		2,
		2.25,
		3,
	])("normalizes the same position at a %sx Windows scale", (scaleFactor) => {
		const dipBounds = { x: -1536, y: 864, width: 1536, height: 864 };
		const physicalBounds = {
			x: dipBounds.x * scaleFactor,
			y: dipBounds.y * scaleFactor,
			width: dipBounds.width * scaleFactor,
			height: dipBounds.height * scaleFactor,
		};
		const point = {
			x: physicalBounds.x + physicalBounds.width * 0.375,
			y: physicalBounds.y + physicalBounds.height * 0.625,
		};

		const normalized = normalizePhysicalPoint(point, physicalBounds);
		expect(normalized.x).toBeCloseTo(0.375, 12);
		expect(normalized.y).toBeCloseTo(0.625, 12);
		expect(normalized.withinBounds).toBe(true);
	});

	it("supports rotated monitors with a negative virtual-screen origin", () => {
		expect(
			normalizePhysicalPoint(
				{ x: 4380, y: -1057 },
				{ x: 3840, y: -2017, width: 2160, height: 3840 },
			),
		).toEqual({ x: 0.25, y: 0.25, withinBounds: true });
	});

	it("marks points on another monitor as outside the capture", () => {
		expect(
			normalizePhysicalPoint({ x: -1, y: 400 }, { x: 0, y: 0, width: 3840, height: 2160 }),
		).toMatchObject({ withinBounds: false });
	});

	it("reuses display bounds reported once in the ready event", () => {
		const readyBounds = { x: -2400, y: 0, width: 2400, height: 1350 };
		const convertDipToPhysical = vi.fn();

		expect(
			resolveWindowsCursorPhysicalBounds(
				undefined,
				readyBounds,
				{ x: -1920, y: 0, width: 1920, height: 1080 },
				convertDipToPhysical,
			),
		).toBe(readyBounds);
		expect(convertDipToPhysical).not.toHaveBeenCalled();
	});

	it("lets a moving window sample override the ready bounds", () => {
		const sampleBounds = { x: 150, y: 200, width: 1200, height: 800 };
		expect(
			resolveWindowsCursorPhysicalBounds(
				sampleBounds,
				{ x: 0, y: 0, width: 1920, height: 1080 },
				{ x: 0, y: 0, width: 1920, height: 1080 },
				() => ({ x: 0, y: 0, width: 3840, height: 2160 }),
			),
		).toBe(sampleBounds);
	});
});
