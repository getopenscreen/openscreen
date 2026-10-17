import type { CursorRecordingData, CursorRecordingSample } from "../../../../src/native/contracts";

export interface CursorPauseRange {
	startMs: number;
	endMs: number;
}

export function compactCursorTelemetryPauseRanges(
	recording: CursorRecordingData,
	ranges: CursorPauseRange[],
): CursorRecordingData {
	if (ranges.length === 0) return recording;

	const normalizedRanges = ranges
		.map((range) => ({
			startMs: Math.max(0, Math.min(range.startMs, range.endMs)),
			endMs: Math.max(0, Math.max(range.startMs, range.endMs)),
		}))
		.filter((range) => Number.isFinite(range.startMs) && Number.isFinite(range.endMs))
		.filter((range) => range.endMs > range.startMs)
		.sort((a, b) => a.startMs - b.startMs);

	if (normalizedRanges.length === 0) return recording;

	return {
		...recording,
		samples: recording.samples
			.map((sample) => {
				let pausedBeforeSampleMs = 0;
				for (const range of normalizedRanges) {
					if (sample.timeMs >= range.startMs && sample.timeMs <= range.endMs) {
						return null;
					}
					if (sample.timeMs > range.endMs) {
						pausedBeforeSampleMs += range.endMs - range.startMs;
					}
				}

				return { ...sample, timeMs: Math.max(0, sample.timeMs - pausedBeforeSampleMs) };
			})
			.filter((sample): sample is CursorRecordingSample => Boolean(sample))
			.sort((a, b) => a.timeMs - b.timeMs),
	};
}
