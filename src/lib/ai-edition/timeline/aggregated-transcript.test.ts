import { describe, expect, it } from "vitest";
import type { AxcutAsset, AxcutClip, AxcutTranscript } from "../schema";
import { buildAggregatedSections, buildClipSection } from "./aggregated-transcript";

function makeClip(overrides: Partial<AxcutClip> = {}): AxcutClip {
	return {
		id: "clip_1",
		assetId: "asset_1",
		sourceStartSec: 0,
		sourceEndSec: 10,
		timelineStartSec: 0,
		timelineEndSec: 10,
		wordRefs: [],
		origin: "system",
		reason: "",
		...overrides,
	};
}

function makeAsset(overrides: Partial<AxcutAsset> = {}): AxcutAsset {
	return {
		id: "asset_1",
		kind: "video",
		label: "demo.mp4",
		originalPath: "/tmp/demo.mp4",
		durationSec: 30,
		...overrides,
	};
}

function makeTranscript(
	overrides: Partial<AxcutTranscript> & { words: AxcutTranscript["words"] },
): AxcutTranscript {
	return {
		assetId: "asset_1",
		language: "en",
		segments: [],
		...overrides,
	};
}

describe("buildClipSection", () => {
	it("marks every word inside the clip range as kept when wordRefs covers all", () => {
		const clip = makeClip({
			sourceStartSec: 0,
			sourceEndSec: 3,
			wordRefs: ["w1", "w2", "w3"],
		});
		const transcript = makeTranscript({
			words: [
				{ id: "w1", segmentId: "s1", startSec: 0, endSec: 1, text: "hello" },
				{ id: "w2", segmentId: "s1", startSec: 1, endSec: 2, text: "world" },
				{ id: "w3", segmentId: "s1", startSec: 2, endSec: 3, text: "okay" },
			],
		});

		const section = buildClipSection(clip, transcript, makeAsset());

		expect(section.words.map((cw) => cw.kept)).toEqual([true, true, true]);
		expect(section.trims).toEqual([]);
	});

	it("flags removed words and groups them into a single trim range", () => {
		const clip = makeClip({
			sourceStartSec: 0,
			sourceEndSec: 5,
			wordRefs: ["w1", "w5"],
		});
		const transcript = makeTranscript({
			words: [
				{ id: "w1", segmentId: "s1", startSec: 0, endSec: 1, text: "hi" },
				{ id: "w2", segmentId: "s1", startSec: 1, endSec: 2, text: "uh" },
				{ id: "w3", segmentId: "s1", startSec: 2, endSec: 3, text: "long" },
				{ id: "w4", segmentId: "s1", startSec: 3, endSec: 4, text: "pause" },
				{ id: "w5", segmentId: "s1", startSec: 4, endSec: 5, text: "bye" },
			],
		});

		const section = buildClipSection(clip, transcript, makeAsset());

		expect(section.words.map((cw) => cw.kept)).toEqual([true, false, false, false, true]);
		expect(section.trims).toHaveLength(1);
		expect(section.trims[0]).toEqual({
			startWordIndex: 1,
			endWordIndex: 3,
			durationSec: 3,
		});
	});

	it("splits separate removed runs into multiple trim ranges", () => {
		const clip = makeClip({
			sourceStartSec: 0,
			sourceEndSec: 6,
			wordRefs: ["w1", "w3", "w5", "w6"],
		});
		const transcript = makeTranscript({
			words: [
				{ id: "w1", segmentId: "s1", startSec: 0, endSec: 1, text: "a" },
				{ id: "w2", segmentId: "s1", startSec: 1, endSec: 2, text: "b" },
				{ id: "w3", segmentId: "s1", startSec: 2, endSec: 3, text: "c" },
				{ id: "w4", segmentId: "s1", startSec: 3, endSec: 4, text: "d" },
				{ id: "w5", segmentId: "s1", startSec: 4, endSec: 5, text: "e" },
				{ id: "w6", segmentId: "s1", startSec: 5, endSec: 6, text: "f" },
			],
		});

		const section = buildClipSection(clip, transcript, makeAsset());
		expect(section.trims).toHaveLength(2);
		expect(section.trims[0]).toMatchObject({ startWordIndex: 1, endWordIndex: 1 });
		expect(section.trims[1]).toMatchObject({ startWordIndex: 3, endWordIndex: 3 });
	});

	it("treats empty wordRefs as default-keep-all (fresh clips before any cuts)", () => {
		// ponytail: split/insert operators in useTimeline.ts create clips
		// with an empty wordRefs array. Without a default the transcript view
		// would render every word in the source range as trimmed. Empty
		// wordRefs means "no explicit cuts yet" — keep every word.
		const clip = makeClip({
			sourceStartSec: 0,
			sourceEndSec: 3,
			wordRefs: [],
		});
		const transcript = makeTranscript({
			words: [
				{ id: "w1", segmentId: "s1", startSec: 0, endSec: 1, text: "hi" },
				{ id: "w2", segmentId: "s1", startSec: 1, endSec: 2, text: "there" },
				{ id: "w3", segmentId: "s1", startSec: 2, endSec: 3, text: "friend" },
			],
		});

		const section = buildClipSection(clip, transcript, makeAsset());
		expect(section.words.map((cw) => cw.kept)).toEqual([true, true, true]);
		expect(section.trims).toEqual([]);
	});

	it("flags English filler words regardless of keep state", () => {
		const clip = makeClip({
			sourceStartSec: 0,
			sourceEndSec: 3,
			wordRefs: ["w1", "w2", "w3"],
		});
		const transcript = makeTranscript({
			words: [
				{ id: "w1", segmentId: "s1", startSec: 0, endSec: 1, text: "okay" },
				{ id: "w2", segmentId: "s1", startSec: 1, endSec: 2, text: "real" },
				{ id: "w3", segmentId: "s1", startSec: 2, endSec: 3, text: "Um," },
			],
		});

		const section = buildClipSection(clip, transcript, makeAsset());
		expect(section.words.map((cw) => cw.filler)).toEqual([true, false, true]);
	});

	it("returns an empty words list when the clip has no matching transcript", () => {
		const clip = makeClip({ sourceStartSec: 0, sourceEndSec: 5, wordRefs: [] });
		const section = buildClipSection(clip, null, makeAsset());

		expect(section.words).toEqual([]);
		expect(section.trims).toEqual([]);
		expect(section.transcript).toBeNull();
	});

	it("ignores transcript words outside the clip's source range", () => {
		const clip = makeClip({
			sourceStartSec: 2,
			sourceEndSec: 4,
			wordRefs: ["w_mid"],
		});
		const transcript = makeTranscript({
			words: [
				{ id: "w_before", segmentId: "s1", startSec: 0, endSec: 1, text: "skip" },
				{ id: "w_mid", segmentId: "s1", startSec: 2.5, endSec: 3.5, text: "in" },
				{ id: "w_after", segmentId: "s1", startSec: 5, endSec: 6, text: "skip" },
			],
		});

		const section = buildClipSection(clip, transcript, makeAsset());
		expect(section.words.map((cw) => cw.word.id)).toEqual(["w_mid"]);
	});
});

