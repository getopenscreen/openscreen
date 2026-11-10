import { readFile } from "node:fs/promises";
import {
	ALL_FORMATS,
	AudioSample,
	AudioSampleSource,
	BlobSource,
	BufferSource,
	BufferTarget,
	EncodedPacketSink,
	Input,
	Mp4OutputFormat,
	Output,
	StreamSource,
	StreamTarget,
	type StreamTargetChunk,
} from "mediabunny";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AxcutDocument, createEmptyDocument } from "@/lib/ai-edition/schema";
import { exportIsSilent, extractAudio, isolateAudioTrack } from "./audioExport";

/** AAC whose priming starts at -23 ms, as the compositor's MP4 render holds it (the encoder's
 *  1024-sample delay behind an edit list). */
async function renderLikeMp4(): Promise<ArrayBuffer> {
	const bytes = await readFile("electron/media/__fixtures__/peaks-sample.m4a");
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function audioPackets(bytes: ArrayBuffer) {
	const input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	try {
		const track = await input.getPrimaryAudioTrack();
		if (!track) throw new Error("no audio track");
		let count = 0;
		for await (const _ of new EncodedPacketSink(track).packets()) count++;
		return { codec: track.codec, count, first: await track.getFirstTimestamp() };
	} finally {
		input.dispose();
	}
}

describe("extractAudio of the render's AAC", () => {
	// Starting at -23 ms sent the conversion down its re-encode path, which Linux's Chromium
	// can only take to Opus (it has no AAC encoder): an ".m4a" holding Opus. Node has no
	// AudioDecoder either, so here that path fails outright.
	it("copies the render's AAC into the M4A, priming included", async () => {
		const render = await renderLikeMp4();
		const source = await audioPackets(render);
		expect(source.first).toBeLessThan(0);

		const target = new BufferTarget();
		await extractAudio(new BufferSource(render), target, "m4a");
		const m4a = await audioPackets(target.buffer as ArrayBuffer);

		expect(m4a.codec).toBe("aac");
		expect(m4a.count).toBe(source.count);
	});
});

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

describe("exportIsSilent (#1104)", () => {
	const base = createEmptyDocument({ projectId: "p", title: "Demo" });
	const muted: AxcutDocument = { ...base, legacyEditor: { recordingMuted: true } };
	const noSound = { audioTracks: [] };

	it("is silent only when the recording is muted and nothing else plays", () => {
		expect(exportIsSilent(muted, noSound)).toBe(true);
		expect(exportIsSilent(base, noSound)).toBe(false);
	});

	it("keeps the audio for an added track or the clicks", () => {
		const track = {} as Parameters<typeof exportIsSilent>[1]["audioTracks"][number];
		expect(exportIsSilent(muted, { audioTracks: [track] })).toBe(false);
		const clickSound = {} as NonNullable<Parameters<typeof exportIsSilent>[1]["clickSound"]>;
		expect(exportIsSilent(muted, { audioTracks: [], clickSound })).toBe(false);
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
