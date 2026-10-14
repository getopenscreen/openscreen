// Issue #560. A take loses time to a cut and gains it to an insertion, and the two must be
// one walk: resolved in two passes, an insertion's raw moment would be computed without the
// holds before it and land in the wrong place.
//
// The load-bearing property is the demotion: with no insertions this must agree with
// `subtractRemoved` exactly, because that is what the export and the preview already do and
// their answers must not move.

import { describe, expect, it } from "vitest";
import type { AxcutAudioTrack, AxcutClip, AxcutTrimRange } from "../schema";
import { removedRawSpans, subtractRemoved } from "./programme-time";
import { takePlaybackAt, takeProgramme } from "./take-programme";

const CLIPS: AxcutClip[] = [
	{
		id: "c1",
		assetId: "rec",
		sourceStartSec: 0,
		sourceEndSec: 20,
		timelineStartSec: 0,
		timelineEndSec: 20,
		wordRefs: [],
		origin: "user",
		reason: "",
	},
];

const trim = (startSec: number, endSec: number, id = "t1"): AxcutTrimRange =>
	({
		id,
		assetId: "rec",
		clipId: "c1",
		startSec,
		endSec,
		origin: "user",
		reason: "",
	}) as AxcutTrimRange;

/** A take from raw 0 to raw 10, reading its file from the head. */
const TAKE = { startMs: 0, endMs: 10_000, offsetMs: 0 } as Pick<
	AxcutAudioTrack,
	"startMs" | "endMs" | "offsetMs"
>;

describe("takeProgramme", () => {
	it("is exactly subtractRemoved when nothing is inserted", () => {
		// The demotion. Every fixture the export and the preview already agree on has to
		// keep its current answer.
		for (const cuts of [
			[] as AxcutTrimRange[],
			[trim(3, 5)],
			[trim(0, 2)],
			[trim(8, 12)],
			[trim(2, 3), trim(6, 7, "t2")],
		]) {
			const removed = removedRawSpans(CLIPS, cuts);
			const played = takeProgramme(TAKE, removed)
				.filter((p) => p.kind === "play")
				.map((p) => [p.rawStartSec, p.rawEndSec]);
			const expected = subtractRemoved(0, 10, removed).map((s) => [s.startSec, s.endSec]);
			expect(played).toEqual(expected);
		}
	});
});

describe("takePlaybackAt", () => {
	const pieces = takeProgramme(TAKE, removedRawSpans(CLIPS, [trim(7, 8)]));

	it("plays the file where the file plays", () => {
		expect(takePlaybackAt(pieces, 2)).toMatchObject({ targetTimeSec: 2, shouldPlay: true });
	});

	it("has nothing to say outside the take", () => {
		expect(takePlaybackAt(pieces, 12)).toBeNull();
	});

	it("keeps a voiceover recorded against playback aligned after an existing trim", () => {
		const recorded = {
			...TAKE,
			endMs: 13_000,
			recordingPlaybackMap: {
				removedRawSpans: [{ startSec: 5, endSec: 10 }],
				speedRegions: [],
			},
		};
		const playback = takeProgramme(recorded, removedRawSpans(CLIPS, [trim(5, 10)]));

		expect(takePlaybackAt(playback, 7)).toMatchObject({ targetTimeSec: 5, shouldPlay: false });
		expect(takePlaybackAt(playback, 10)).toMatchObject({ targetTimeSec: 5, shouldPlay: true });
		expect(takePlaybackAt(playback, 12)).toMatchObject({ targetTimeSec: 7, shouldPlay: true });
	});

	it("does not compress the source for trims added after recording", () => {
		const recorded = {
			...TAKE,
			endMs: 13_000,
			recordingPlaybackMap: { removedRawSpans: [], speedRegions: [] },
		};
		const playback = takeProgramme(recorded, removedRawSpans(CLIPS, [trim(5, 10)]));

		expect(takePlaybackAt(playback, 7)).toMatchObject({ targetTimeSec: 7, shouldPlay: false });
		expect(takePlaybackAt(playback, 10)).toMatchObject({ targetTimeSec: 10, shouldPlay: true });
		expect(takePlaybackAt(playback, 12)).toMatchObject({ targetTimeSec: 12, shouldPlay: true });
	});

	it("advances recorded source time at the playback rate", () => {
		const recorded = {
			...TAKE,
			endMs: 12_000,
			recordingPlaybackMap: {
				removedRawSpans: [{ startSec: 5, endSec: 10 }],
				speedRegions: [
					{ startMs: 0, endMs: 5000, speed: 2 },
					{ startMs: 10_000, endMs: 12_000, speed: 2 },
				],
			},
		};
		const playback = takeProgramme(recorded, removedRawSpans(CLIPS, [trim(5, 10)]));

		expect(takePlaybackAt(playback, 2)).toMatchObject({ targetTimeSec: 1, shouldPlay: true });
		expect(takePlaybackAt(playback, 7)).toMatchObject({ targetTimeSec: 2.5, shouldPlay: false });
		expect(takePlaybackAt(playback, 11)).toMatchObject({ targetTimeSec: 3, shouldPlay: true });
	});
});

// ─── The preview and the export, held to each other ─────────────────────────
// They read the same walk now, but "the same walk" is a claim about wiring. This walks the
// take frame by frame the way the rAF does and asserts the runs of source time it would
// play are the entries the export emits, piece for piece.
