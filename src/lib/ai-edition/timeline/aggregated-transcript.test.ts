import { describe, expect, it } from "vitest";
import type { AxcutAsset, AxcutClip, AxcutSkipRange, AxcutTranscript } from "../schema";
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

function makeTranscript(words: AxcutTranscript["words"]): AxcutTranscript {
	return { assetId: "asset_1", language: "en", segments: [], words };
}

function makeSkip(overrides: Partial<AxcutSkipRange>): AxcutSkipRange {
	return {
		id: overrides.id ?? "skip_1",
		assetId: overrides.assetId ?? "asset_1",
		startSec: overrides.startSec ?? 0,
		endSec: overrides.endSec ?? 0,
		origin: overrides.origin ?? "user",
		reason: overrides.reason ?? "",
	};
}

describe("buildClipSection", () => {
	it("marks every word in source range as kept when no skips exist", () => {
		const clip = makeClip({ sourceStartSec: 0, sourceEndSec: 3 });
		const transcript = makeTranscript([
			{ id: "w1", segmentId: "s1", startSec: 0, endSec: 1, text: "hi" },
			{ id: "w2", segmentId: "s1", startSec: 1, endSec: 2, text: "there" },
			{ id: "w3", segmentId: "s1", startSec: 2, endSec: 3, text: "friend" },
		]);

		const section = buildClipSection(clip, transcript, makeAsset(), []);
		expect(section.words.map((cw) => cw.kept)).toEqual([true, true, true]);
		expect(section.skipRuns).toEqual([]);
	});

	it("flags words inside a skip range as removed and groups them into one SkipRun", () => {
		const clip = makeClip({ sourceStartSec: 0, sourceEndSec: 5 });
		const transcript = makeTranscript([
			{ id: "w1", segmentId: "s1", startSec: 0, endSec: 1, text: "hi" },
			{ id: "w2", segmentId: "s1", startSec: 1, endSec: 2, text: "uh" },
			{ id: "w3", segmentId: "s1", startSec: 2, endSec: 3, text: "long" },
			{ id: "w4", segmentId: "s1", startSec: 3, endSec: 4, text: "pause" },
			{ id: "w5", segmentId: "s1", startSec: 4, endSec: 5, text: "bye" },
		]);
		const skip = makeSkip({ id: "skip_a", startSec: 1, endSec: 4 });

		const section = buildClipSection(clip, transcript, makeAsset(), [skip]);
		expect(section.words.map((cw) => cw.kept)).toEqual([true, false, false, false, true]);
		expect(section.words.map((cw) => cw.skipId)).toEqual([
			null,
			"skip_a",
			"skip_a",
			"skip_a",
			null,
		]);
		expect(section.skipRuns).toHaveLength(1);
		expect(section.skipRuns[0]).toMatchObject({
			skipId: "skip_a",
			startWordIndex: 1,
			endWordIndex: 3,
			durationSec: 3,
		});
	});

	it("splits separated skip ranges into multiple SkipRuns", () => {
		const clip = makeClip({ sourceStartSec: 0, sourceEndSec: 6 });
		const transcript = makeTranscript([
			{ id: "w1", segmentId: "s1", startSec: 0, endSec: 1, text: "a" },
			{ id: "w2", segmentId: "s1", startSec: 1, endSec: 2, text: "b" },
			{ id: "w3", segmentId: "s1", startSec: 2, endSec: 3, text: "c" },
			{ id: "w4", segmentId: "s1", startSec: 3, endSec: 4, text: "d" },
			{ id: "w5", segmentId: "s1", startSec: 4, endSec: 5, text: "e" },
			{ id: "w6", segmentId: "s1", startSec: 5, endSec: 6, text: "f" },
		]);
		const skips = [
			makeSkip({ id: "skip_a", startSec: 1, endSec: 2 }),
			makeSkip({ id: "skip_b", startSec: 3, endSec: 4 }),
		];

		const section = buildClipSection(clip, transcript, makeAsset(), skips);
		expect(section.skipRuns).toHaveLength(2);
		expect(section.skipRuns[0]).toMatchObject({
			skipId: "skip_a",
			startWordIndex: 1,
			endWordIndex: 1,
		});
		expect(section.skipRuns[1]).toMatchObject({
			skipId: "skip_b",
			startWordIndex: 3,
			endWordIndex: 3,
		});
	});

	it("does NOT apply skips from a different asset", () => {
		const clip = makeClip({ sourceStartSec: 0, sourceEndSec: 3 });
		const transcript = makeTranscript([
			{ id: "w1", segmentId: "s1", startSec: 0, endSec: 1, text: "hi" },
			{ id: "w2", segmentId: "s1", startSec: 1, endSec: 2, text: "there" },
		]);
		const skip = makeSkip({ id: "skip_x", assetId: "asset_2", startSec: 0.5, endSec: 2.5 });

		const section = buildClipSection(clip, transcript, makeAsset(), [skip]);
		expect(section.words.map((cw) => cw.kept)).toEqual([true, true]);
	});

	it("flags English filler words regardless of keep state", () => {
		const clip = makeClip({ sourceStartSec: 0, sourceEndSec: 3 });
		const transcript = makeTranscript([
			{ id: "w1", segmentId: "s1", startSec: 0, endSec: 1, text: "okay" },
			{ id: "w2", segmentId: "s1", startSec: 1, endSec: 2, text: "real" },
			{ id: "w3", segmentId: "s1", startSec: 2, endSec: 3, text: "Um," },
		]);

		const section = buildClipSection(clip, transcript, makeAsset(), []);
		expect(section.words.map((cw) => cw.filler)).toEqual([true, false, true]);
	});

	it("returns an empty words list when the clip has no matching transcript", () => {
		const clip = makeClip({ sourceStartSec: 0, sourceEndSec: 5 });
		const section = buildClipSection(clip, null, makeAsset(), []);

		expect(section.words).toEqual([]);
		expect(section.skipRuns).toEqual([]);
		expect(section.transcript).toBeNull();
	});

	it("ignores transcript words outside the clip's source range", () => {
		const clip = makeClip({ sourceStartSec: 2, sourceEndSec: 4 });
		const transcript = makeTranscript([
			{ id: "w_before", segmentId: "s1", startSec: 0, endSec: 1, text: "skip" },
			{ id: "w_mid", segmentId: "s1", startSec: 2.5, endSec: 3.5, text: "in" },
			{ id: "w_after", segmentId: "s1", startSec: 5, endSec: 6, text: "skip" },
		]);

		const section = buildClipSection(clip, transcript, makeAsset(), []);
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
			makeTranscript([
				{ id: "w1", segmentId: "s1", startSec: 0, endSec: 1, text: "hi" },
				{ id: "w2", segmentId: "s1", startSec: 1, endSec: 2, text: "there" },
			]),
			{
				assetId: "asset_2",
				language: "en",
				segments: [],
				words: [
					{ id: "w3", segmentId: "s1", startSec: 0, endSec: 1, text: "bye" },
					{ id: "w4", segmentId: "s1", startSec: 1, endSec: 2, text: "now" },
				],
			},
		];
		const assets = [
			makeAsset({ id: "asset_1", label: "first.mp4" }),
			makeAsset({ id: "asset_2", label: "second.mp4" }),
		];

		const sections = buildAggregatedSections(clips, transcripts, assets, []);
		expect(sections).toHaveLength(2);
		expect(sections[0]?.clip.id).toBe("c1");
		expect(sections[1]?.clip.id).toBe("c2");
		expect(sections[0]?.asset?.label).toBe("first.mp4");
		expect(sections[1]?.asset?.label).toBe("second.mp4");
	});

	it("still renders a section when a clip's asset has no transcript", () => {
		const clips = [makeClip({ id: "c1" }), makeClip({ id: "c2", assetId: "asset_2" })];
		const transcripts = [makeTranscript([])];
		const assets = [makeAsset(), makeAsset({ id: "asset_2" })];

		const sections = buildAggregatedSections(clips, transcripts, assets, []);
		expect(sections).toHaveLength(2);
		expect(sections[0]?.transcript).toBeTruthy();
		expect(sections[1]?.transcript).toBeNull();
		expect(sections[1]?.words).toEqual([]);
	});
});
