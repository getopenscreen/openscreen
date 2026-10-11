import { describe, expect, it } from "vitest";
import { transcriptSchema } from "../schema";
import { parseSrtTranscript } from "./srtImport";

describe("parseSrtTranscript", () => {
	it("preserves Traditional Chinese, multiline text and source times with phrase alignment", () => {
		const result = parseSrtTranscript(
			"clip",
			"\uFEFF1\r\n00:00:01,234 --> 00:00:03,567\r\n這是繁體字幕。\r\n保留第二行\r\n\r\n2\r\n00:00:04.010 --> 00:00:06.200\r\n電腦與麥克風\r\n",
			{ durationSec: 8 },
		);
		expect(transcriptSchema.parse(result)).toEqual(result);
		expect(result.timingGranularity).toBe("phrase");
		expect(result.words).toHaveLength(2);
		expect(result.words[0]).toMatchObject({
			text: "這是繁體字幕。\n保留第二行",
			startSec: 1.234,
			endSec: 3.567,
		});
		expect(result.words[1]).toMatchObject({ startSec: 4.01, endSec: 6.2 });
	});

	it("accepts cues without sequence numbers and preserves valid overlapping spans", () => {
		const result = parseSrtTranscript(
			"clip",
			"00:00:00,000 --> 00:00:02,000\n第一句\n\n00:00:01,500 --> 00:00:03,000\n第二句",
		);
		expect(result.segments.map(({ startSec, endSec }) => [startSec, endSec])).toEqual([
			[0, 2],
			[1.5, 3],
		]);
	});

	it.each([
		"",
		"\uFEFF\r\n  ",
		"not subtitles",
		"1\n00:61:00,000 --> 00:62:00,000\n無效",
		"1\n00:00:05,000 --> 00:00:04,000\n顛倒",
		"1\n00:00:05,000 --> 00:00:05,000\n沒有長度",
		"1\n00:00:00,000 --> 00:00:01,000",
		"1\n00:00:02,000 --> 00:00:03,000\n後面\n\n2\n00:00:01,000 --> 00:00:02,000\n前面",
	])("rejects invalid input before producing a partial transcript: %s", (input) => {
		expect(() => parseSrtTranscript("clip", input)).toThrow();
	});

	it("rejects subtitles for a longer media but keeps small container-tail offsets intact", () => {
		expect(() =>
			parseSrtTranscript("clip", "1\n00:00:01,000 --> 00:00:10,200\n太長", {
				durationSec: 10,
			}),
		).toThrow(/duration/);
		const result = parseSrtTranscript("clip", "1\n00:00:09,000 --> 00:00:10,050\n尾端", {
			durationSec: 10,
		});
		expect(result.words[0].endSec).toBe(10.05);
	});
});
