import { expect, it } from "vitest";
import { captionLinesForAsset, deriveCaptionCues } from "../captions/cues";
import { DEFAULT_CAPTION_SETTINGS } from "../captions/settings";
import { captionTranslationUnits } from "../captions/translations";
import { documentSchema } from "../schema";
import { transcriptFromSrt } from "./fromSrt";

it("keeps adjacent repeated SRT cues separate in captions and translation", () => {
	const transcript = transcriptFromSrt(
		"a",
		"1\n00:00:00,000 --> 00:00:01,000\nAgain\n\n2\n00:00:01,010 --> 00:00:02,000\nAgain",
		3,
		"a.srt",
	);
	expect(captionLinesForAsset(transcript, DEFAULT_CAPTION_SETTINGS, {}).map((s) => s.text)).toEqual(
		["Again", "Again"],
	);
	expect(captionTranslationUnits(transcript)).toHaveLength(2);
});
it("does not extend an imported cue past its authored end even for very short cues", () => {
	const transcript = transcriptFromSrt("a", "1\n00:00:01,000 --> 00:00:01,001\nHi", 2, "a.srt");
	const lines = captionLinesForAsset(transcript, DEFAULT_CAPTION_SETTINGS, {});
	expect(lines[0].startSec).toBe(1);
	expect(lines[0].endSec).toBe(1.001);
});
it("projects only the imported asset through source-trimmed and repeated clips", () => {
	const transcript = transcriptFromSrt("a", "1\n00:00:01,000 --> 00:00:03,000\nHello", 4, "a.srt");
	const document = documentSchema.parse({
		schemaVersion: 9,
		project: {
			id: "p",
			title: "P",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		},
		transcripts: [transcript],
		timeline: {
			clips: [
				{
					id: "c1",
					assetId: "a",
					origin: "user",
					sourceStartSec: 2,
					sourceEndSec: 4,
					timelineStartSec: 0,
					timelineEndSec: 2,
				},
				{
					id: "c2",
					assetId: "a",
					origin: "user",
					sourceStartSec: 0,
					sourceEndSec: 4,
					timelineStartSec: 2,
					timelineEndSec: 6,
				},
				{
					id: "other",
					assetId: "b",
					origin: "user",
					sourceStartSec: 0,
					sourceEndSec: 4,
					timelineStartSec: 6,
					timelineEndSec: 10,
				},
			],
		},
	});
	expect(
		deriveCaptionCues(document, { ...DEFAULT_CAPTION_SETTINGS, enabled: true }, {}).map(
			({ startMs, endMs, text }) => ({ startMs, endMs, text }),
		),
	).toEqual([
		{ startMs: 0, endMs: 1000, text: "Hello" },
		{ startMs: 3000, endMs: 5000, text: "Hello" },
	]);
});
it("preserves intentional repeated words split into separate imported caption lines", () => {
	const t = transcriptFromSrt("a", "1\n00:00:00,000 --> 00:00:02,000\nAgain Again", 3, "a.srt");
	expect(
		captionLinesForAsset(
			t,
			{ ...DEFAULT_CAPTION_SETTINGS, minWordsPerLine: 1, maxWordsPerLine: 1 },
			{},
		).map((s) => s.text),
	).toEqual(["Again", "Again"]);
});
