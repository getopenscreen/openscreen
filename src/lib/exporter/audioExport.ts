// Audio-only exports (issue #1280): a project's audio written out as a WAV or an M4A.
//
// The compositor has no audio-only render, and a second mixer here would drift from the one
// the MP4 uses (voice levelling, music ducking, the limiter, where a track lands past a speed
// region). So the audio is the MP4's: the export renders the project as usual, and its audio
// stream is taken out of that file. A track exported alone is the same render with everything
// else silenced, so it keeps the offset, trims, gain and fades the video export gives it.

import {
	ALL_FORMATS,
	BlobSource,
	BufferTarget,
	Conversion,
	Input,
	Mp4OutputFormat,
	Output,
	WavOutputFormat,
} from "mediabunny";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import { trackGroupId } from "@/lib/ai-edition/document/audioTracks";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { getEditorSettings } from "@/lib/ai-edition/store/editorSettings";
import type { AudioExportFormat } from "@/lib/cliContracts";
import type { SceneDescription } from "@/native/sceneDescription";

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

/** The audio stream of an exported MP4, as a WAV (decoded) or an M4A (the AAC copied as is). */
export async function extractAudio(video: Blob, format: AudioExportFormat): Promise<ArrayBuffer> {
	const input = new Input({ source: new BlobSource(video), formats: ALL_FORMATS });
	try {
		const target = new BufferTarget();
		const output = new Output({
			format: format === "wav" ? new WavOutputFormat() : new Mp4OutputFormat(),
			target,
		});
		const conversion = await Conversion.init({ input, output, video: { discard: true } });
		if (!conversion.isValid) {
			throw new Error("The rendered video has no audio to export");
		}
		await conversion.execute();
		if (!target.buffer) throw new Error("The audio export produced no output");
		return target.buffer;
	} finally {
		input.dispose();
	}
}

/** Nothing in the export makes a sound: the recording is muted and no track or click plays
 *  (#1104). */
export function exportIsSilent(
	document: AxcutDocument,
	scene: Pick<SceneDescription, "audioTracks" | "clickSound">,
): boolean {
	return (
		getEditorSettings(document).recordingMuted &&
		scene.audioTracks.length === 0 &&
		!scene.clickSound
	);
}

/** Rewrites an exported MP4 without its audio stream, the video copied as is. The compositor
 *  always muxes an AAC stream, so a silent export would otherwise carry a silent track.
 *  ponytail: the file goes through memory, as the voiceover mix does; a native "no audio"
 *  flag would spare that on long exports. */
export async function removeAudioStream(path: string): Promise<void> {
	const response = await fetch(toFileUrl(path));
	if (!response.ok) throw new Error(`Failed to read the exported video back: ${path}`);
	const input = new Input({ source: new BlobSource(await response.blob()), formats: ALL_FORMATS });
	let buffer: ArrayBuffer | null;
	try {
		const target = new BufferTarget();
		const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });
		const conversion = await Conversion.init({ input, output, audio: { discard: true } });
		await conversion.execute();
		buffer = target.buffer;
	} finally {
		input.dispose();
	}
	if (!buffer) throw new Error("Removing the audio produced no output");
	const saved = await window.electronAPI.writeExportToPath(buffer, path);
	if (!saved.success) throw new Error(saved.message ?? `Failed to write ${path}`);
}
