import { describe, expect, it } from "vitest";
import { HIDDEN_WINDOWS_NOTE, pickRecordingSource } from "./cliSourcePick";

const sources = [
	{ id: "screen:0:0", name: "Entire screen" },
	{ id: "screen:1:0", name: "Screen 2" },
	{ id: "window:65868:0", name: "Parsec" },
	{ id: "window:656460:0", name: "Paramètres" },
];

describe("pickRecordingSource", () => {
	it("picks the first window whose title contains the text, ignoring case", () => {
		expect(pickRecordingSource(sources, { windowTitle: "PARAM", displayIndex: 0 }).id).toBe(
			"window:656460:0",
		);
	});

	it("never matches a display by its name", () => {
		expect(() => pickRecordingSource(sources, { windowTitle: "screen", displayIndex: 0 })).toThrow(
			/No window title contains "screen"/,
		);
	});

	it("says a missing window may be minimized or hidden, and lists the windows it saw", () => {
		const miss = () => pickRecordingSource(sources, { windowTitle: "Edge", displayIndex: 0 });
		expect(miss).toThrow(HIDDEN_WINDOWS_NOTE);
		expect(miss).toThrow("  - Parsec\n  - Paramètres");
	});

	it("falls back to the display at the index, counting displays only", () => {
		expect(pickRecordingSource(sources, { windowTitle: null, displayIndex: 1 }).id).toBe(
			"screen:1:0",
		);
		expect(() => pickRecordingSource(sources, { windowTitle: null, displayIndex: 2 })).toThrow(
			"Display index 2 not found (2 screen(s) available)",
		);
	});
});
