import { describe, expect, it } from "vitest";
import { cursorMotionLabel } from "./cursorMotionLabels";

// The translator echoes its key: the assertions read against keys, not copy.
const ts = (key: string) => key;

describe("cursorMotionLabel", () => {
	it("names a Smooth section with its strength, defaulted when none is stored", () => {
		expect(cursorMotionLabel({ mode: "smooth", strength: 0.8 }, ts)).toBe(
			"cursorMotion.modes.smooth · 80%",
		);
		expect(cursorMotionLabel({ mode: "smooth" }, ts)).toBe("cursorMotion.modes.smooth · 50%");
	});

	it("names a Straight section with its speed curve, defaulted when none is stored", () => {
		expect(cursorMotionLabel({ mode: "straight", easing: "ease-out" }, ts)).toBe(
			"cursorMotion.modes.straight · cursorMotion.easings.easeOut",
		);
		expect(cursorMotionLabel({ mode: "straight" }, ts)).toBe(
			"cursorMotion.modes.straight · cursorMotion.easings.easeInOut",
		);
	});

	it("names a Freeze or As recorded section by its mode alone, whatever else is stored", () => {
		expect(cursorMotionLabel({ mode: "freeze", strength: 0.8, easing: "linear" }, ts)).toBe(
			"cursorMotion.modes.freeze",
		);
		expect(cursorMotionLabel({ mode: "recorded" }, ts)).toBe("cursorMotion.modes.recorded");
	});
});