describe("buildAggregatedSections", () => {
	it("joins per-clip sections across two assets in timeline order", () => {
		const clips = [
			makeClip({ id: "c1", assetId: "asset_1", sourceStartSec: 0, sourceEndSec: 2 }),
			makeClip({
				id: "c2",
				assetId: "asset_2",
				sourceStartSec: 0,
				sourceEndSec: 2,
				timelineStartSec: 2,
				timelineEndSec: 4,
			}),
		];
		const transcripts = [
			makeTranscript({
				assetId: "asset_1",
				words: [
					{ id: "w1", segmentId: "s1", startSec: 0, endSec: 1, text: "hi" },
					{ id: "w2", segmentId: "s1", startSec: 1, endSec: 2, text: "there" },
				],
			}),
			makeTranscript({
				assetId: "asset_2",
				words: [
					{ id: "w3", segmentId: "s1", startSec: 0, endSec: 1, text: "bye" },
					{ id: "w4", segmentId: "s1", startSec: 1, endSec: 2, text: "now" },
				],
			}),
		];
		const assets = [
			makeAsset({ id: "asset_1", label: "first.mp4" }),
			makeAsset({ id: "asset_2", label: "second.mp4" }),
		];

		const sections = buildAggregatedSections(clips, transcripts, assets);
		expect(sections).toHaveLength(2);
		expect(sections[0]?.clip.id).toBe("c1");
		expect(sections[1]?.clip.id).toBe("c2");
		expect(sections[0]?.asset?.label).toBe("first.mp4");
		expect(sections[1]?.asset?.label).toBe("second.mp4");
	});

	it("still renders a section when a clip's asset has no transcript", () => {
		const clips = [makeClip({ id: "c1" }), makeClip({ id: "c2", assetId: "asset_2" })];
		const transcripts = [makeTranscript({ words: [] })];
		const assets = [makeAsset(), makeAsset({ id: "asset_2" })];

		const sections = buildAggregatedSections(clips, transcripts, assets);
		expect(sections).toHaveLength(2);
		expect(sections[0]?.transcript).toBeTruthy();
		expect(sections[1]?.transcript).toBeNull();
		expect(sections[1]?.words).toEqual([]);
	});
});
