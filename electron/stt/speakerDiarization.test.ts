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

	it("assigns speaker tag 's1' and creates speaker registry when enabled", () => {
		const inputWords: SttWordSegment[] = [
			{ word: "testing", startSec: 0, endSec: 0.5 },
			{ word: "speech", startSec: 0.6, endSec: 1.0 },
		];

		const result = assignSpeakersToWords(inputWords, { enabled: true });
		expect(result.speakers).toBeDefined();
		expect(result.speakers?.s1.name).toBe("Speaker 1");
		expect(result.words[0].sp).toBe("s1");
		expect(result.words[1].sp).toBe("s1");
	});
});
