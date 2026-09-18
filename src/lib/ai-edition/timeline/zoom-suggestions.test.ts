import { describe, expect, it } from "vitest";
import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import type { AxcutClip } from "../schema";
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

// A click = a single sample carrying recorded interaction metadata (issue #699).
function click(
	timeMs: number,
	cx: number,
	cy: number,
	interactionType: CursorTelemetryPoint["interactionType"] = "click",
): CursorTelemetryPoint {
	return { timeMs, cx, cy, interactionType };
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

describe("recorded clicks (issue #699)", () => {
	// A fast sweep forms no dwell; before #699 this take produced no suggestion at all.
	const sweepWithClickAt = (clickIndex: number): CursorTelemetryPoint[] =>
		Array.from({ length: 10 }, (_, i) => ({
			timeMs: i * 500,
			cx: i / 10,
			cy: i / 10,
			interactionType: i === clickIndex ? "click" : "move",
		}));

	it("zooms on a click made while the pointer is still moving", () => {
		const suggestions = buildAutoZoomSuggestions({
			cursorTelemetry: sweepWithClickAt(4),
			totalMs: 5000,
			existingRegions: [],
			defaultDurationMs: 2000,
		});
		expect(suggestions).toHaveLength(1);
		expect(suggestions[0].focus).toEqual({ cx: 0.4, cy: 0.4 });
		expect(suggestions[0].span).toEqual({ start: 1000, end: 3000 });
	});

	it("focuses the zoom on the click sample, not the pointer's average position", () => {
		// The pointer flew to a toolbar button, clicked, flew back.
		const suggestions = buildAutoZoomSuggestions({
			cursorTelemetry: [
				{ timeMs: 1000, cx: 0.1, cy: 0.9 },
				click(1200, 0.8, 0.2),
				{ timeMs: 1400, cx: 0.12, cy: 0.88 },
			],
			totalMs: 5000,
			existingRegions: [],
			defaultDurationMs: 2000,
		});
		expect(suggestions).toHaveLength(1);
		expect(suggestions[0].focus).toEqual({ cx: 0.8, cy: 0.2 });
		expect(suggestions[0].span).toEqual({ start: 200, end: 2200 });
	});

	it("accepts every click kind the telemetry records", () => {
		for (const kind of ["click", "double-click", "right-click", "middle-click"] as const) {
			const suggestions = buildAutoZoomSuggestions({
				cursorTelemetry: [click(2000, 0.3, 0.7, kind), { timeMs: 4000, cx: 0.4, cy: 0.6 }],
				totalMs: 5000,
				existingRegions: [],
				defaultDurationMs: 2000,
			});
			expect(suggestions, kind).toHaveLength(1);
			expect(suggestions[0].focus).toEqual({ cx: 0.3, cy: 0.7 });
		}
	});

	it("ignores move and mouseup — they are not clicks", () => {
		const telemetry: CursorTelemetryPoint[] = Array.from({ length: 10 }, (_, i) => ({
			timeMs: i * 500,
			cx: i / 10,
			cy: i / 10,
			interactionType: i === 4 ? "mouseup" : "move",
		}));
		expect(
			buildAutoZoomSuggestions({
				cursorTelemetry: telemetry,
				totalMs: 5000,
				existingRegions: [],
				defaultDurationMs: 2000,
			}),
		).toEqual([]);
	});

	it("folds a nearby dwell into the click so one moment yields ONE zoom", () => {
		// The dwell run 1550..2270ms centres on 1910ms — 490ms from the click at 2400ms,
		// inside SUGGESTION_SPACING_MS. The click's own time and position anchor the zoom.
		const suggestions = buildAutoZoomSuggestions({
			cursorTelemetry: [...dwell(2000, 0.2, 0.8), click(2400, 0.3, 0.75)],
			totalMs: 6000,
			existingRegions: [],
			defaultDurationMs: 2000,
		});
		expect(suggestions).toHaveLength(1);
		expect(suggestions[0].focus).toEqual({ cx: 0.3, cy: 0.75 });
		expect(suggestions[0].span).toEqual({ start: 1400, end: 3400 });
	});

	it("keeps a dwell that sits clear of the click, and both survive", () => {
		const suggestions = buildAutoZoomSuggestions({
			cursorTelemetry: [...dwell(2000, 0.2, 0.8), click(6000, 0.9, 0.1)],
			totalMs: 9000,
			existingRegions: [],
			defaultDurationMs: 1500,
		});
		// Nobody conflicts here, so the output order is an acceptance-order detail;
		// compare the SET of spans and the click-anchored focus.
		const spans = suggestions.map((s) => s.span).sort((a, b) => a.start - b.start);
		expect(spans).toEqual([
			{ start: 1250, end: 2750 },
			{ start: 5250, end: 6750 },
		]);
		expect(suggestions.find((s) => s.span.start === 5250)?.focus).toEqual({ cx: 0.9, cy: 0.1 });
		expect(suggestions.find((s) => s.span.start === 1250)?.focus.cx).toBeCloseTo(0.2, 5);
	});

	it("collapses a rapid burst of clicks into the first click's zoom", () => {
		const suggestions = buildAutoZoomSuggestions({
			cursorTelemetry: [click(1000, 0.2, 0.2), click(1500, 0.25, 0.25)],
			totalMs: 5000,
			existingRegions: [],
			defaultDurationMs: 2000,
		});
		expect(suggestions).toHaveLength(1);
		expect(suggestions[0].focus).toEqual({ cx: 0.2, cy: 0.2 });
		expect(suggestions[0].span).toEqual({ start: 0, end: 2000 });
	});

	it("still drops a click that overlaps an existing zoom region", () => {
		expect(
			buildAutoZoomSuggestions({
				cursorTelemetry: [click(2000, 0.5, 0.5), { timeMs: 4000, cx: 0.6, cy: 0.4 }],
				totalMs: 5000,
				existingRegions: [{ startMs: 1500, endMs: 2500 }],
				defaultDurationMs: 2000,
			}),
		).toEqual([]);
	});

	it("keeps the dwell-only behaviour when the take records no clicks", () => {
		// A dwell annotated only with move/mouseup: no click candidate, exactly the
		// pre-#699 result — and the mouseup does not break the still run either.
		const dwellRun = dwell(2000, 0.5, 0.5).map((sample, i) => ({
			...sample,
			interactionType: (i === 3 ? "mouseup" : "move") as "mouseup" | "move",
		}));
		const suggestions = buildAutoZoomSuggestions({
			cursorTelemetry: dwellRun,
			totalMs: 5000,
			existingRegions: [],
			defaultDurationMs: 2000,
		});
		expect(suggestions).toHaveLength(1);
		expect(suggestions[0].span).toEqual({ start: 1000, end: 3000 });
	});

	it("clamps a click near the start or end of the take to the ruler", () => {
		const suggestions = buildAutoZoomSuggestions({
			cursorTelemetry: [click(100, 0.1, 0.1), click(4800, 0.9, 0.9)],
			totalMs: 5000,
			existingRegions: [],
			defaultDurationMs: 2000,
		});
		expect(suggestions.map((s) => s.span)).toEqual([
			{ start: 0, end: 2000 },
			{ start: 3000, end: 5000 },
		]);
	});

	it("keeps the dwell fallback when an existing region rejects only the nearby click", () => {
		// The click at 2700ms sits inside SUGGESTION_SPACING_MS of the dwell at 1000ms,
		// but the existing region 2300..2400 overlaps only the CLICK's span. The click
		// is rejected, and a rejected click must leave the dwell standing: one zoom at
		// the dwell, not zero. (The first cut of this PR removed the dwell up front and
		// returned nothing here.)
		const suggestions = buildAutoZoomSuggestions({
			cursorTelemetry: [...dwell(1000, 0.2, 0.8), click(2700, 0.6, 0.4)],
			totalMs: 5000,
			existingRegions: [{ startMs: 2300, endMs: 2400 }],
			defaultDurationMs: 1000,
		});
		expect(suggestions).toHaveLength(1);
		expect(suggestions[0].span).toEqual({ start: 500, end: 1500 });
		expect(suggestions[0].focus.cx).toBeCloseTo(0.2, 5);
		expect(suggestions[0].focus.cy).toBeCloseTo(0.8, 5);
	});

	it("lets a second click survive the first being rejected by an existing region", () => {
		// Two clicks within spacing of each other; only the first's span overlaps the
		// existing region. The rejected first click must not suppress the second.
		const suggestions = buildAutoZoomSuggestions({
			cursorTelemetry: [click(1000, 0.2, 0.2), click(2400, 0.8, 0.8)],
			totalMs: 5000,
			existingRegions: [{ startMs: 700, endMs: 1300 }],
			defaultDurationMs: 1000,
		});
		expect(suggestions).toHaveLength(1);
		expect(suggestions[0].focus).toEqual({ cx: 0.8, cy: 0.8 });
		expect(suggestions[0].span).toEqual({ start: 1900, end: 2900 });
	});

	it("zooms a take whose telemetry is a single recorded click", () => {
		const suggestions = buildAutoZoomSuggestions({
			cursorTelemetry: [click(2000, 0.3, 0.7)],
			totalMs: 5000,
			existingRegions: [],
			defaultDurationMs: 2000,
		});
		expect(suggestions).toHaveLength(1);
		expect(suggestions[0].focus).toEqual({ cx: 0.3, cy: 0.7 });
		expect(suggestions[0].span).toEqual({ start: 1000, end: 3000 });
	});

	it("returns nothing for a single move or mouseup sample", () => {
		for (const kind of ["move", "mouseup"] as const) {
			expect(
				buildAutoZoomSuggestions({
					cursorTelemetry: [{ timeMs: 2000, cx: 0.3, cy: 0.7, interactionType: kind }],
					totalMs: 5000,
					existingRegions: [],
					defaultDurationMs: 2000,
				}),
				kind,
			).toEqual([]);
		}
	});
});

describe("buildAutoZoomSuggestionsForClips", () => {
	const clip = (
		id: string,
		assetId: string,
		sourceStartSec: number,
		sourceEndSec: number,
		timelineStartSec: number,
	): AxcutClip => ({
		id,
		assetId,
		sourceStartSec,
		sourceEndSec,
		timelineStartSec,
		timelineEndSec: timelineStartSec + (sourceEndSec - sourceStartSec),
		wordRefs: [],
		origin: "user",
		reason: "",
	});

	// The bug this covers: telemetry is in the recording's SOURCE time, zoom regions are
	// authored in RAW TIMELINE ms, and the two only coincide for a single clip starting at
	// 0. Every other layout put all the zooms on the first clip's stretch of ruler.
	it("gives a dwell to EVERY clip that replays it, not just the first", () => {
		// One recording, laid down twice: source 0-10 at ruler 0-10, then again at 10-20.
		const clips = [clip("clip_1", "a1", 0, 10, 0), clip("clip_2", "a1", 0, 10, 10)];
		const suggestions = buildAutoZoomSuggestionsForClips({
			cursorTelemetry: dwell(4000, 0.3, 0.7),
			assetId: "a1",
			clips,
			existingRegions: [],
			defaultDurationMs: 2000,
		});
		expect(suggestions.map((s) => s.span)).toEqual([
			{ start: 3000, end: 5000 }, // clip_1: source 4s sits at ruler 4s
			{ start: 13000, end: 15000 }, // clip_2: the SAME source 4s sits at ruler 14s
		]);
		for (const suggestion of suggestions) {
			expect(suggestion.focus.cx).toBeCloseTo(0.3, 5);
			expect(suggestion.focus.cy).toBeCloseTo(0.7, 5);
		}
	});

	it("shifts a dwell by the clip's own source in-point", () => {
		// A clip that starts 30s into the recording: source 34s is ruler 4s.
		const clips = [clip("clip_1", "a1", 30, 40, 0)];
		const suggestions = buildAutoZoomSuggestionsForClips({
			cursorTelemetry: dwell(34000, 0.5, 0.5),
			assetId: "a1",
			clips,
			existingRegions: [],
			defaultDurationMs: 2000,
		});
		expect(suggestions.map((s) => s.span)).toEqual([{ start: 3000, end: 5000 }]);
	});

	it("ignores a dwell that falls outside every clip's source window", () => {
		// The recording is long; the timeline keeps only its first 10s.
		const clips = [clip("clip_1", "a1", 0, 10, 0)];
		expect(
			buildAutoZoomSuggestionsForClips({
				cursorTelemetry: dwell(45000, 0.5, 0.5),
				assetId: "a1",
				clips,
				existingRegions: [],
				defaultDurationMs: 2000,
			}),
		).toEqual([]);
	});

	it("reserves an existing zoom on the clip it actually sits on, and only there", () => {
		// A zoom already covers the dwell on clip_1's ruler span. clip_1 yields; clip_2
		// replays the same source moment on a free stretch of ruler, so it still gets one.
		// Compared in source ms — the frame the caller used to hand down — that one region
		// suppressed the whole recording's worth of suggestions.
		const clips = [clip("clip_1", "a1", 0, 10, 0), clip("clip_2", "a1", 0, 10, 10)];
		const suggestions = buildAutoZoomSuggestionsForClips({
			cursorTelemetry: dwell(4000, 0.5, 0.5),
			assetId: "a1",
			clips,
			existingRegions: [{ startMs: 3500, endMs: 4500 }],
			defaultDurationMs: 2000,
		});
		expect(suggestions.map((s) => s.span)).toEqual([{ start: 13000, end: 15000 }]);
	});

	it("only reads the clips of the asset the telemetry belongs to", () => {
		const clips = [clip("clip_1", "a1", 0, 10, 0), clip("clip_2", "a2", 0, 10, 10)];
		const suggestions = buildAutoZoomSuggestionsForClips({
			cursorTelemetry: dwell(4000, 0.5, 0.5),
			assetId: "a2",
			clips,
			existingRegions: [],
			defaultDurationMs: 2000,
		});
		expect(suggestions.map((s) => s.span)).toEqual([{ start: 13000, end: 15000 }]);
	});

	it("skips a clip whose duration has not been probed yet", () => {
		const clips = [clip("clip_1", "a1", 0, 0, 0)];
		expect(
			buildAutoZoomSuggestionsForClips({
				cursorTelemetry: dwell(4000, 0.5, 0.5),
				assetId: "a1",
				clips,
				existingRegions: [],
				defaultDurationMs: 2000,
			}),
		).toEqual([]);
	});

	// Clicks ride the same per-clip projection dwells do (issue #699).
	it("gives a recorded click the same per-clip projection a dwell gets", () => {
		// A clip that starts 30s into the recording: a click at source 34s is ruler 4s.
		const clips = [clip("clip_1", "a1", 30, 40, 0)];
		const suggestions = buildAutoZoomSuggestionsForClips({
			cursorTelemetry: [click(34000, 0.5, 0.5), { timeMs: 36000, cx: 0.6, cy: 0.4 }],
			assetId: "a1",
			clips,
			existingRegions: [],
			defaultDurationMs: 2000,
		});
		expect(suggestions.map((s) => s.span)).toEqual([{ start: 3000, end: 5000 }]);
		expect(suggestions[0].focus).toEqual({ cx: 0.5, cy: 0.5 });
	});

	it("gives a click to EVERY clip that replays it, one shifted span each", () => {
		const clips = [clip("clip_1", "a1", 0, 10, 0), clip("clip_2", "a1", 0, 10, 10)];
		const suggestions = buildAutoZoomSuggestionsForClips({
			cursorTelemetry: [click(4000, 0.3, 0.7), { timeMs: 6000, cx: 0.4, cy: 0.6 }],
			assetId: "a1",
			clips,
			existingRegions: [],
			defaultDurationMs: 2000,
		});
		expect(suggestions.map((s) => s.span)).toEqual([
			{ start: 3000, end: 5000 },
			{ start: 13000, end: 15000 },
		]);
		for (const suggestion of suggestions) {
			expect(suggestion.focus.cx).toBeCloseTo(0.3, 5);
			expect(suggestion.focus.cy).toBeCloseTo(0.7, 5);
		}
	});

	it("zooms a clip whose source window trims the telemetry down to a single click", () => {
		// A clip covering 30..40s of the recording; the take's telemetry holds one move
		// long before the window and one click inside it. The per-clip filter hands the
		// detector a SINGLE sample — still a zoom, correctly projected (source 34s is
		// ruler 4s).
		const clips = [clip("clip_1", "a1", 30, 40, 0)];
		const suggestions = buildAutoZoomSuggestionsForClips({
			cursorTelemetry: [{ timeMs: 5000, cx: 0.1, cy: 0.9 }, click(34000, 0.5, 0.5)],
			assetId: "a1",
			clips,
			existingRegions: [],
			defaultDurationMs: 2000,
		});
		expect(suggestions.map((s) => s.span)).toEqual([{ start: 3000, end: 5000 }]);
		expect(suggestions[0].focus).toEqual({ cx: 0.5, cy: 0.5 });
	});
});
