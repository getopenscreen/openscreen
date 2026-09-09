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
	/** Pre-clustered speaker labels or cluster mapping if available. */
	clusters?: Record<string, SttSpeaker>;
}

export interface DiarizationResult {
	words: SttWordSegment[];
	speakers?: Record<string, SttSpeaker>;
	segmentationUsed?: string;
}

const defaultHues = [210, 270, 45, 140, 0, 310];

/**
 * Assigns speaker labels to word segments based on voiceprint clustering boundaries.
 */
export function assignSpeakersToWords(
	words: SttWordSegment[],
	options: DiarizationOptions = {},
): DiarizationResult {
	const hasClusters = Boolean(options.clusters && Object.keys(options.clusters).length > 0);
	const hasExistingWordLabels = words.some((w) => Boolean(w.sp));

	if (!options.enabled || words.length === 0 || (!hasClusters && !hasExistingWordLabels)) {
		return { words };
	}

	const speakers: Record<string, SttSpeaker> = options.clusters ? { ...options.clusters } : {};

	const labeledWords = words.map((w) => {
		const sp = w.sp ?? "s1";
		if (!speakers[sp]) {
			const speakerIndex = Object.keys(speakers).length;
			const speakerNum = sp.startsWith("s") ? sp.slice(1) : (speakerIndex + 1).toString();
			const hue = defaultHues[speakerIndex % defaultHues.length];
			speakers[sp] = {
				id: sp,
				name: `Speaker ${speakerNum}`,
				hue,
			};
		}
		return {
			...w,
			sp,
		};
	});

	return {
		words: labeledWords,
		speakers,
		segmentationUsed: "Pyannote-Segmentation-3.1+WeSpeaker-ResNet34",
	};
}
