import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mixVoiceoverIntoExportedVideo } from "./voiceoverMix";

describe("mixVoiceoverIntoExportedVideo", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("reads the export as bytes, never through a Blob", async () => {
		// An MP4 with no video track: the mix stops at its first check, once the bytes are parsed.
		const bytes = await readFile("electron/media/__fixtures__/peaks-sample.m4a");
		const video = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
		// What Chromium does with a Blob it must page to disk on a volume low on space.
		const fetchMock = vi.fn(async () => ({
			ok: true,
			blob: () => Promise.reject(new TypeError("Failed to fetch")),
			arrayBuffer: async () => video,
		}));
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			mixVoiceoverIntoExportedVideo("file:///out.mp4", {
				voiceoverData: new ArrayBuffer(0),
				mode: "mix",
				offsetSec: 0,
			}),
		).rejects.toThrow("Exported file has no video track to remux");
		expect(fetchMock).toHaveBeenCalledWith("file:///out.mp4");
	});

	it("names the export it could not read", async () => {
		vi.stubGlobal("fetch", async () => ({ ok: false }));
		await expect(
			mixVoiceoverIntoExportedVideo("file:///gone.mp4", {
				voiceoverData: new ArrayBuffer(0),
				mode: "replace",
				offsetSec: 0,
			}),
		).rejects.toThrow("Failed to read the exported video back for mixing: file:///gone.mp4");
	});
});
