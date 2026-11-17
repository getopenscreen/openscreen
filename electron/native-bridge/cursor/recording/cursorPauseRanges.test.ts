import { describe, expect, it } from "vitest";
import type { CursorRecordingData } from "../../../../src/native/contracts";
import {
	compactCursorTelemetryPauseRanges,
	finalizeBrowserCursorTelemetry,
} from "./cursorPauseRanges";

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

describe("finalizeBrowserCursorTelemetry", () => {
	it("drops paused clicks, shifts resume samples, and removes post-video tail", () => {
		const input = recording(0, 100, 1000, 2000, 3000, 3500, 4000, 4050);
		input.samples[3].interactionType = "click";
		const output = finalizeBrowserCursorTelemetry(input, [{ startMs: 1000, endMs: 3000 }], 2000);
		expect(output.samples.map((sample) => sample.timeMs)).toEqual([0, 100, 1500, 2000]);
		expect(output.samples.some((sample) => sample.interactionType === "click")).toBe(false);
		expect(input.samples).toHaveLength(8);
	});
	it("supports stopping while paused and rejects nonfinite/negative sample times", () => {
		const output = finalizeBrowserCursorTelemetry(
			recording(-1, 0, 999, 1000, 2000, NaN),
			[{ startMs: 1000, endMs: 3000 }],
			1000,
		);
		expect(output.samples.map((sample) => sample.timeMs)).toEqual([0, 999]);
	});
	it("bounds an unpaused track and accepts omitted pause metadata", () => {
		expect(
			finalizeBrowserCursorTelemetry(recording(0, 1000, 1033), undefined, 1000).samples.map(
				(sample) => sample.timeMs,
			),
		).toEqual([0, 1000]);
	});
});
