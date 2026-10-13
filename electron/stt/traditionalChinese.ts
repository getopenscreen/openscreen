import { Converter } from "opencc-js";
import type { SttTranscribeResponse } from "./transcriptionContract";

const toTraditional = Converter({ from: "cn", to: "twp" });

/** Change script, never timings. Non-Chinese results retain their original text. */
export function traditionalChineseTranscript(
	result: SttTranscribeResponse,
	requestedLanguage?: string,
	traditionalChinese = false,
): SttTranscribeResponse {
	if (!result.detectedLanguage.startsWith("zh") && !requestedLanguage?.startsWith("zh"))
		return result;
	// whisper.cpp groups Chinese without spaces into one "word" per phrase.
	// The word boundary snapper can truncate that sentence at a VAD pause.
	// Keep the recognizer's phrase spans instead of claiming word-level timing.
	const phraseOnly =
		result.segments.length > 0 &&
		result.segments.length === result.wordSegments.length &&
		result.segments.every(
			(segment, index) =>
				segment.text.replace(/\s+/g, "") === result.wordSegments[index].word.replace(/\s+/g, ""),
		);
	return {
		...result,
		segments: result.segments.map((segment) => ({
			...segment,
			text: traditionalChinese ? toTraditional(segment.text) : segment.text,
		})),
		wordSegments: phraseOnly
			? []
			: result.wordSegments.map((word) => ({
					...word,
					word: traditionalChinese ? toTraditional(word.word) : word.word,
				})),
	};
}
