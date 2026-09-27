import { describe, expect, it } from "vitest";
import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import type { AxcutClip } from "../schema";
import { buildAutoZoomSuggestions, buildAutoZoomSuggestionsForClips } from "./zoom-suggestions";

// A click = a single sample carrying recorded interaction metadata (issue #699).
function click(
	timeMs: number,
	cx: number,
	cy: number,
	interactionType: CursorTelemetryPoint["interactionType"] = "click",
): CursorTelemetryPoint {
	return { timeMs, cx, cy, interactionType };
}

// The pointer parked in one place, with no click.
function park(centerMs: number, cx: number, cy: number, count = 6, spanMs = 900) {
	const step = spanMs / (count - 1);
	return Array.from({ length: count }, (_, i) => ({
		timeMs: centerMs - spanMs / 2 + i * step,
		cx,
		cy,
	}));
}

const plan = (cursorTelemetry: CursorTelemetryPoint[], totalMs = 5000) =>
	buildAutoZoomSuggestions({ cursorTelemetry, totalMs, existingRegions: [] });

describe("buildAutoZoomSuggestions: which clicks count", () => {
	it("ignores a click made while the cursor is hidden", () => {
		expect(plan([{ ...click(2000, 0.5, 0.5), visible: false }])).toEqual([]);
	});

	it("ignores a visible mouse-down when the cursor hides during that drag", () => {
		const suggestions = plan([
			{ ...click(1000, 0.5, 0.5), visible: true },
			{ timeMs: 1016, cx: 0.5, cy: 0.5, visible: false, interactionType: "move" },
			{ timeMs: 1600, cx: 0.7, cy: 0.5, visible: false, interactionType: "mouseup" },
		]);
		expect(suggestions).toEqual([]);
	});

	it("keeps a click released before the cursor later hides", () => {
		const suggestions = plan([
			{ ...click(1000, 0.5, 0.5), visible: true },
			{ timeMs: 1050, cx: 0.5, cy: 0.5, visible: true, interactionType: "mouseup" },
			{ timeMs: 1400, cx: 0.5, cy: 0.5, visible: false, interactionType: "move" },
		]);
		expect(suggestions.map((s) => s.focus)).toEqual([{ cx: 0.5, cy: 0.5 }]);
	});

	it("keeps a later visible click after a hidden drag", () => {
		const suggestions = plan(
			[
				{ ...click(1000, 0.5, 0.5), visible: true },
				{ timeMs: 1100, cx: 0.6, cy: 0.5, visible: false, interactionType: "move" },
				{ timeMs: 1600, cx: 0.7, cy: 0.5, visible: true, interactionType: "mouseup" },
				{ ...click(4000, 0.2, 0.8), visible: true },
			],
			6000,
		);
		expect(suggestions.map((s) => s.focus)).toEqual([{ cx: 0.2, cy: 0.8 }]);
	});

	it("keeps a legacy click without mouseup when the cursor hides much later", () => {
		const suggestions = plan(
			[
				{ ...click(1000, 0.2, 0.8), visible: true },
				{ timeMs: 1050, cx: 0.3, cy: 0.7, visible: true, interactionType: "move" },
				{ timeMs: 2000, cx: 0.7, cy: 0.3, visible: false, interactionType: "move" },
			],
			4000,
		);
		expect(suggestions.map((s) => s.focus)).toEqual([{ cx: 0.2, cy: 0.8 }]);
	});

	it("rejects a legacy click when the cursor hides on the next sampler tick", () => {
		const suggestions = plan(
			[
				{ ...click(1000, 0.2, 0.8), visible: true },
				{ timeMs: 1033, cx: 0.25, cy: 0.75, visible: false, interactionType: "move" },
			],
			4000,
		);
		expect(suggestions).toEqual([]);
	});

	it("keeps a tap whose release shares its press sample when the cursor hides later", () => {
		// The take records mouse-ups, but the second tap was released within one sampler tick.
		const suggestions = plan(
			[
				{ ...click(500, 0.8, 0.2), visible: true },
				{ timeMs: 600, cx: 0.8, cy: 0.2, visible: true, interactionType: "mouseup" },
				{ ...click(9000, 0.2, 0.8), visible: true },
				{ timeMs: 9500, cx: 0.2, cy: 0.8, visible: false, interactionType: "move" },
			],
			12000,
		);
		expect(suggestions.map((s) => s.focus)).toEqual([
			{ cx: 0.8, cy: 0.2 },
			{ cx: 0.2, cy: 0.8 },
		]);
	});

	it("keeps a click whose mouse-up sample is already hidden", () => {
		// Released, then typing hid the pointer before the next sampler tick.
		const suggestions = plan(
			[
				{ ...click(1000, 0.5, 0.5), visible: true },
				{ timeMs: 1033, cx: 0.5, cy: 0.5, visible: false, interactionType: "mouseup" },
			],
			4000,
		);
		expect(suggestions.map((s) => s.focus)).toEqual([{ cx: 0.5, cy: 0.5 }]);
	});

	it("accepts every click kind the telemetry records", () => {
		for (const kind of ["click", "double-click", "right-click", "middle-click"] as const) {
			const suggestions = plan([click(2000, 0.3, 0.7, kind), { timeMs: 4000, cx: 0.4, cy: 0.6 }]);
			expect(
				suggestions.map((s) => s.focus),
				kind,
			).toEqual([{ cx: 0.3, cy: 0.7 }]);
		}
	});

	it("ignores move and mouseup: they are not clicks", () => {
		const telemetry: CursorTelemetryPoint[] = Array.from({ length: 10 }, (_, i) => ({
			timeMs: i * 500,
			cx: i / 10,
			cy: i / 10,
			interactionType: i === 4 ? "mouseup" : "move",
		}));
		expect(plan(telemetry)).toEqual([]);
	});

	it("places no zoom where the pointer only sits still", () => {
		expect(plan(park(2000, 0.5, 0.5))).toEqual([]);
	});

	it("returns nothing without telemetry, or for a lone move or mouseup", () => {
		expect(plan([])).toEqual([]);
		for (const kind of ["move", "mouseup"] as const) {
			expect(plan([{ timeMs: 2000, cx: 0.3, cy: 0.7, interactionType: kind }]), kind).toEqual([]);
		}
	});
});

