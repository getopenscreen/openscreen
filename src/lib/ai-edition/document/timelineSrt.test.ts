import { describe, expect, it } from "vitest";
import { type AxcutDocument, assetSchema, clipSchema, createEmptyDocument } from "../schema";
import { serializeCaptionCuesSrt } from "./srtExport";
import { parseSrtTranscript } from "./srtImport";
import { deriveTimelineSrtCues } from "./timelineSrt";

function fixture(srt: string): AxcutDocument {
	const document = createEmptyDocument({ projectId: "p", title: "Timeline subtitles" });
	return {
		...document,
		assets: [
			assetSchema.parse({ id: "a", label: "source", originalPath: "/source.mp4", durationSec: 10 }),
		],
		transcripts: [parseSrtTranscript("a", srt)],
		timeline: {
			...document.timeline,
			clips: [
				clipSchema.parse({
					origin: "user",
					id: "c",
					assetId: "a",
					sourceStartSec: 0,
					sourceEndSec: 10,
					timelineStartSec: 0,
					timelineEndSec: 10,
				}),
			],
		},
	};
}

describe("timeline SRT uses the finished programme clock", () => {
	it("removes cut cues and projects remaining cues through both trims and speed", () => {
		const document = fixture(
			"1\n00:00:00,000 --> 00:00:01,000\n第一句\n\n2\n00:00:03,000 --> 00:00:03,500\n刪除\n\n3\n00:00:06,000 --> 00:00:08,000\n加速後\n",
		);
		document.timeline.trimRanges = [
			{
				id: "trim",
				assetId: "a",
				clipId: "c",
				startSec: 2,
				endSec: 4,
				origin: "user",
				reason: "test",
			},
		];
		document.legacyEditor = {
			speedRegions: [{ id: "speed", startMs: 4000, endMs: 8000, speed: 2 }],
		};
		expect(serializeCaptionCuesSrt(deriveTimelineSrtCues(document))).toBe(
			"1\n00:00:00,000 --> 00:00:01,000\n第一句\n\n2\n00:00:03,000 --> 00:00:04,000\n加速後\n",
		);
	});

	it("splits a cue across a cut so no removed interval survives", () => {
		const document = fixture("1\n00:00:01,000 --> 00:00:06,000\n跨越剪輯\n");
		document.timeline.trimRanges = [
			{
				id: "trim",
				assetId: "a",
				clipId: "c",
				startSec: 2,
				endSec: 4,
				origin: "user",
				reason: "test",
			},
		];
		document.legacyEditor = {
			speedRegions: [{ id: "speed", startMs: 4000, endMs: 8000, speed: 2 }],
		};
		expect(
			deriveTimelineSrtCues(document).map(({ startMs, endMs, text }) => ({ startMs, endMs, text })),
		).toEqual([
			{ startMs: 1000, endMs: 2000, text: "跨越剪輯" },
			{ startMs: 2000, endMs: 3000, text: "跨越剪輯" },
		]);
	});

	it("exports sidecar captions with burn-in off without changing that preference", () => {
		const document = fixture("1\n00:00:00,250 --> 00:00:01,750\n繁體字幕\n");
		document.legacyEditor = { captions: { enabled: false } };
		const before = JSON.stringify(document);
		expect(deriveTimelineSrtCues(document)).toHaveLength(1);
		expect(JSON.stringify(document)).toBe(before);
	});

	it("maps source in-points and repeated clips into their own output positions", () => {
		const document = fixture("1\n00:00:06,000 --> 00:00:08,000\n重複片段\n");
		document.timeline.clips = [
			clipSchema.parse({
				origin: "user",
				id: "c1",
				assetId: "a",
				sourceStartSec: 5,
				sourceEndSec: 9,
				timelineStartSec: 0,
				timelineEndSec: 4,
			}),
			clipSchema.parse({
				origin: "user",
				id: "c2",
				assetId: "a",
				sourceStartSec: 6,
				sourceEndSec: 9,
				timelineStartSec: 4,
				timelineEndSec: 7,
			}),
		];
		expect(deriveTimelineSrtCues(document).map(({ startMs, endMs }) => [startMs, endMs])).toEqual([
			[1000, 3000],
			[4000, 6000],
		]);
	});

	it("does not emit subtitles for a fully cut or empty timeline", () => {
		const document = fixture("1\n00:00:00,000 --> 00:00:01,000\n字幕\n");
		document.timeline.trimRanges = [
			{
				id: "trim",
				assetId: "a",
				clipId: "c",
				startSec: 0,
				endSec: 10,
				origin: "user",
				reason: "test",
			},
		];
		expect(deriveTimelineSrtCues(document)).toEqual([]);
		document.timeline.clips = [];
		expect(deriveTimelineSrtCues(document)).toEqual([]);
	});
});
