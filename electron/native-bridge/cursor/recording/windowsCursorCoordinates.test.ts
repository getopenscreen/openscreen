import { describe, expect, it } from "vitest";
import { normalizePhysicalPoint } from "./windowsCursorCoordinates";

describe("normalizePhysicalPoint", () => {
	it.each([
		1, 1.25, 1.5, 1.75, 2,
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

		expect(normalizePhysicalPoint(point, physicalBounds)).toEqual({
			x: 0.375,
			y: 0.625,
			withinBounds: true,
		});
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
});
