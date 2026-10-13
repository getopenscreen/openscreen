import type { AxcutTranscript } from "../schema";

/** Container/audio tails can differ by a few frames. Keep the supplied cue
 * timestamps intact within this allowance rather than silently clamping them. */
export const SRT_DURATION_TOLERANCE_SEC = 0.1;

const TIMESTAMP = /^(\d{2,}):(\d{2}):(\d{2})[,.](\d{1,3})$/;

function timestampSeconds(value: string, cue: number): number {
	const match = TIMESTAMP.exec(value);
	if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) {
		throw new Error(`Invalid SRT timestamp in cue ${cue}.`);
	}
	const sec =
		Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(`0.${match[4]}`);
	if (!Number.isFinite(sec)) throw new Error(`Invalid SRT timestamp in cue ${cue}.`);
	return sec;
}

/** Import SRT as phrase-aligned text. A cue has exactly one editable unit;
 * SRT contains no evidence for assigning separate timestamps to its words. */
export function parseSrtTranscript(
	assetId: string,
	srtText: string,
	options: { durationSec?: number } = {},
): AxcutTranscript {
	const text = srtText
		.replace(/^\uFEFF/, "")
		.replace(/\r\n?/g, "\n")
		.trim();
	if (!text) throw new Error("The SRT file contains no subtitle cues.");
	const transcript: AxcutTranscript = {
		assetId,
		language: "auto",
		timingGranularity: "phrase",
		segments: [],
		words: [],
	};
	const blocks = text.split(/\n[\t ]*\n+/);
	for (const [index, block] of blocks.entries()) {
		const cue = index + 1;
		const lines = block.split("\n");
		if (/^\d+$/.test(lines[0].trim())) lines.shift();
		const timing = lines
			.shift()
			?.trim()
			.match(/^(\S+)\s+-->\s+(\S+)$/);
		if (!timing) throw new Error(`Invalid SRT timing line in cue ${cue}.`);
		const startSec = timestampSeconds(timing[1], cue);
		const endSec = timestampSeconds(timing[2], cue);
		if (endSec <= startSec) throw new Error(`SRT cue ${cue} must end after it starts.`);
		const previous = transcript.segments.at(-1);
		if (previous && startSec < previous.startSec) {
			throw new Error(`SRT cue ${cue} is earlier than the preceding cue.`);
		}
		const duration = options.durationSec;
		if (
			duration !== undefined &&
			Number.isFinite(duration) &&
			duration > 0 &&
			endSec > duration + SRT_DURATION_TOLERANCE_SEC
		) {
			throw new Error(`SRT cue ${cue} extends beyond this media's duration.`);
		}
		const cueText = lines.join("\n").trim();
		if (!cueText) throw new Error(`SRT cue ${cue} has no subtitle text.`);
		const segmentId = `srt_segment_${cue}`;
		const wordId = `srt_phrase_${cue}`;
		transcript.segments.push({
			id: segmentId,
			kind: "speech",
			startSec,
			endSec,
			text: cueText,
			wordIds: [wordId],
		});
		transcript.words.push({ id: wordId, segmentId, startSec, endSec, text: cueText });
	}
	return transcript;
}
