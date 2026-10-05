import { describe, expect, it } from "vitest";
import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import type { ClickCue } from "./clickSound";
import {
	buildClickCues,
	clickCuesFitTake,
	crossedClickHits,
	levelClickCues,
	placeClickHits,
} from "./clickSound";

const point = (
	timeMs: number,
	interactionType: CursorTelemetryPoint["interactionType"],
): CursorTelemetryPoint => ({
	timeMs,
	cx: 0.5,
	cy: 0.5,
	interactionType,
});

const cue = (timeSec: number) => ({ timeSec, gain: 1, release: false });

describe("buildClickCues", () => {
	it("turns one click into a press plus its recorded release, and ignores moves", () => {
		const cues = buildClickCues([
			point(1000, "move"),
			point(7056, "click"),
			point(7123, "mouseup"),
			point(9000, "move"),
		]);
		expect(cues).toEqual([
			{ timeSec: 7.056, gain: 1, release: false },
			{ timeSec: 7.123, gain: 0.7, release: true },
		]);
	});

	it("adds a second press for a double click", () => {
		const cues = buildClickCues([point(300, "double-click"), point(360, "mouseup")]);
		expect(cues.map((c) => [c.timeSec, c.release])).toEqual([
			[0.3, false],
			[0.36, true],
			[0.39, false],
		]);
	});

	it("quiets right and middle clicks", () => {
		const [press] = buildClickCues([point(500, "right-click"), point(560, "mouseup")]);
		expect(press.gain).toBeCloseTo(0.85);
	});

	it("falls back to a synthetic release when the recorded one is too far away", () => {
		const cues = buildClickCues([point(1000, "click"), point(3000, "mouseup")]);
		expect(cues[1]).toEqual({ timeSec: 1.11, gain: 0.7, release: true });
	});

	it("pairs the release even when the samples arrive out of order", () => {
		const cues = buildClickCues([point(2070, "mouseup"), point(2000, "click")]);
		expect(cues.map((c) => c.timeSec)).toEqual([2, 2.07]);
	});
});

describe("placeClickHits", () => {
	const asset = { id: "asset_1", kind: "video", originalPath: "/t.mp4", durationSec: 10 };
	const clip = (over: Record<string, number> = {}) => ({
		id: "clip_1",
		assetId: "asset_1",
		timelineStartSec: 0,
		timelineEndSec: 10,
		sourceStartSec: 0,
		sourceEndSec: 10,
		...over,
	});
	const doc = (clips: unknown[], speedRegions: unknown[] = [], trimRanges: unknown[] = []) =>
		({
			project: { primaryAssetId: "asset_1" },
			assets: [asset],
			audioTracks: [],
			timeline: { clips, trimRanges, speedRanges: [] },
			// Speed regions live on the legacy envelope — `readSpeedRegions` is the only reader.
			legacyEditor: { speedRegions },
		}) as never;
	const at = (document: never, cues: ClickCue[], take = asset) =>
		placeClickHits(document, take as never, cues).map((hit) => hit.timeSec);

	it("is the identity for an untouched single take", () => {
		expect(at(doc([clip()]), [cue(7.25)])).toEqual([7.25]);
	});

	it("moves a click into the compressed programme a 2x region makes", () => {
		// Raw 2..4 at 2x: the click at 3 s is heard at 2.5 s, the one at 5 s at 4 s. This is the
		// arithmetic an imported audio track cannot do — its content is placed, never stretched.
		expect(
			at(doc([clip()], [{ startMs: 2000, endMs: 4000, speed: 2 }]), [cue(1), cue(3), cue(5)]),
		).toEqual([1, 2.5, 4]);
	});

	it("follows the clip the take sits on rather than ruler zero", () => {
		// The take trimmed to start 2 s into the recording: the click recorded at 2.5 s of the
		// recording is half a second into the film, and a click before the trim is never on
		// screen at all. (The programme is the clips concatenated, so the clip's own timeline
		// position is not part of it — see `projectRawTimelineSecToPlayback`.)
		expect(
			at(doc([clip({ timelineStartSec: 30, timelineEndSec: 38, sourceStartSec: 2 })]), [
				cue(2.5),
				cue(1.5),
			]),
		).toEqual([0.5]);
	});

	it("drops a click the cut took out of the film and pulls the later ones up", () => {
		const trim = {
			id: "trim_1",
			assetId: "asset_1",
			clipId: "clip_1",
			startSec: 2,
			endSec: 4,
			origin: "user",
		};
		expect(at(doc([clip()], [], [trim]), [cue(1), cue(3), cue(5)])).toEqual([1, 3]);
	});
});

describe("levelClickCues", () => {
	it("scales every cue by the level the user set, and leaves 0 dB alone", () => {
		const cues = [cue(1), { timeSec: 2, gain: 0.85, release: true }];
		// The very same list at unity: nothing is rebuilt, so the cache stays the cache.
		expect(levelClickCues(cues, 0)).toBe(cues);
		const louder = levelClickCues(cues, 6);
		expect(louder[0].gain).toBeCloseTo(1.995, 3);
		expect(louder[1].gain).toBeCloseTo(1.696, 3);
		expect(louder[1].release).toBe(true);
	});
});

describe("clickCuesFitTake", () => {
	it("goes silent only on a known mismatch of takes", () => {
		expect(clickCuesFitTake("/t/a.mp4", "/t/a.mp4")).toBe(true);
		expect(clickCuesFitTake("/t/a.mp4", "/t/b.mp4")).toBe(false);
		// A source whose path is not resolved yet, and a document with no cues stashed, are not
		// mismatches: neither is a reason to stop hearing the sound.
		expect(clickCuesFitTake("/t/a.mp4", undefined)).toBe(true);
		expect(clickCuesFitTake(undefined, "/t/b.mp4")).toBe(true);
	});
});

describe("crossedClickHits", () => {
	const cues = [cue(1), cue(2.02), cue(3)];

	it("fires the hits between two readings of the playhead", () => {
		expect(crossedClickHits(cues, 1.99, 2.05).map((c) => c.timeSec)).toEqual([2.02]);
	});

	it("fires nothing across a seek, which is a jump too big for one frame", () => {
		expect(crossedClickHits(cues, 0.5, 2.5)).toEqual([]);
	});

	it("fires nothing on a move backwards, and consumes nothing", () => {
		expect(crossedClickHits(cues, 3, 1)).toEqual([]);
		// Rewound and played again, the same clicks are still there to cross.
		expect(crossedClickHits(cues, 0.95, 1.01).map((c) => c.timeSec)).toEqual([1]);
	});

	it("fires nothing before the playhead has a position to compare with", () => {
		expect(crossedClickHits(cues, Number.NaN, 1)).toEqual([]);
	});
});
