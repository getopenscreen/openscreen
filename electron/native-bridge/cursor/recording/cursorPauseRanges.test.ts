import { describe, expect, it } from "vitest";
import type { CursorRecordingData } from "../../../../src/native/contracts";
import { compactCursorTelemetryPauseRanges } from "./cursorPauseRanges";

function recording(...times: number[]): CursorRecordingData {
	return {
		version: 2,
		provider: "none",
		samples: times.map((timeMs) => ({ timeMs, cx: 0.5, cy: 0.5 })),
		assets: [],
	};
}

describe("compactCursorTelemetryPauseRanges", () => {
	it("removes paused samples and shifts later samples across repeated pauses", () => {
		const compacted = compactCursorTelemetryPauseRanges(recording(100, 250, 500, 650, 900), [
			{ startMs: 200, endMs: 400 },
			{ startMs: 600, endMs: 800 },
		]);

		expect(compacted.samples.map((sample) => sample.timeMs)).toEqual([100, 300, 500]);
	});

	it("ignores invalid ranges without replacing the recording", () => {
		const input = recording(100, 200);

		expect(
			compactCursorTelemetryPauseRanges(input, [
				{ startMs: 100, endMs: 100 },
				{ startMs: Number.NaN, endMs: 200 },
			]),
		).toBe(input);
	});
});
