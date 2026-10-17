import { describe, expect, it } from "vitest";
import { webcamRecorderOptions } from "./webcamRecorderOptions";

describe("webcam recorder options", () => {
	it("avoids the macOS H.264 camera encoder even when it advertises support", () => {
		expect(webcamRecorderOptions(null, "darwin", () => true).mimeType).toBe(
			"video/webm;codecs=vp8",
		);
	});

	it.each(["win32", "linux"])("keeps H.264 preferred on %s", (platform) => {
		expect(webcamRecorderOptions(null, platform, () => true).mimeType).toBe(
			"video/webm;codecs=h264",
		);
	});

	it("negotiates another supported codec when VP8 is unavailable", () => {
		expect(webcamRecorderOptions(null, "darwin", (type) => type.endsWith("vp9")).mimeType).toBe(
			"video/webm;codecs=vp9",
		);
	});

	it("lets MediaRecorder negotiate when no explicit codec is supported", () => {
		expect(webcamRecorderOptions(null, "darwin", () => false)).not.toHaveProperty("mimeType");
	});

	it("uses the delivered camera dimensions for bitrate", () => {
		const stream = {
			getVideoTracks: () => [{ getSettings: () => ({ width: 1920, height: 1080 }) }],
		} as unknown as MediaStream;
		expect(webcamRecorderOptions(stream, "darwin", () => true).videoBitsPerSecond).toBe(16_000_000);
	});
});
