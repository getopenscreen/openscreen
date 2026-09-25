import { describe, expect, it } from "vitest";
import { parseCustomPlaybackSpeedInput } from "./customPlaybackSpeed";

describe("parseCustomPlaybackSpeedInput", () => {
	it("accepts decimal playback speeds", () => {
		expect(parseCustomPlaybackSpeedInput("1.1")).toEqual({
			status: "valid",
			draft: "1.1",
			speed: 1.1,
		});
	});

	it("rejects malformed multi-dot input", () => {
		// The previous parser silently collapsed "1.2.3" into "1.23"; that
		// round-trip is gone, so the new parser sees an unparseable string.
		expect(parseCustomPlaybackSpeedInput("1.2.3")).toEqual({
			status: "empty",
			draft: "1.2.3",
		});
	});

	it("allows sub-1 custom speeds down to the editor minimum", () => {
		expect(parseCustomPlaybackSpeedInput("0.25")).toEqual({
			status: "valid",
			draft: "0.25",
			speed: 0.25,
		});
	});

	it("rejects speeds below the editor minimum", () => {
		expect(parseCustomPlaybackSpeedInput("0.2")).toEqual({
			status: "too-slow",
			draft: "0.2",
		});
	});

	it("accepts comma decimal input by normalizing to a dot", () => {
		// The draft round-trip is gone; the input is preserved verbatim. Only the
		// parsed speed uses the normalized form.
		expect(parseCustomPlaybackSpeedInput("1,1")).toEqual({
			status: "valid",
			draft: "1,1",
			speed: 1.1,
		});
	});

	it("accepts the maximum editor speed, the preview's own ceiling", () => {
		expect(parseCustomPlaybackSpeedInput("16")).toEqual({
			status: "valid",
			draft: "16",
			speed: 16,
		});
	});

	it("rejects speeds above the editor maximum", () => {
		// Past 16x the preview could not show what the export rendered.
		expect(parseCustomPlaybackSpeedInput("16.1")).toEqual({
			status: "too-fast",
			draft: "16.1",
		});
	});
});
