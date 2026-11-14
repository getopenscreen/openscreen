import { describe, expect, it } from "vitest";
import { speedOutputSec } from "./speed";

describe("speedOutputSec", () => {
	it("divides the span by the speed", () => {
		expect(speedOutputSec(8, 2)).toBe(4);
		expect(speedOutputSec(3, 0.5)).toBe(6);
	});

	it("treats an invalid speed as 1×", () => {
		expect(speedOutputSec(5, 0)).toBe(5);
		expect(speedOutputSec(5, Number.NaN)).toBe(5);
	});
});
