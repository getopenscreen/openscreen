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
	it("is its own inverse", () => {
		const r = { x: 0.13, y: 0.07, width: 0.61, height: 0.42 };
		const back = turnCropRegion(turnCropRegion(r));
		expect(back.x).toBeCloseTo(r.x, 12);
		expect(back.y).toBeCloseTo(r.y, 12);
	});
});
