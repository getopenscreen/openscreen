import { describe, expect, it } from "vitest";
import type { AxcutDocument } from "../schema";
import { patchCaptionSettings } from "./settings";
import { formatSubtitleFile, subtitleCuesForExport } from "./subtitleFile";
import { captionTranslationUnits, putCaptionTranslation } from "./translations";

function doc(overrides: Partial<AxcutDocument> = {}): AxcutDocument {
	return {
		schemaVersion: 5,
		project: {
			id: "p1",
			title: "Test",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			primaryAssetId: "asset-1",
		},
		assets: [
			{
				id: "asset-1",
				kind: "video",
				label: "take",
				originalPath: "C:/rec/take.mp4",
				video: { width: 1920, height: 1080, fps: 30 },
				cameraTrack: null,
			},
		],
		transcript: null,
		transcripts: [
			{
				assetId: "asset-1",
				language: "en",
				segments: [
					{
						id: "seg_1",
						kind: "speech",
						startSec: 0,
						endSec: 2,
						text: "hello there friend",
						wordIds: ["w1", "w2", "w3"],
					},
					{
						id: "seg_2",
						kind: "speech",
						startSec: 4,
						endSec: 6,
						text: "goodbye now",
						wordIds: ["w4", "w5"],
					},
				],
				words: [
					{ id: "w1", segmentId: "seg_1", startSec: 0, endSec: 0.6, text: "hello" },
					{ id: "w2", segmentId: "seg_1", startSec: 0.6, endSec: 1.2, text: "there" },
					{ id: "w3", segmentId: "seg_1", startSec: 1.2, endSec: 2, text: "friend" },
					{ id: "w4", segmentId: "seg_2", startSec: 4, endSec: 5, text: "goodbye" },
					{ id: "w5", segmentId: "seg_2", startSec: 5, endSec: 6, text: "now" },
				],
			},
		],
		timeline: {
			clips: [
				{
					id: "clip-1",
					assetId: "asset-1",
					sourceStartSec: 0,
					sourceEndSec: 10,
					timelineStartSec: 0,
					timelineEndSec: 10,
					wordRefs: [],
					origin: "user",
					reason: "",
				},
			],
			gaps: [],
			trimRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		annotations: [],
		zoomRanges: [],
		legacyEditor: null,
		...overrides,
	} as AxcutDocument;
}

describe("subtitleCuesForExport", () => {
	it("gives the burnt-in lines, whether or not the captions are on", () => {
		expect(subtitleCuesForExport(doc())).toEqual([
			{ startSec: 0, endSec: 2, text: "hello there friend" },
			{ startSec: 4, endSec: 6, text: "goodbye now" },
		]);
	});

	it("times them on the export: a trim is skipped and a speed region plays faster", () => {
		const base = doc();
		const edited = doc({
			timeline: {
				...base.timeline,
				trimRanges: [
					{
						id: "trim_1",
						assetId: "asset-1",
						clipId: "clip-1",
						startSec: 2.5,
						endSec: 3.5,
						reason: "",
						origin: "user",
					},
				],
			},
			legacyEditor: {
				speedRegions: [
					{
						id: "speed_1",
						clipId: "clip-1",
						sourceStartSec: 4,
						sourceEndSec: 6,
						startMs: 4000,
						endMs: 6000,
						speed: 2,
					},
				],
			},
		});
		const cues = subtitleCuesForExport(edited);
		expect(cues[0]).toEqual({ startSec: 0, endSec: 2, text: "hello there friend" });
		// 4 s on the ruler is 3 s of export after the 1 s cut; its 2 s at 2× last 1 s.
		expect(cues[1].startSec).toBeCloseTo(3, 6);
		expect(cues[1].endSec).toBeCloseTo(4, 6);
	});

	it("drops a line the cuts remove entirely", () => {
		const base = doc();
		const cut = doc({
			timeline: {
				...base.timeline,
				trimRanges: [
					{
						id: "trim_1",
						assetId: "asset-1",
						clipId: "clip-1",
						startSec: 3.5,
						endSec: 6.5,
						reason: "",
						origin: "user",
					},
				],
			},
		});
		expect(subtitleCuesForExport(cut).map((c) => c.text)).toEqual(["hello there friend"]);
	});

	it("drops a line on the cut tail of the last clip, which the film ends before", () => {
		const base = doc();
		const tail = doc({
			timeline: {
				...base.timeline,
				trimRanges: [
					{
						id: "trim_1",
						assetId: "asset-1",
						clipId: "clip-1",
						startSec: 3.5,
						endSec: 10,
						reason: "",
						origin: "user",
					},
				],
			},
		});
		// The film lasts 3.5 s: "goodbye now", at 4 to 6 s, is not in it.
		expect(subtitleCuesForExport(tail)).toEqual([
			{ startSec: 0, endSec: 2, text: "hello there friend" },
		]);
	});

	it("reads a translation layer when asked, and the transcript's words with null", () => {
		const transcript = doc().transcripts[0];
		const segments = Object.fromEntries(
			captionTranslationUnits(transcript).map((unit, i) => [unit.id, i === 0 ? "salut" : "adieu"]),
		);
		const translated = patchCaptionSettings(
			putCaptionTranslation(doc(), {
				language: "fr",
				label: "Français",
				assetId: "asset-1",
				segments,
			}),
			{ language: "fr" },
		);
		// Omitted: what the captions show.
		expect(subtitleCuesForExport(translated).map((c) => c.text)).toEqual(["salut", "adieu"]);
		expect(subtitleCuesForExport(translated, null).map((c) => c.text)).toEqual([
			"hello there friend",
			"goodbye now",
		]);
		expect(subtitleCuesForExport(doc(), "fr").map((c) => c.text)).toEqual([
			"hello there friend",
			"goodbye now",
		]);
	});
});

describe("formatSubtitleFile", () => {
	const cues = [
		{ startSec: 0, endSec: 2.5, text: "hello there" },
		{ startSec: 3661.0425, endSec: 3662, text: "goodbye" },
	];

	it("writes numbered SubRip entries with comma milliseconds", () => {
		expect(formatSubtitleFile(cues, "srt")).toBe(
			"1\n00:00:00,000 --> 00:00:02,500\nhello there\n\n2\n01:01:01,043 --> 01:01:02,000\ngoodbye\n",
		);
	});

	it("writes a WebVTT header and dot milliseconds", () => {
		expect(formatSubtitleFile(cues, "vtt")).toBe(
			"WEBVTT\n\n00:00:00.000 --> 00:00:02.500\nhello there\n\n01:01:01.043 --> 01:01:02.000\ngoodbye\n",
		);
	});

	it("writes what WebVTT reads as markup as entities, and leaves SubRip's text alone", () => {
		const spoken = [{ startSec: 0, endSec: 1, text: "R&D: if a < b, then b > a" }];
		expect(formatSubtitleFile(spoken, "vtt")).toContain("R&amp;D: if a &lt; b, then b &gt; a");
		expect(formatSubtitleFile(spoken, "srt")).toContain("R&D: if a < b, then b > a");
	});
});
