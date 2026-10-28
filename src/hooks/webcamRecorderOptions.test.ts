import { describe, expect, it } from "vitest";
import { webcamRecorderOptions } from "./webcamRecorderOptions";

const camera = (width: number, height: number) =>
	({
		getVideoTracks: () => [{ getSettings: () => ({ width, height }) }],
	}) as unknown as MediaStream;

describe("webcam recorder options", () => {
	it("avoids the macOS H.264 camera encoder at 1080p even when it advertises support", () => {
		expect(webcamRecorderOptions(camera(1920, 1080), "darwin", () => true).mimeType).toBe(
			"video/webm;codecs=vp8",
		);
	});

	it.each([
		[2560, 1440],
		[3840, 2160],
	])("keeps H.264 on macOS above 1080p (%ix%i), where VP8 drops frames", (width, height) => {
		expect(webcamRecorderOptions(camera(width, height), "darwin", () => true).mimeType).toBe(
			"video/webm;codecs=h264",
		);
	});

	it("keeps H.264 on macOS when the delivered size is unknown", () => {
		expect(webcamRecorderOptions(null, "darwin", () => true).mimeType).toBe(
			"video/webm;codecs=h264",
		);
	});

	it.each(["win32", "linux"])("keeps H.264 preferred on %s", (platform) => {
		expect(webcamRecorderOptions(camera(1920, 1080), platform, () => true).mimeType).toBe(
			"video/webm;codecs=h264",
		);
	});

	it("negotiates another supported codec when VP8 is unavailable", () => {
		expect(
			webcamRecorderOptions(camera(1280, 720), "darwin", (type) => type.endsWith("vp9")).mimeType,
		).toBe("video/webm;codecs=vp9");
	});

	it("lets MediaRecorder negotiate when no explicit codec is supported", () => {
		expect(webcamRecorderOptions(null, "darwin", () => false)).not.toHaveProperty("mimeType");
	});

	it("uses the delivered camera dimensions for bitrate", () => {
		expect(webcamRecorderOptions(camera(1920, 1080), "darwin", () => true).videoBitsPerSecond).toBe(
			16_000_000,
		);
	});
});
