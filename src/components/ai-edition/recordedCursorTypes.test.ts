import { describe, expect, it } from "vitest";
import { cursorStateChanges, cursorStatesBetween } from "./recordedCursorTypes";

describe("cursorStateChanges", () => {
	it("keeps the changes only, and reads a sample with no state as the arrow", () => {
		expect(
			cursorStateChanges([
				{ timeMs: 0, cursorType: null },
				{ timeMs: 33, cursorType: "arrow" },
				{ timeMs: 66, cursorType: "text" },
				{ timeMs: 99, cursorType: "text" },
				{ timeMs: 132 },
			]),
		).toEqual([
			{ timeMs: 0, type: "arrow" },
			{ timeMs: 66, type: "text" },
			{ timeMs: 132, type: "arrow" },
		]);
	});
});

describe("cursorStatesBetween", () => {
	const changes = cursorStateChanges([
		{ timeMs: 1000, cursorType: "pointer" },
		{ timeMs: 2000, cursorType: "text" },
		{ timeMs: 3000, cursorType: "resize-ew" },
	]);

	it("counts the state in force at the start and each change up to the end", () => {
		expect(cursorStatesBetween(changes, 1500, 2500)).toEqual(new Set(["pointer", "text"]));
	});

	// A clip trimmed past a state never puts it on screen.
	it("leaves out what comes after the end", () => {
		expect(cursorStatesBetween(changes, 0, 1500)).toEqual(new Set(["arrow", "pointer"]));
		expect(cursorStatesBetween(changes, 3500, 9000)).toEqual(new Set(["resize-ew"]));
	});
});
