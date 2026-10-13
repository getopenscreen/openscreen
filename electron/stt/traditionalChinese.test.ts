import { describe, expect, it } from "vitest";
import { traditionalChineseTranscript } from "./traditionalChinese";
import type { SttTranscribeResponse } from "./transcriptionContract";

describe("Traditional Chinese transcript output", () => {
	const result: SttTranscribeResponse = {
		segments: [{ text: "测试软件字幕", startSec: 1, endSec: 2 }],
		wordSegments: [{ word: "测试", startSec: 1, endSec: 1.5 }],
		detectedLanguage: "zh",
		backend: "whispercpp-metal",
	};
	it("preserves the original script by default", () => {
		expect(traditionalChineseTranscript(result).segments[0].text).toBe("测试软件字幕");
	});

	it("converts Chinese from every recognizer while preserving timing", () => {
		const next = traditionalChineseTranscript(result, undefined, true);
		expect(next.segments).toEqual([{ text: "測試軟體字幕", startSec: 1, endSec: 2 }]);
		expect(next.wordSegments).toEqual([{ word: "測試", startSec: 1, endSec: 1.5 }]);
		expect(result.segments[0].text).toBe("测试软件字幕");
	});
	it("keeps whole-phrase Chinese timing when the helper calls a sentence one word", () => {
		const phrase = { text: "这是中文句子。", startSec: 0, endSec: 7 };
		const next = traditionalChineseTranscript({
			...result,
			segments: [phrase],
			wordSegments: [{ word: phrase.text, startSec: 0, endSec: 4 }],
		});
		expect(next.wordSegments).toEqual([]);
		expect(next.segments).toEqual([{ text: "这是中文句子。", startSec: 0, endSec: 7 }]);
	});

	it("leaves non-Chinese output unchanged unless Chinese was requested", () => {
		const unknown = { ...result, detectedLanguage: "auto" };
		expect(traditionalChineseTranscript(unknown)).toBe(unknown);
		expect(traditionalChineseTranscript(unknown, "zh-TW", true).segments[0].text).toBe(
			"測試軟體字幕",
		);
	});
});
