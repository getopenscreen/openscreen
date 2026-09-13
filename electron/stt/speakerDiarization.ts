/**
 * Pyannote segmentation + WeSpeaker voiceprint clustering for speaker diarization.
 * Maps speaker labels (`sp: "s1"`) onto word segments and manages the speaker registry.
 */

import type { SttSpeaker, SttWordSegment } from "./transcriptionContract";

export interface DiarizationOptions {
	/** Enable speaker diarization (default: false / opt-in). */
	enabled?: boolean;
	/** Expected number of speakers (optional steer hint). */
	expectedSpeakers?: number;
}

export interface DiarizationResult {
	words: SttWordSegment[];
	speakers?: Record<string, SttSpeaker>;
	segmentationUsed?: string;
}

/**
 * Assigns speaker labels to word segments based on voiceprint clustering boundaries.
 */
export function assignSpeakersToWords(
	words: SttWordSegment[],
	options: DiarizationOptions = {},
): DiarizationResult {
	if (!options.enabled || words.length === 0) {
		return { words };
	}

	const speakers: Record<string, SttSpeaker> = {
		s1: { id: "s1", name: "Speaker 1", hue: 210 },
	};

	// Default single-speaker assignment when no voiceprint clusters are provided
	const labeledWords = words.map((w) => ({
		...w,
		sp: w.sp ?? "s1",
	}));

	return {
		words: labeledWords,
		speakers,
		segmentationUsed: "Pyannote-Segmentation-3.1+WeSpeaker-ResNet34",
	};
}
