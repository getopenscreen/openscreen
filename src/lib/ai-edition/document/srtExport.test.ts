import { describe, expect, it } from "vitest";
import { serializeCaptionCuesSrt, serializeTranscriptSrt } from "./srtExport";
import { parseSrtTranscript } from "./srtImport";

describe("source transcript SRT export", () => {
	it("serializes already-projected timeline cue milliseconds without applying source timing again", () => {
		expect(
			serializeCaptionCuesSrt([{ id: "edited", startMs: 2250, endMs: 4250, text: "時間軸字幕" }]),
		).toBe("1\n00:00:02,250 --> 00:00:04,250\n時間軸字幕\n");
	});
	it("round trips Traditional Chinese, multiline phrases, source times and overlaps", () => {
		const original =
			"1\n00:00:01,250 --> 00:00:03,750\n繁體中文\n原始換行\n\n2\n00:00:03,000 --> 00:00:06,125\n第二句。\n";
		const transcript = parseSrtTranscript("asset", original);
		expect(serializeTranscriptSrt(transcript)).toBe(original);
		expect(parseSrtTranscript("asset", serializeTranscriptSrt(transcript))).toEqual(transcript);
	});
	it("rounds once across minute/hour boundaries and excludes silence", () => {
		const transcript = parseSrtTranscript("asset", "1\n00:00:00,000 --> 00:00:01,000\nText");
		transcript.segments[0].startSec = 3599.9996;
		transcript.segments[0].endSec = 3601.2346;
		transcript.segments.unshift({
			id: "silence",
			kind: "silence",
			startSec: 0,
			endSec: 1,
			text: "[silence]",
			wordIds: [],
		});
		expect(serializeTranscriptSrt(transcript)).toBe("1\n01:00:00,000 --> 01:00:01,235\nText\n");
	});
	it.each([
		NaN,
		Infinity,
		-0.0001,
		-1,
		2,
	])("rejects invalid source time %s instead of writing corrupt SRT", (startSec) => {
		const transcript = parseSrtTranscript("asset", "1\n00:00:00,000 --> 00:00:01,000\nText");
		transcript.segments[0].startSec = startSec;
		expect(() => serializeTranscriptSrt(transcript)).toThrow("Invalid subtitle timing");
	});
	it("rejects empty transcripts and submillisecond cues that SRT cannot represent", () => {
		const transcript = parseSrtTranscript("asset", "1\n00:00:00,000 --> 00:00:01,000\nText");
		transcript.segments[0].endSec = 0.0001;
		expect(() => serializeTranscriptSrt(transcript)).toThrow();
		transcript.segments = [];
		expect(() => serializeTranscriptSrt(transcript)).toThrow("no subtitle cues");
	});
	it("keeps long source-hour values and sanitizes blank cue separators", () => {
		const transcript = parseSrtTranscript("asset", "1\n100:00:00,000 --> 100:00:01,000\nText");
		transcript.segments[0].text = "繁體\r\n\r\n字幕";
		expect(serializeTranscriptSrt(transcript)).toBe(
			"1\n100:00:00,000 --> 100:00:01,000\n繁體\n字幕\n",
		);
	});
});
