import { describe, expect, it } from "vitest";
import { browserCursorCaptureError } from "./browserCursorCapture";

describe("browser cursor capability policy", () => {
	it("explains why Linux browser editable is refused and how to choose system deliberately", () => {
		expect(browserCursorCaptureError("linux", "editable-overlay")).toContain(
			"includes the system cursor",
		);
		expect(browserCursorCaptureError("linux", "editable-overlay")).toContain("--cursor system");
	});
	it.each([
		["linux", "system"],
		["win32", "system"],
		["win32", "editable-overlay"],
		["darwin", "system"],
		["darwin", "editable-overlay"],
	] as const)("does not change %s %s policy", (platform, mode) => {
		expect(browserCursorCaptureError(platform, mode)).toBeNull();
	});
});
