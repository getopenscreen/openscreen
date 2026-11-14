import {
	AudioSample,
	AudioSampleSource,
	BlobSource,
	BufferTarget,
	Mp4OutputFormat,
	Output,
	StreamSource,
	StreamTarget,
	type StreamTargetChunk,
} from "mediabunny";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AxcutDocument, createEmptyDocument } from "@/lib/ai-edition/schema";
import { extractAudio, isolateAudioTrack } from "./audioExport";

function track(id: string, trackId: string, muted = false): AxcutDocument["audioTracks"][number] {
	return {
		id,
		trackId,
		startMs: 0,
		endMs: 1000,
		assetId: "asset_voice",
		kind: "voiceover",
		durationSec: 1,
		offsetMs: 0,
		gainDb: 0,
		loop: false,
		fadeInMs: 0,
		fadeOutMs: 0,
		muted,
		label: "",
		origin: "agent",
	};
}

describe("isolateAudioTrack", () => {
	const document: AxcutDocument = {
		...createEmptyDocument({ projectId: "p", title: "Demo" }),
		// "voice" is one pill split across two clips; "music" is another track.
		audioTracks: [track("a", "voice"), track("b", "voice"), track("c", "music")],
	};

	it("keeps every fragment of the asked track and nothing else", () => {
		expect(isolateAudioTrack(document, "voice").audioTracks.map((t) => t.id)).toEqual(["a", "b"]);
	});

	it("refuses an unknown or muted track", () => {
		expect(() => isolateAudioTrack(document, "nope")).toThrow('no audio track with the id "nope"');
		const muted = { ...document, audioTracks: [track("c", "music", true)] };
		expect(() => isolateAudioTrack(muted, "music")).toThrow("is muted");
	});
});

/** A short MP4 with a PCM track: both formats then copy its packets, so the test needs no
 *  decoder, which Node does not have. */
async function pcmFixture(): Promise<Uint8Array<ArrayBuffer>> {
	const sampleRate = 48_000;
	const frames = sampleRate * 3;
	const pcm = new Int16Array(frames * 2);
	for (let i = 0; i < frames; i++) {
		pcm[i * 2] = Math.round(12_000 * Math.sin((i * 2 * Math.PI * 440) / sampleRate));
		pcm[i * 2 + 1] = (i * 37) % 20_000;
	}
	const target = new BufferTarget();
	const output = new Output({ format: new Mp4OutputFormat(), target });
	const source = new AudioSampleSource({ codec: "pcm-s16" });
	output.addAudioTrack(source);
	await output.start();
	const sample = new AudioSample({
		data: pcm,
		format: "s16",
		numberOfChannels: 2,
		sampleRate,
		timestamp: 0,
	});
	await source.add(sample);
	sample.close();
	await output.finalize();
	if (!target.buffer) throw new Error("The fixture was not written");
	return new Uint8Array(target.buffer);
}

describe("extractAudio", () => {
	// An MP4 carries the second it was written in: the two writes must share it.
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-01T00:00:00Z") });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it.each([
		"wav",
		"m4a",
	] as const)("writes the same %s streamed in chunks as buffered whole", async (format) => {
		const video = await pcmFixture();

		// As the export did before it streamed: the whole file in, the whole file out.
		const buffered = new BufferTarget();
		await extractAudio(new BlobSource(new Blob([video])), buffered, format);

		// As the runner does: ranges read on demand, chunks written at their position.
		let reads = 0;
		let written = new Uint8Array(0);
		const source = new StreamSource({
			getSize: () => video.byteLength,
			read: (start, end) => {
				reads++;
				return video.slice(start, end);
			},
			maxCacheSize: 64 * 1024,
		});
		const writable = new WritableStream<StreamTargetChunk>({
			write: ({ data, position }) => {
				if (position + data.byteLength > written.byteLength) {
					const grown = new Uint8Array(position + data.byteLength);
					grown.set(written);
					written = grown;
				}
				written.set(data, position);
			},
		});
		await extractAudio(
			source,
			new StreamTarget(writable, { chunked: true, chunkSize: 64 * 1024 }),
			format,
		);

		expect(reads).toBeGreaterThan(1);
		expect(buffered.buffer?.byteLength).toBeGreaterThan(500_000);
		expect(Buffer.from(written).equals(Buffer.from(buffered.buffer as ArrayBuffer))).toBe(true);
	});
});
