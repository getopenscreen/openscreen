import { describe, expect, it } from "vitest";
import { arrowBox, arrowRect } from "./arrowBounds";

describe("arrowBounds", () => {
	it("frames the arrow, not its box", () => {
		// A wide box: the arrow takes the height, centred; a diagonal fills half of it.
		const drawn = arrowRect({ x: 100, y: 50, width: 600, height: 300 }, "down-right", 8);
		// Scale 3, offset 150 on x; the strokes go from 25 - 4 to 75 + 4.
		expect(drawn).toEqual({ x: 100 + 150 + 21 * 3, y: 50 + 21 * 3, width: 58 * 3, height: 58 * 3 });
	});

	it("writes back a square box that draws the arrow where the gimbal left it", () => {
		for (const direction of ["right", "up", "down-left"] as const) {
			const drawn = { x: 40, y: 30, width: 120, height: 0 };
			const box = arrowBox({ ...drawn, height: 1 }, direction, 6);
			expect(box.width).toBe(box.height);
			const back = arrowRect(box, direction, 6);
			expect(back.x).toBeCloseTo(40, 9);
			expect(back.y).toBeCloseTo(30, 9);
			expect(back.width).toBeCloseTo(120, 9);
		}
	});

	it("keeps an arrow drawn where it was when its box becomes square", () => {
		const box = { x: 10, y: 20, width: 500, height: 200 };
		const drawn = arrowRect(box, "up", 7);
		const again = arrowRect(arrowBox(drawn, "up", 7), "up", 7);
		expect(again.x).toBeCloseTo(drawn.x, 9);
		expect(again.y).toBeCloseTo(drawn.y, 9);
		expect(again.width).toBeCloseTo(drawn.width, 9);
		expect(again.height).toBeCloseTo(drawn.height, 9);
	});
});
