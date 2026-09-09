import { describe, expect, it } from "vitest";
import { assignSpeakersToWords } from "./speakerDiarization";
import type { SttWordSegment } from "./transcriptionContract";

describe("assignSpeakersToWords", () => {
	it("returns unchanged words when diarization is disabled", () => {
		const inputWords: SttWordSegment[] = [{ word: "hello", startSec: 0, endSec: 0.5 }];

		const result = assignSpeakersToWords(inputWords, { enabled: false });
		expect(result.speakers).toBeUndefined();
		expect(result.words[0].sp).toBeUndefined();
	});

	it("returns unchanged words without speaker metadata when no speaker clusters exist", () => {
		const inputWords: SttWordSegment[] = [
			{ word: "testing", startSec: 0, endSec: 0.5 },
			{ word: "speech", startSec: 0.6, endSec: 1.0 },
		];

		const result = assignSpeakersToWords(inputWords, { enabled: true });
		expect(result.speakers).toBeUndefined();
		expect(result.segmentationUsed).toBeUndefined();
		expect(result.words[0].sp).toBeUndefined();
	});

	it("creates consistent speaker registry for all encountered speaker tags (e.g. s2)", () => {
		const inputWords: SttWordSegment[] = [
			{ word: "speaker", startSec: 0, endSec: 0.5, sp: "s1" },
			{ word: "two", startSec: 0.6, endSec: 1.0, sp: "s2" },
		];

		const result = assignSpeakersToWords(inputWords, { enabled: true });
		expect(result.speakers).toBeDefined();
		expect(result.speakers?.s1).toBeDefined();
		expect(result.speakers?.s2).toBeDefined();
		expect(result.speakers?.s2.name).toBe("Speaker 2");
		expect(result.words[0].sp).toBe("s1");
		expect(result.words[1].sp).toBe("s2");
	});
});
