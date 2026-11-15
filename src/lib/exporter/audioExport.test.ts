import { readFile } from "node:fs/promises";
import {
	ALL_FORMATS,
	BufferSource,
	BufferTarget,
	EncodedAudioPacketSource,
	EncodedPacketSink,
	Input,
	Mp4OutputFormat,
	Output,
} from "mediabunny";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AxcutDocument, createEmptyDocument } from "@/lib/ai-edition/schema";
import { extractRenderedAudio, isolateAudioTrack } from "./audioExport";

/** An MP4 holding the fixture's AAC from 0 s, as a render does. Node has no AudioDecoder, so the
 *  M4A export must take its copy path: the fixture's priming starts at -23 ms, which would not. */
async function renderLikeMp4(): Promise<ArrayBuffer> {
	const bytes = await readFile("electron/media/__fixtures__/peaks-sample.m4a");
	const input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	try {
		const track = await input.getPrimaryAudioTrack();
		if (!track) throw new Error("the fixture has no audio");
		const target = new BufferTarget();
		const output = new Output({ format: new Mp4OutputFormat(), target });
		const source = new EncodedAudioPacketSource("aac");
		output.addAudioTrack(source);
		await output.start();
		const decoderConfig = (await track.getDecoderConfig()) ?? undefined;
		const start = await track.getFirstTimestamp();
		for await (const packet of new EncodedPacketSink(track).packets()) {
			await source.add(packet.clone({ timestamp: packet.timestamp - start }), { decoderConfig });
		}
		await output.finalize();
		if (!target.buffer) throw new Error("no MP4 written");
		return target.buffer;
	} finally {
		input.dispose();
	}
}

describe("extractRenderedAudio", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("reads the render as bytes, never through a Blob", async () => {
		const render = await renderLikeMp4();
		// What Chromium does with a Blob it must page to disk on a volume low on space.
		const fetchMock = vi.fn(async () => ({
			ok: true,
			blob: () => Promise.reject(new TypeError("Failed to fetch")),
			arrayBuffer: async () => render,
		}));
		vi.stubGlobal("fetch", fetchMock);

		const audio = await extractRenderedAudio("file:///out.wav.render.mp4", "m4a");

		expect(fetchMock).toHaveBeenCalledWith("file:///out.wav.render.mp4");
		const input = new Input({ source: new BufferSource(audio), formats: ALL_FORMATS });
		try {
			expect(await input.getPrimaryAudioTrack()).not.toBeNull();
		} finally {
			input.dispose();
		}
	});

	it("names the render it could not read", async () => {
		vi.stubGlobal("fetch", async () => ({ ok: false }));
		await expect(extractRenderedAudio("file:///gone.render.mp4", "wav")).rejects.toThrow(
			"Failed to read the rendered video back: file:///gone.render.mp4",
		);
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
