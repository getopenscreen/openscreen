// Audio-only exports (issue #1280): a project's audio written out as a WAV or an M4A.
//
// The compositor has no audio-only render, and a second mixer here would drift from the one
// the MP4 uses (voice levelling, music ducking, the limiter, where a track lands past a speed
// region). So the audio is the MP4's: the export renders the project as usual, and its audio
// stream is taken out of that file. A track exported alone is the same render with everything
// else silenced, so it keeps the offset, trims, gain and fades the video export gives it.

import {
	ALL_FORMATS,
	Conversion,
	Input,
	Mp4OutputFormat,
	Output,
	type Source,
	type Target,
	WavOutputFormat,
} from "mediabunny";
import { trackGroupId } from "@/lib/ai-edition/document/audioTracks";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import type { AudioExportFormat } from "@/lib/cliContracts";

/** The project with one imported track left of its audio tracks; throws when it has no such
 *  track. The take's own sound and the clicks are silenced at render time, not here. */
export function isolateAudioTrack(document: AxcutDocument, audioId: string): AxcutDocument {
	const audioTracks = document.audioTracks.filter((track) => trackGroupId(track) === audioId);
	if (audioTracks.length === 0) {
		throw new Error(`This project has no audio track with the id "${audioId}"`);
	}
	if (audioTracks.every((track) => track.muted)) {
		throw new Error(`The audio track "${audioId}" is muted: unmute it to export it`);
	}
	return { ...document, audioTracks };
}

/** The audio stream of an exported MP4, as a WAV (decoded) or an M4A (the AAC copied as is),
 *  written to `target` as it is read from `video`. */
export async function extractAudio(
	video: Source,
	target: Target,
	format: AudioExportFormat,
): Promise<void> {
	const input = new Input({ source: video, formats: ALL_FORMATS });
	try {
		// The M4A's layout is named so that the file is the same whatever the target: left to
		// itself, mediabunny puts the index last on a streamed target.
		// ponytail: the index first keeps the AAC in memory until the end, about 1 MB a minute.
		// Write it last (`fastStart: false`) if that ever matters.
		const output = new Output({
			format:
				format === "wav" ? new WavOutputFormat() : new Mp4OutputFormat({ fastStart: "in-memory" }),
			target,
		});
		const conversion = await Conversion.init({ input, output, video: { discard: true } });
		if (!conversion.isValid) {
			throw new Error("The rendered video has no audio to export");
		}
		await conversion.execute();
	} finally {
		input.dispose();
	}
}
