import { describe, expect, it } from "vitest";
import { clipRotation, turnCropRegion } from "./clipRotation";

describe("clipRotation", () => {
	it("reads an absent field as 0", () => {
		expect(clipRotation({})).toBe(0);
		expect(clipRotation({ rotation: 180 })).toBe(180);
	});
});

describe("turnCropRegion", () => {
	it("mirrors the rectangle inside the frame", () => {
		expect(turnCropRegion({ x: 0.1, y: 0.2, width: 0.5, height: 0.3 })).toEqual({
			x: 0.4,
			y: 0.5,
			width: 0.5,
			height: 0.3,
		});
	});
	it("never yields a negative x/y for a rectangle flush against the far edge", () => {
		// 1 - 0.9 - 0.1 is -2.8e-17 in floating point; a crop below 0 fails the schema.
		const turned = turnCropRegion({ x: 0.9, y: 0.9, width: 0.1, height: 0.1 });
		expect(turned.x).toBe(0);
		expect(turned.y).toBe(0);
	});
	it("is its own inverse", () => {
		const r = { x: 0.13, y: 0.07, width: 0.61, height: 0.42 };
		const back = turnCropRegion(turnCropRegion(r));
		expect(back.x).toBeCloseTo(r.x, 12);
		expect(back.y).toBeCloseTo(r.y, 12);
	});
});
