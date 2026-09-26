import { describe, expect, it } from "vitest";
import { frameFootprint, frameUnit } from "./frameFootprint";

describe("frameFootprint", () => {
	// A 16:9 screen filling 80% of a 16:9 output: the case the compositor's
	// `the_device_footprint_at_rest_is_pinned_for_the_block_layout` measures with its own model.
	const screen = { width: 1536, height: 864 };
	const unit = frameUnit(screen, { width: 1920, height: 1080 });

	it("measures the frame unit off the output's short side", () => {
		expect(unit).toBe(864);
		// Same unit around a portrait clip that touches the same padded area.
		expect(frameUnit({ width: 486, height: 864 }, { width: 1920, height: 1080 })).toBe(864);
	});

	it.each([
		["laptop", [0.18596, 0.0409, 0.18596, 0.09983]],
		["phone", [0.0193, 0.0193, 0.0193, 0.0193]],
		["monitor", [0.0231, 0.0231, 0.0231, 0.2446]],
	] as const)("measures the %s at rest exactly as the compositor draws it", (frame, want) => {
		const { body, outer } = frameFootprint(frame, screen, unit);
		outer.forEach((inset, k) => expect(inset / unit).toBeCloseTo(want[k], 4));
		// The body is the front face; the deck and the stand only ever add to it.
		body.forEach((inset, k) => expect(outer[k]).toBeGreaterThanOrEqual(inset - 1e-9));
	});

	it("draws nothing without a frame, and the window chrome flat around the screen", () => {
		expect(frameFootprint("none", screen, unit)).toEqual({
			body: [0, 0, 0, 0],
			outer: [0, 0, 0, 0],
		});
		const window = frameFootprint("window", screen, unit);
		expect(window.outer).toEqual(window.body);
		expect(window.body[1] / unit).toBeCloseTo(0.04, 6); // the title bar
		expect(window.body[0] / unit).toBeCloseTo(0.0012, 6); // the line around the rest
	});
});
