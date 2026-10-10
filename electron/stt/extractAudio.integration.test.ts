import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Only the binary lookup is replaced: extraction still spawns and reads real FFmpeg.
vi.mock("../media/audioPeaks", async (importOriginal) => ({
	...(await importOriginal<typeof import("../media/audioPeaks")>()),
	resolveFfmpeg: () => "ffmpeg",
}));

import { extractMono16kPcm } from "./extractAudio";

const ffmpegAvailable = spawnSync("ffmpeg", ["-version"], { timeout: 5_000 }).status === 0;

if (!ffmpegAvailable) {
	console.warn("Skipping audio-origin integration tests: FFmpeg is unavailable on PATH.");
}

describe.skipIf(!ffmpegAvailable)("extractMono16kPcm with real FFmpeg", () => {
	let fixtureDir: string;
	let delayedVideo: string;
	let standaloneAudio: string;
	let twoTracks: string;

	function makeFixture(filename: string, args: string[]): string {
		const filePath = path.join(fixtureDir, filename);
		const result = spawnSync(
			"ffmpeg",
			["-hide_banner", "-loglevel", "error", "-y", ...args, filePath],
			{ encoding: "utf8", timeout: 10_000 },
		);
		if (result.status !== 0) {
			throw new Error(result.error?.message ?? result.stderr);
		}
		return filePath;
	}

	beforeAll(() => {
		fixtureDir = mkdtempSync(path.join(tmpdir(), "openscreen-stt-audio-origin-"));
		const tone = [
			"-itsoffset",
			"2",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:sample_rate=16000:duration=2",
		];
		delayedVideo = makeFixture("delayed.mkv", [
			"-f",
			"lavfi",
			"-i",
			"color=c=black:s=16x16:r=1:d=4",
			...tone,
			"-map",
			"0:v",
			"-map",
			"1:a",
			"-c:v",
			"ffv1",
			"-c:a",
			"pcm_s16le",
		]);
		standaloneAudio = makeFixture("standalone.mka", [...tone, "-c:a", "pcm_s16le"]);
		// An older macOS recording: system audio and microphone as two streams. The
		// system track is stereo, so it is the one ffmpeg picks on its own, and it is
		// silent; the microphone, mono, speaks from the first second.
		twoTracks = makeFixture("two-tracks.mkv", [
			"-f",
			"lavfi",
			"-i",
			"color=c=black:s=16x16:r=1:d=4",
			"-f",
			"lavfi",
			"-i",
			"anullsrc=r=16000:cl=stereo:d=4",
			"-itsoffset",
			"1",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:sample_rate=16000:duration=3",
			"-map",
			"0:v",
			"-map",
			"1:a",
			"-map",
			"2:a",
			"-c:v",
			"ffv1",
			"-c:a",
			"pcm_s16le",
		]);
	});

	afterAll(() => {
		if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
	});

	it("keeps delayed audio on the video's clock", async () => {
		// The audio stream starts two seconds after video, without encoded silence.
		// Dropping that timestamp gap makes every word and text cut two seconds early.
		const samples = await extractMono16kPcm(delayedVideo);
		expect(samples).toHaveLength(4 * 16_000);
		expect(samples.subarray(0, 2 * 16_000).every((sample) => sample === 0)).toBe(true);
		const firstAudibleSample = samples.findIndex((sample) => Math.abs(sample) > 0.01);
		expect(firstAudibleSample).toBeGreaterThanOrEqual(2 * 16_000);
		expect(firstAudibleSample).toBeLessThan(2 * 16_000 + 16);
	});

	it("keeps standalone audio relative to its own media origin", async () => {
		// This container starts at two seconds too, but has no earlier video stream.
		// Its own origin is still zero: padding it would invent two seconds of silence.
		const samples = await extractMono16kPcm(standaloneAudio);
		expect(samples).toHaveLength(2 * 16_000);
		const firstAudibleSample = samples.findIndex((sample) => Math.abs(sample) > 0.01);
		expect(firstAudibleSample).toBeGreaterThanOrEqual(0);
		expect(firstAudibleSample).toBeLessThan(16);
	});

	it("transcribes every audio stream, each on the media clock, as the export mixes them", async () => {
		// Decoding only ffmpeg's pick yields the silent system track: no transcript,
		// while the exported video has the voice in it.
		const samples = await extractMono16kPcm(twoTracks);
		expect(samples).toHaveLength(4 * 16_000);
		const firstAudibleSample = samples.findIndex((sample) => Math.abs(sample) > 0.01);
		expect(firstAudibleSample).toBeGreaterThanOrEqual(16_000);
		expect(firstAudibleSample).toBeLessThan(16_000 + 16);
	});
});
