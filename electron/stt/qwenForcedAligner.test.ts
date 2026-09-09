import { describe, expect, it } from "vitest";
import { alignWordSegments } from "./qwenForcedAligner";
import type { SttWordSegment } from "./transcriptionContract";

describe("alignWordSegments", () => {
	it("returns fallback result when disabled", () => {
		const inputWords: SttWordSegment[] = [
			{ word: "hello", startSec: 0.1, endSec: 0.5 },
			{ word: "world", startSec: 0.52, endSec: 0.9 },
		];

		const result = alignWordSegments(inputWords, { enabled: false });
		expect(result.fallbackUsed).toBe(true);
		expect(result.alignerUsed).toBe("whispercpp-dtw-fallback");
		expect(result.alignedWords).toEqual(inputWords);
	});

	it("adjusts overlapping word boundaries cleanly when forced aligner is enabled", () => {
		const inputWords: SttWordSegment[] = [
			{ word: "quick", startSec: 0.1, endSec: 0.55 },
			{ word: "brown", startSec: 0.5, endSec: 0.9 },
		];

		const result = alignWordSegments(inputWords, { enabled: true });
		expect(result.fallbackUsed).toBe(true);
		expect(result.alignerUsed).toBe("whispercpp-dtw-fallback");
		expect(result.alignedWords[0].endSec).toBe(0.5);
	});

	it("reports Qwen provenance when hasQwenInference is true", () => {
		const inputWords: SttWordSegment[] = [
			{ word: "quick", startSec: 0.1, endSec: 0.55 },
			{ word: "brown", startSec: 0.5, endSec: 0.9 },
		];

		const result = alignWordSegments(inputWords, { enabled: true, hasQwenInference: true });
		expect(result.fallbackUsed).toBe(false);
		expect(result.alignerUsed).toBe("Qwen3-ForcedAligner-0.6B");
		expect(result.alignedWords[0].endSec).toBe(0.5);
	});
});
