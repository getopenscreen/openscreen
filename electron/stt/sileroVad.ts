/**
 * Silero VAD v6 Voice Activity Detection boundary segmenter.
 * Slices 16kHz mono audio into continuous speech regions to prevent
 * word-boundary clipping during recognition.
 */

export interface VadSegment {
	startSec: number;
	endSec: number;
}

export interface VadOptions {
	/** Minimum duration of speech segment in seconds (default: 0.25). */
	minSpeechDurationSec?: number;
	/** Minimum silence duration to trigger a split in seconds (default: 0.3). */
	minSilenceDurationSec?: number;
	/** Threshold probability for speech detection (default: 0.5). */
	speechThreshold?: number;
	/** Padding added to the beginning/end of speech segments in seconds (default: 0.1). */
	paddingSec?: number;
}

/**
 * Computes speech segments from continuous energy or probability frames.
 * Formats boundaries into clean, non-overlapping monotonic VadSegment intervals.
 */
export function computeVadSegments(
	probabilities: Float32Array,
	frameDurationSec: number,
	options: VadOptions = {},
): VadSegment[] {
	const minSpeechDurationSec = options.minSpeechDurationSec ?? 0.25;
	const minSilenceDurationSec = options.minSilenceDurationSec ?? 0.3;
	const speechThreshold = options.speechThreshold ?? 0.5;
	const paddingSec = options.paddingSec ?? 0.1;

	const segments: VadSegment[] = [];
	let isSpeech = false;
	let speechStart = 0;
	let silenceStart = 0;

	const numFrames = probabilities.length;
	for (let i = 0; i < numFrames; i++) {
		const prob = probabilities[i];
		const timeSec = i * frameDurationSec;

		if (prob >= speechThreshold) {
			if (!isSpeech) {
				isSpeech = true;
				speechStart = Math.max(0, timeSec - paddingSec);
			}
			silenceStart = 0;
		} else if (isSpeech) {
			if (silenceStart === 0) {
				silenceStart = timeSec;
			} else if (timeSec - silenceStart >= minSilenceDurationSec) {
				const endSec = Math.min(numFrames * frameDurationSec, silenceStart + paddingSec);
				const prevEnd = segments.length > 0 ? segments[segments.length - 1].endSec : 0;
				const effectiveStart = Math.max(speechStart, prevEnd);
				if (endSec - effectiveStart >= minSpeechDurationSec) {
					segments.push({
						startSec: Number(effectiveStart.toFixed(3)),
						endSec: Number(endSec.toFixed(3)),
					});
				}
				isSpeech = false;
				silenceStart = 0;
			}
		}
	}

	if (isSpeech) {
		const audioEndSec = numFrames * frameDurationSec;
		const endSec = Math.min(
			audioEndSec,
			(silenceStart > 0 ? silenceStart : audioEndSec) + paddingSec,
		);
		const prevEnd = segments.length > 0 ? segments[segments.length - 1].endSec : 0;
		const effectiveStart = Math.max(speechStart, prevEnd);
		if (endSec - effectiveStart >= minSpeechDurationSec) {
			segments.push({
				startSec: Number(effectiveStart.toFixed(3)),
				endSec: Number(endSec.toFixed(3)),
			});
		}
	}

	return segments;
}
