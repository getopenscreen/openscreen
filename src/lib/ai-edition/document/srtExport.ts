import type { CaptionCue } from "../captions/cues";
import type { AxcutTranscript } from "../schema";

function timestamp(milliseconds: number): string {
	const hours = Math.floor(milliseconds / 3_600_000);
	const minutes = Math.floor(milliseconds / 60_000) % 60;
	const seconds = Math.floor(milliseconds / 1_000) % 60;
	return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(milliseconds % 1_000).padStart(3, "0")}`;
}

/** Source transcript export. Timeline trims/speeds belong to the separate
 * timeline caption exporter, not this source-media round trip. */
export function serializeTranscriptSrt(transcript: AxcutTranscript): string {
	return serializeCaptionCuesSrt(
		transcript.segments
			.filter((segment) => segment.kind === "speech")
			.map((segment) => ({
				id: segment.id,
				startMs: segment.startSec * 1_000,
				endMs: segment.endSec * 1_000,
				text: segment.text,
			})),
	);
}

/** Cues must already use the intended export time base. The caller maps any
 * edited timeline trims/speeds before serializing them. */
export function serializeCaptionCuesSrt(captionCues: readonly CaptionCue[]): string {
	const cues: string[] = [];
	let previousStart = -1;
	for (const cue of captionCues) {
		const text = cue.text.replace(/\r\n?/g, "\n").trim();
		if (!text) continue;
		const start = Math.round(cue.startMs);
		const end = Math.round(cue.endMs);
		if (
			cue.startMs < 0 ||
			!Number.isSafeInteger(start) ||
			!Number.isSafeInteger(end) ||
			start < 0 ||
			end <= start ||
			start < previousStart
		) {
			throw new Error(`Invalid subtitle timing in segment ${cue.id}.`);
		}
		// Blank lines delimit SRT cues. Preserve intentional line breaks while
		// removing empty lines that would otherwise corrupt an exported cue.
		const cueText = text.replace(/\n[\t ]*\n+/g, "\n");
		cues.push(`${cues.length + 1}\n${timestamp(start)} --> ${timestamp(end)}\n${cueText}`);
		previousStart = start;
	}
	if (cues.length === 0) throw new Error("The transcript contains no subtitle cues.");
	return `${cues.join("\n\n")}\n`;
}
