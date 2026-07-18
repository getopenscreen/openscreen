import { describe, expect, it } from "vitest";
import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import type { AxcutClip } from "@/lib/ai-edition/schema";
import {
	buildAutoZoomSuggestions,
	buildAutoZoomSuggestionsForClips,
	detectZoomDwellCandidates,
} from "./zoom-suggestions";

// A dwell = many samples clustered in time at (nearly) the same position.
function dwell(
	centerMs: number,
	cx: number,
	cy: number,
	count = 6,
	spanMs = 900,
): CursorTelemetryPoint[] {
	const step = spanMs / (count - 1);
	return Array.from({ length: count }, (_, i) => ({
		timeMs: centerMs - spanMs / 2 + i * step,
		cx,
		cy,
	}));
}

describe("detectZoomDwellCandidates", () => {
	it("finds a dwell where the cursor sits still", () => {
		const candidates = detectZoomDwellCandidates(dwell(1000, 0.4, 0.6));
		expect(candidates).toHaveLength(1);
		expect(candidates[0].focus.cx).toBeCloseTo(0.4, 5);
		expect(candidates[0].focus.cy).toBeCloseTo(0.6, 5);
	});

	it("ignores a fast sweep across the screen (no dwell)", () => {
		const samples: CursorTelemetryPoint[] = Array.from({ length: 10 }, (_, i) => ({
			timeMs: i * 100,
			cx: i / 10,
			cy: i / 10,
		}));
		expect(detectZoomDwellCandidates(samples)).toHaveLength(0);
	});
});

describe("buildAutoZoomSuggestions", () => {
	it("returns a centered span around each accepted dwell", () => {
		const telemetry = dwell(2000, 0.5, 0.5);
		const suggestions = buildAutoZoomSuggestions({
			cursorTelemetry: telemetry,
			totalMs: 5000,
			existingRegions: [],
			defaultDurationMs: 2000,
		});
		expect(suggestions).toHaveLength(1);
		// centred on ~2000ms with a 2000ms default → ~1000..3000
		expect(suggestions[0].span.start).toBe(1000);
		expect(suggestions[0].span.end).toBe(3000);
	});

	it("drops candidates overlapping an existing zoom region", () => {
		const telemetry = dwell(2000, 0.5, 0.5);
		const suggestions = buildAutoZoomSuggestions({
			cursorTelemetry: telemetry,
			totalMs: 5000,
			existingRegions: [{ startMs: 1500, endMs: 2500 }],
			defaultDurationMs: 2000,
		});
		expect(suggestions).toHaveLength(0);
	});

	it("spaces two dwells and returns both when far apart", () => {
		const telemetry = [...dwell(1500, 0.2, 0.2), ...dwell(6000, 0.8, 0.8)];
		const suggestions = buildAutoZoomSuggestions({
			cursorTelemetry: telemetry,
			totalMs: 9000,
			existingRegions: [],
			defaultDurationMs: 1500,
		});
		expect(suggestions.length).toBe(2);
	});

	it("returns nothing without telemetry", () => {
		expect(
			buildAutoZoomSuggestions({
				cursorTelemetry: [],
				totalMs: 5000,
				existingRegions: [],
				defaultDurationMs: 2000,
			}),
		).toEqual([]);
	});
});

function clip(overrides: Partial<AxcutClip> & Pick<AxcutClip, "id">): AxcutClip {
	return {
		id: overrides.id,
		assetId: "asset_1",
		sourceStartSec: 0,
		sourceEndSec: 5,
		timelineStartSec: 0,
		timelineEndSec: 5,
		wordRefs: [],
		origin: "user",
		...overrides,
	};
}

describe("buildAutoZoomSuggestionsForClips", () => {
	it("projects source telemetry into a clip's virtual timeline", () => {
		const suggestions = buildAutoZoomSuggestionsForClips({
			cursorTelemetry: dwell(2000, 0.3, 0.7),
			clips: [
				clip({
					id: "clip_1",
					sourceStartSec: 1,
					sourceEndSec: 4,
					timelineStartSec: 10,
					timelineEndSec: 13,
				}),
			],
			existingRegions: [],
			defaultDurationMs: 1000,
		});

		expect(suggestions).toHaveLength(1);
		expect(suggestions[0].span).toEqual({ start: 10500, end: 11500 });
		expect(suggestions[0].focus.cx).toBeCloseTo(0.3, 5);
		expect(suggestions[0].focus.cy).toBeCloseTo(0.7, 5);
	});

	it("projects each clip independently and skips clips with unknown source ends", () => {
		const suggestions = buildAutoZoomSuggestionsForClips({
			cursorTelemetry: [...dwell(1000, 0.2, 0.2), ...dwell(6000, 0.8, 0.8)],
			clips: [
				clip({
					id: "clip_2",
					sourceStartSec: 5,
					sourceEndSec: 8,
					timelineStartSec: 10,
					timelineEndSec: 13,
				}),
				clip({
					id: "unknown",
					sourceStartSec: 8,
					sourceEndSec: undefined,
					timelineStartSec: 20,
					timelineEndSec: 25,
				}),
				clip({
					id: "clip_1",
					sourceStartSec: 0,
					sourceEndSec: 3,
					timelineStartSec: 0,
					timelineEndSec: 3,
				}),
			],
			existingRegions: [],
			defaultDurationMs: 1000,
		});

		expect(suggestions.map((suggestion) => suggestion.span)).toEqual([
			{ start: 500, end: 1500 },
			{ start: 10500, end: 11500 },
		]);
	});

	it("keeps suggestions inside half-open clip source boundaries", () => {
		const suggestions = buildAutoZoomSuggestionsForClips({
			cursorTelemetry: [
				{ timeMs: 500, cx: 0.4, cy: 0.4 },
				{ timeMs: 1000, cx: 0.4, cy: 0.4 },
			],
			clips: [clip({ id: "clip_1", sourceEndSec: 1, timelineEndSec: 1 })],
			existingRegions: [],
			defaultDurationMs: 500,
		});

		expect(suggestions).toEqual([]);
	});

	it("drops a projected suggestion that overlaps an existing virtual zoom", () => {
		const suggestions = buildAutoZoomSuggestionsForClips({
			cursorTelemetry: dwell(2000, 0.3, 0.7),
			clips: [
				clip({
					id: "clip_1",
					sourceStartSec: 1,
					sourceEndSec: 4,
					timelineStartSec: 10,
					timelineEndSec: 13,
				}),
			],
			existingRegions: [{ startMs: 10900, endMs: 11100 }],
			defaultDurationMs: 1000,
		});

		expect(suggestions).toEqual([]);
	});

	it("clamps processing to the shorter source or virtual clip duration", () => {
		const suggestions = buildAutoZoomSuggestionsForClips({
			cursorTelemetry: dwell(2800, 0.5, 0.5),
			clips: [
				clip({
					id: "clip_1",
					sourceStartSec: 0,
					sourceEndSec: 4,
					timelineStartSec: 5,
					timelineEndSec: 7,
				}),
			],
			existingRegions: [],
			defaultDurationMs: 1000,
		});

		expect(suggestions).toEqual([]);
	});
});
