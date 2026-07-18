import { describe, expect, it } from "vitest";
import { getHudViewportCompensation } from "./hudViewportCompensation";

describe("getHudViewportCompensation", () => {
	it("counteracts fractional-DPI viewport enlargement around the bottom centre", () => {
		expect(
			getHudViewportCompensation(
				{ x: 0, y: 0 },
				{ width: 588, height: 95 },
				{ width: 594, height: 99 },
			),
		).toEqual({ x: 3, y: 4 });
	});

	it("accumulates only the new rounding delta across consecutive drags", () => {
		expect(
			getHudViewportCompensation(
				{ x: 3, y: 4 },
				{ width: 594, height: 99 },
				{ width: 596, height: 100 },
			),
		).toEqual({ x: 4, y: 5 });
	});

	it("removes compensation when Chromium shrinks the viewport again", () => {
		expect(
			getHudViewportCompensation(
				{ x: 3, y: 4 },
				{ width: 594, height: 99 },
				{ width: 588, height: 95 },
			),
		).toEqual({ x: 0, y: 0 });
	});

	it("ignores a large intentional horizontal-to-vertical content resize", () => {
		expect(
			getHudViewportCompensation(
				{ x: 0, y: 0 },
				{ width: 588, height: 95 },
				{ width: 220, height: 526 },
			),
		).toEqual({ x: 0, y: 0 });
	});
});
