import { readFile } from "node:fs/promises";
import { ALL_FORMATS, BufferSource, EncodedPacketSink, Input } from "mediabunny";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AxcutDocument, createEmptyDocument } from "@/lib/ai-edition/schema";
import { extractRenderedAudio, isolateAudioTrack } from "./audioExport";

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

	// Starting at -23 ms sent the conversion down its re-encode path, which Linux's Chromium
	// can only take to Opus (it has no AAC encoder): an ".m4a" holding Opus. Node has no
	// AudioDecoder either, so here that path fails outright.
	it("copies the render's AAC into the M4A, priming included", async () => {
		const render = await renderLikeMp4();
		vi.stubGlobal("fetch", async () => ({ ok: true, arrayBuffer: async () => render }));

		const source = await audioPackets(render);
		expect(source.first).toBeLessThan(0);
		const m4a = await audioPackets(await extractRenderedAudio("file:///x.render.mp4", "m4a"));

		expect(m4a.codec).toBe("aac");
		expect(m4a.count).toBe(source.count);
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