describe("buildAutoZoomSuggestions: shots", () => {
	it("is fully in half a second before the click and holds 1.5 s after it", () => {
		// A fast sweep: the click is made while the pointer is still moving.
		const telemetry: CursorTelemetryPoint[] = Array.from({ length: 10 }, (_, i) => ({
			timeMs: i * 500,
			cx: i / 10,
			cy: i / 10,
			interactionType: i === 4 ? "click" : "move",
		}));
		expect(plan(telemetry)).toEqual([
			{ span: { start: 1500, end: 3500 }, focus: { cx: 0.4, cy: 0.4 }, depth: 3 },
		]);
	});

	it("focuses the zoom on the click, not on the pointer's path", () => {
		// The pointer flew to a toolbar button, clicked, flew back.
		const suggestions = plan([
			{ timeMs: 1000, cx: 0.1, cy: 0.9 },
			click(1200, 0.8, 0.2),
			{ timeMs: 1400, cx: 0.12, cy: 0.88 },
		]);
		expect(suggestions.map((s) => [s.span, s.focus])).toEqual([
			[
				{ start: 700, end: 2700 },
				{ cx: 0.8, cy: 0.2 },
			],
		]);
	});

	it("frames a burst of nearby clicks with one zoom that holds through it", () => {
		const suggestions = plan(
			[click(2000, 0.3, 0.3), click(3500, 0.36, 0.33), click(5000, 0.4, 0.35)],
			9000,
		);
		expect(suggestions).toHaveLength(1);
		expect(suggestions[0].span).toEqual({ start: 1500, end: 6500 });
		expect(suggestions[0].depth).toBe(3);
		expect(suggestions[0].focus.cx).toBeCloseTo(0.35, 5);
		expect(suggestions[0].focus.cy).toBeCloseTo(0.325, 5);
	});

	it("zooms in less when the clicks it frames spread wider", () => {
		// With a 12% margin each side, 0.35 of the frame fits at 1.5× and 0.5 only at 1.25×.
		const wider = plan([click(2000, 0.2, 0.5), click(3000, 0.55, 0.5)], 9000);
		expect(wider.map((s) => [s.span, s.depth])).toEqual([[{ start: 1500, end: 4500 }, 2]]);
		const widest = plan([click(2000, 0.2, 0.5), click(3000, 0.7, 0.5)], 9000);
		expect(widest.map((s) => s.depth)).toEqual([1]);
	});

	it("never zooms straight back: of two clashing zooms, the one with more clicks stays", () => {
		// Too far apart to share a zoom, too close in time for a wide shot between them.
		const suggestions = plan(
			[click(2000, 0.1, 0.1), click(2600, 0.12, 0.12), click(3200, 0.9, 0.9)],
			9000,
		);
		expect(suggestions.map((s) => s.span)).toEqual([{ start: 1500, end: 4100 }]);
	});

	it("holds one zoom through a gap too short for a wide shot, when its clicks fit together", () => {
		// 4 s apart: two groups, but coming back out and in within 2 s would read as a yo-yo.
		const suggestions = plan([click(2000, 0.3, 0.3), click(6000, 0.34, 0.3)], 9000);
		expect(suggestions.map((s) => [s.span, s.depth])).toEqual([[{ start: 1500, end: 7500 }, 3]]);
	});

	it("leaves a real wide shot between two zooms", () => {
		const suggestions = plan([click(2000, 0.1, 0.1), click(9000, 0.9, 0.9)], 12000);
		expect(suggestions.map((s) => s.span)).toEqual([
			{ start: 1500, end: 3500 },
			{ start: 8500, end: 10500 },
		]);
	});

	it("keeps clear of a zoom already on the timeline, its ramps and a wide shot included", () => {
		const existingRegions = [{ startMs: 3000, endMs: 5000 }];
		const near = buildAutoZoomSuggestions({
			cursorTelemetry: [click(7000, 0.5, 0.5)],
			totalMs: 12000,
			existingRegions,
		});
		expect(near).toEqual([]);
		const clear = buildAutoZoomSuggestions({
			cursorTelemetry: [click(9000, 0.5, 0.5)],
			totalMs: 12000,
			existingRegions,
		});
		expect(clear.map((s) => s.span)).toEqual([{ start: 8500, end: 10500 }]);
	});

	it("keeps clear of a placed zoom that reaches past the next one", () => {
		// Two placed zooms overlap: the long one still covers the click after the short one ends.
		const suggestions = buildAutoZoomSuggestions({
			cursorTelemetry: [click(12000, 0.5, 0.5)],
			totalMs: 30000,
			existingRegions: [
				{ startMs: 0, endMs: 20000 },
				{ startMs: 5000, endMs: 8000 },
			],
		});
		expect(suggestions).toEqual([]);
	});

	it("measures an existing zoom's ramps at its own depth", () => {
		// A 5× zoom takes 1.5 s to come back out, so the wide shot after it starts later.
		const suggestions = buildAutoZoomSuggestions({
			cursorTelemetry: [click(9000, 0.5, 0.5)],
			totalMs: 12000,
			existingRegions: [{ startMs: 3000, endMs: 5000, scale: 5 }],
		});
		expect(suggestions).toEqual([]);
	});

	it("keeps a zoom for a click at either end of the axis", () => {
		expect(plan([click(100, 0.1, 0.1)]).map((s) => s.span)).toEqual([{ start: 0, end: 1800 }]);
		// Near the end, the zoom arrives earlier rather than holding too briefly.
		expect(plan([click(4800, 0.9, 0.9)]).map((s) => s.span)).toEqual([{ start: 3200, end: 5000 }]);
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
	const telemetryOf = (samples: CursorTelemetryPoint[], assetId = "a1") =>
		new Map([[assetId, samples]]);

	// The bug this covers: telemetry is in the recording's SOURCE time, zoom regions are
	// authored in RAW TIMELINE ms, and the two only coincide for a single clip starting at
	// 0. Every other layout put all the zooms on the first clip's stretch of ruler.
	it("gives a click to EVERY clip that replays it, not just the first", () => {
		// One recording, laid down twice: source 0-10 at ruler 0-10, then again at 10-20.
		const suggestions = buildAutoZoomSuggestionsForClips({
			telemetryByAssetId: telemetryOf([click(4000, 0.3, 0.7), { timeMs: 9500, cx: 0.4, cy: 0.6 }]),
			clips: [clip("clip_1", "a1", 0, 10, 0), clip("clip_2", "a1", 0, 10, 10)],
			existingRegions: [],
		});
		expect(suggestions.map((s) => s.span)).toEqual([
			{ start: 3500, end: 5500 }, // clip_1: source 4s sits at ruler 4s
			{ start: 13500, end: 15500 }, // clip_2: the SAME source 4s sits at ruler 14s
		]);
		for (const suggestion of suggestions) {
			expect(suggestion.focus).toEqual({ cx: 0.3, cy: 0.7 });
		}
	});

	it("shifts a click by the clip's own source in-point", () => {
		// A clip that starts 30s into the recording: source 34s is ruler 4s.
		const suggestions = buildAutoZoomSuggestionsForClips({
			telemetryByAssetId: telemetryOf([
				click(34000, 0.5, 0.5),
				{ timeMs: 60000, cx: 0.6, cy: 0.4 },
			]),
			clips: [clip("clip_1", "a1", 30, 40, 0)],
			existingRegions: [],
		});
		expect(suggestions.map((s) => s.span)).toEqual([{ start: 3500, end: 5500 }]);
	});

	it("ignores a click that falls outside every clip's source window", () => {
		// The recording is long; the timeline keeps only its first 10s.
		const suggestions = buildAutoZoomSuggestionsForClips({
			telemetryByAssetId: telemetryOf([
				click(45000, 0.5, 0.5),
				{ timeMs: 60000, cx: 0.6, cy: 0.4 },
			]),
			clips: [clip("clip_1", "a1", 0, 10, 0)],
			existingRegions: [],
		});
		expect(suggestions).toEqual([]);
	});

	it("reserves an existing zoom on the clip it actually sits on, and only there", () => {
		// A zoom already covers the click on clip_1's ruler span. clip_1 yields; clip_2 replays
		// the same source moment on a free stretch of ruler, so it still gets one.
		const suggestions = buildAutoZoomSuggestionsForClips({
			telemetryByAssetId: telemetryOf([click(4000, 0.5, 0.5), { timeMs: 9500, cx: 0.6, cy: 0.4 }]),
			clips: [clip("clip_1", "a1", 0, 10, 0), clip("clip_2", "a1", 0, 10, 10)],
			existingRegions: [{ startMs: 3500, endMs: 4500 }],
		});
		expect(suggestions.map((s) => s.span)).toEqual([{ start: 13500, end: 15500 }]);
	});

	it("only reads the clips of the recordings it has telemetry for", () => {
		const suggestions = buildAutoZoomSuggestionsForClips({
			telemetryByAssetId: telemetryOf(
				[click(4000, 0.5, 0.5), { timeMs: 9500, cx: 0.6, cy: 0.4 }],
				"a2",
			),
			clips: [clip("clip_1", "a1", 0, 10, 0), clip("clip_2", "a2", 0, 10, 10)],
			existingRegions: [],
		});
		expect(suggestions.map((s) => s.span)).toEqual([{ start: 13500, end: 15500 }]);
	});

	it("skips a clip whose duration has not been probed yet", () => {
		const suggestions = buildAutoZoomSuggestionsForClips({
			telemetryByAssetId: telemetryOf([click(4000, 0.5, 0.5), { timeMs: 9500, cx: 0.6, cy: 0.4 }]),
			clips: [clip("clip_1", "a1", 0, 0, 0)],
			existingRegions: [],
		});
		expect(suggestions).toEqual([]);
	});

	it("zooms a clip whose source window trims the telemetry down to a single click", () => {
		// A clip covering 30..40s of the recording; the take's telemetry holds one move long
		// before the window, one click inside it and one move long after. The per-clip filter
		// hands the planner a SINGLE sample, still a zoom, correctly projected.
		const suggestions = buildAutoZoomSuggestionsForClips({
			telemetryByAssetId: telemetryOf([
				{ timeMs: 5000, cx: 0.1, cy: 0.9 },
				click(34000, 0.5, 0.5),
				{ timeMs: 60000, cx: 0.1, cy: 0.9 },
			]),
			clips: [clip("clip_1", "a1", 30, 40, 0)],
			existingRegions: [],
		});
		expect(suggestions.map((s) => [s.span, s.focus])).toEqual([
			[
				{ start: 3500, end: 5500 },
				{ cx: 0.5, cy: 0.5 },
			],
		]);
	});

	it("does not hold a zoom across a cut: of two clips' clashing zooms, one stays", () => {
		// Two recordings back to back. Each clip's zoom is fine alone, but together they would
		// zoom out at the cut and straight back in, and a zoom does not merge across a cut.
		const suggestions = buildAutoZoomSuggestionsForClips({
			telemetryByAssetId: new Map([
				["a1", [click(7000, 0.5, 0.5), { timeMs: 9900, cx: 0.5, cy: 0.5 }]],
				["a2", [click(1000, 0.5, 0.5), { timeMs: 9900, cx: 0.5, cy: 0.5 }]],
			]),
			clips: [clip("clip_1", "a1", 0, 10, 0), clip("clip_2", "a2", 0, 10, 10)],
			existingRegions: [],
		});
		expect(suggestions.map((s) => s.span)).toEqual([{ start: 6500, end: 8500 }]);
	});

	// The video opens and closes on the whole screen. At depth 3 a ramp lasts 923 ms, so a
	// zoom is fully in at 2500 + 923 → 3424 ms at the earliest, and on a 10 s edit it must be
	// fully in by 10000 − 1000 − 923 → 8076 ms at the latest, to be back out a second early.
	describe("wide opening and ending", () => {
		const restOfTake = { timeMs: 30000, cx: 0.5, cy: 0.5 };

		it("keeps the first seconds of the edit wide: an early click gets no zoom", () => {
			const suggestions = buildAutoZoomSuggestionsForClips({
				telemetryByAssetId: telemetryOf([click(1000, 0.3, 0.3), restOfTake]),
				clips: [clip("clip_1", "a1", 0, 10, 0)],
				existingRegions: [],
			});
			expect(suggestions).toEqual([]);
		});

		it("holds a zoom back until the opening is over when it still covers its click", () => {
			const suggestions = buildAutoZoomSuggestionsForClips({
				telemetryByAssetId: telemetryOf([click(3600, 0.3, 0.3), restOfTake]),
				clips: [clip("clip_1", "a1", 0, 10, 0)],
				existingRegions: [],
			});
			expect(suggestions.map((s) => s.span)).toEqual([{ start: 3424, end: 5224 }]);
		});

		it("brings the last zoom back out a second before the end of the edit", () => {
			// The recording goes on to 30 s, so this is the edit's end at work, not the stop click.
			const zoomed = buildAutoZoomSuggestionsForClips({
				telemetryByAssetId: telemetryOf([click(7500, 0.3, 0.3), restOfTake]),
				clips: [clip("clip_1", "a1", 0, 10, 0)],
				existingRegions: [],
			});
			expect(zoomed.map((s) => s.span)).toEqual([{ start: 6276, end: 8076 }]);
			const tooLate = buildAutoZoomSuggestionsForClips({
				telemetryByAssetId: telemetryOf([click(8500, 0.3, 0.3), restOfTake]),
				clips: [clip("clip_1", "a1", 0, 10, 0)],
				existingRegions: [],
			});
			expect(tooLate).toEqual([]);
		});

		it("lets a clip after a cut open on a zoom: the bounds belong to the edit", () => {
			// One recording laid down twice: the click at source 1 s is inside the opening
			// on the first clip, and at ruler 11 s, clear of it, on the second.
			const suggestions = buildAutoZoomSuggestionsForClips({
				telemetryByAssetId: telemetryOf([
					click(1000, 0.3, 0.3),
					{ timeMs: 9500, cx: 0.5, cy: 0.5 },
				]),
				clips: [clip("clip_1", "a1", 0, 10, 0), clip("clip_2", "a1", 0, 10, 10)],
				existingRegions: [],
			});
			expect(suggestions.map((s) => s.span)).toEqual([{ start: 10500, end: 12500 }]);
		});

		it("ignores the click that stopped the recording", () => {
			// The take's last click, 100 ms before its telemetry ends: the HUD's Stop button.
			// Another clip follows on the ruler, so the edit's own ending does not reach it.
			const suggestions = buildAutoZoomSuggestionsForClips({
				telemetryByAssetId: telemetryOf([
					click(6000, 0.3, 0.3),
					click(19800, 0.5, 0.92),
					{ timeMs: 19900, cx: 0.5, cy: 0.92 },
				]),
				clips: [clip("clip_1", "a1", 0, 20, 0), clip("clip_2", "a2", 0, 20, 20)],
				existingRegions: [],
			});
			expect(suggestions.map((s) => s.focus)).toEqual([{ cx: 0.3, cy: 0.3 }]);
		});

		it("ignores the pointer resting on Stop before that click", () => {
			// Hover-then-Stop: the pointer sits on the button from 18.8 s, clicks at 19.8 s,
			// and the telemetry ends at 19.9 s. Neither the rest nor the click zooms.
			const hover = Array.from({ length: 34 }, (_, i) => ({
				timeMs: 18800 + i * 33,
				cx: 0.5,
				cy: 0.92,
			}));
			const suggestions = buildAutoZoomSuggestionsForClips({
				telemetryByAssetId: telemetryOf([
					click(6000, 0.3, 0.3),
					...hover,
					click(19800, 0.5, 0.92),
					{ timeMs: 19900, cx: 0.5, cy: 0.92 },
				]),
				clips: [clip("clip_1", "a1", 0, 20, 0), clip("clip_2", "a2", 0, 20, 20)],
				existingRegions: [],
			});
			expect(suggestions.map((s) => s.focus)).toEqual([{ cx: 0.3, cy: 0.3 }]);
		});
	});
});
