// @vitest-environment node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	countAudioStreams,
	decodePeaks,
	ffmpegCandidates,
	mediaClockAudioArgs,
	peakBlockCount,
	resolveFfmpeg,
} from "./audioPeaks";

const ROOT = path.resolve(__dirname, "..", "..");

function stripJson5Comments(source: string): string {
	let out = "";
	let inString = false;
	for (let i = 0; i < source.length; i++) {
		const ch = source[i];
		if (inString) {
			out += ch;
			if (ch === "\\") {
				out += source[++i] ?? "";
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
			continue;
		}
		if (ch === "/" && source[i + 1] === "/") {
			while (i < source.length && source[i] !== "\n") i++;
			out += "\n";
			continue;
		}
		out += ch;
	}
	return out;
}

function objectBody(source: string, key: string): string | null {
	const opener = new RegExp(`"${key}"\\s*:\\s*{`).exec(source);
	if (!opener) return null;
	let depth = 0;
	for (let i = opener.index + opener[0].length - 1; i < source.length; i++) {
		if (source[i] === "{") depth++;
		else if (source[i] === "}" && --depth === 0) {
			return source.slice(opener.index + opener[0].length, i);
		}
	}
	return null;
}

describe("peakBlockCount", () => {
	it("matches the browser pipelines' block maths", () => {
		// Same formula as audioPeaksWorker.ts / streamingAudioPeaks.ts: a clip must
		// not change shape depending on which pipeline drew it.
		expect(peakBlockCount(10)).toBe(2000);
		expect(peakBlockCount(60)).toBe(12000);
		// Capped, so a 30-minute recording costs the same DOM/array budget as a
		// 2-minute one.
		expect(peakBlockCount(1951)).toBe(24000);
		expect(peakBlockCount(99999)).toBe(24000);
	});

	it("never returns zero blocks for a sliver of audio", () => {
		expect(peakBlockCount(0.001)).toBe(1);
	});
});

describe("ffmpeg resolution", () => {
	it("prefers the shared build the installer actually ships", () => {
		const candidates = ffmpegCandidates(ROOT);
		const shared = candidates.findIndex((c) => c.endsWith("ffmpeg-shared.exe"));
		const vendorTree = candidates.findIndex((c) => c.includes("lgpl-shared"));
		if (process.platform === "win32") {
			expect(shared).toBeGreaterThanOrEqual(0);
			// The static ffmpeg.exe is excluded from the Windows installer
			// ("!win32-*/ffmpeg.exe"), so resolving to it would work in dev and fail
			// in production. It must not be a candidate at all.
			expect(
				candidates.some((c) => c.endsWith(`bin${path.sep}win32-x64${path.sep}ffmpeg.exe`)),
			).toBe(false);
			expect(shared).toBeLessThan(vendorTree);
		}
	});

	it("ensures the Windows installer filter packages ffmpeg-shared.exe", () => {
		const configSource = readFileSync(path.join(ROOT, "electron-builder.json5"), "utf8");
		const stripped = stripJson5Comments(configSource);
		const winBlock = objectBody(stripped, "win");
		expect(winBlock, "electron-builder.json5 must declare a win block").toBeTruthy();
		const winFilterMatch = winBlock!.match(/"filter"\s*:\s*\[([^\]]+)\]/);
		expect(winFilterMatch, "win.extraResources must declare a filter").toBeTruthy();
		const filters = winFilterMatch![1]
			.split(",")
			.map((f: string) => f.trim().replace(/^["']|["']$/g, ""));
		// Static ffmpeg.exe must be excluded
		expect(filters).toContain("!win32-*/ffmpeg.exe");
		// ffmpeg-shared.exe must NOT be excluded
		expect(filters).not.toContain("!win32-*/ffmpeg-shared.exe");
		// Verify win32 candidate survives the filter rules
		const relativePath = "win32-x64/ffmpeg-shared.exe";
		const isIncluded = filters.some(
			(f: string) =>
				!f.startsWith("!") && new RegExp(`^${f.replace(/\*/g, ".*")}$`).test(relativePath),
		);
		const isExcluded = filters.some(
			(f: string) =>
				f.startsWith("!") && new RegExp(`^${f.slice(1).replace(/\*/g, ".*")}$`).test(relativePath),
		);
		expect(isIncluded && !isExcluded).toBe(true);
	});

	it("honours the env override first", () => {
		process.env.OPENSCREEN_FFMPEG_PATH = "/custom/ffmpeg";
		try {
			expect(ffmpegCandidates(ROOT)[0]).toBe("/custom/ffmpeg");
		} finally {
			process.env.OPENSCREEN_FFMPEG_PATH = undefined;
		}
	});

	it("returns null rather than throwing when nothing is staged", () => {
		expect(resolveFfmpeg(path.join(ROOT, "does", "not", "exist"))).toBeNull();
	});

	/**
	 * The shape that slipped through. A Linux dev checkout used to have
	 * `electron/native/bin/<tag>/ffmpeg` as a DIRECTORY of shared libraries
	 * rather than the binary; `existsSync` accepted it, resolution stopped
	 * there, and the failure only surfaced later as `spawn … EACCES`.
	 *
	 * That particular collision is gone — the helper's libraries moved to
	 * `helper-ffmpeg/` — but the assertion stays, because it is really about
	 * `resolveFfmpeg` not confusing existence with executability, and the next
	 * thing to land a directory on a candidate path will not announce itself
	 * either.
	 */
	it("skips a candidate that is a directory rather than the binary", () => {
		const here = mkdtempSync(path.join(tmpdir(), "openscreen-ffmpeg-"));
		const tag = `${process.platform}-${process.arch}`;
		const name = process.platform === "win32" ? "ffmpeg-shared.exe" : "ffmpeg";
		const staged = path.join(here, "electron", "native", "bin", tag, name);
		try {
			// A directory sitting exactly where the executable is looked for.
			mkdirSync(staged, { recursive: true });
			writeFileSync(path.join(staged, "libavcodec.so.62"), "");

			expect(resolveFfmpeg(here)).toBeNull();
		} finally {
			rmSync(here, { recursive: true, force: true });
		}
	});

	it("accepts a candidate that is an executable file", () => {
		const here = mkdtempSync(path.join(tmpdir(), "openscreen-ffmpeg-"));
		const tag = `${process.platform}-${process.arch}`;
		const name = process.platform === "win32" ? "ffmpeg-shared.exe" : "ffmpeg";
		const staged = path.join(here, "electron", "native", "bin", tag, name);
		try {
			mkdirSync(path.dirname(staged), { recursive: true });
			writeFileSync(staged, "", { mode: 0o755 });

			expect(resolveFfmpeg(here)).toBe(staged);
		} finally {
			rmSync(here, { recursive: true, force: true });
		}
	});

	// Non-executable files are the other half of the predicate, and the check is
	// only meaningful where the OS enforces the bit.
	it.runIf(process.platform !== "win32")(
		"skips a candidate that is a file but not executable",
		() => {
			const here = mkdtempSync(path.join(tmpdir(), "openscreen-ffmpeg-"));
			const staged = path.join(
				here,
				"electron",
				"native",
				"bin",
				`${process.platform}-${process.arch}`,
				"ffmpeg",
			);
			try {
				mkdirSync(path.dirname(staged), { recursive: true });
				writeFileSync(staged, "", { mode: 0o644 });

				expect(resolveFfmpeg(here)).toBeNull();
			} finally {
				rmSync(here, { recursive: true, force: true });
			}
		},
	);

	/**
	 * REJECTING IS NOT THE SAME AS CONTINUING, and only the second is the
	 * property the predicate exists for: swallowing every failure is what stops
	 * one bad path from denying a later working one. The tests above prove the
	 * first — with a single candidate staged, `null` is equally consistent with
	 * "skipped it" and "gave up on the whole list".
	 *
	 * `OPENSCREEN_FFMPEG_PATH` is the vehicle because `ffmpegCandidates` puts it
	 * FIRST, so a bad value there is the one case that could shadow every real
	 * candidate behind it.
	 */
	describe("falling through to a later candidate", () => {
		let here: string;
		let staged: string;

		beforeEach(() => {
			here = mkdtempSync(path.join(tmpdir(), "openscreen-ffmpeg-"));
			staged = path.join(
				here,
				"electron",
				"native",
				"bin",
				`${process.platform}-${process.arch}`,
				process.platform === "win32" ? "ffmpeg-shared.exe" : "ffmpeg",
			);
			mkdirSync(path.dirname(staged), { recursive: true });
			writeFileSync(staged, "", { mode: 0o755 });
		});

		afterEach(() => {
			delete process.env.OPENSCREEN_FFMPEG_PATH;
			rmSync(here, { recursive: true, force: true });
		});

		it("passes over a leading candidate that does not exist", () => {
			process.env.OPENSCREEN_FFMPEG_PATH = path.join(here, "nowhere", "ffmpeg");

			expect(resolveFfmpeg(here)).toBe(staged);
		});

		it("passes over a leading candidate that is a directory", () => {
			const decoy = path.join(here, "decoy-ffmpeg");
			mkdirSync(decoy, { recursive: true });
			writeFileSync(path.join(decoy, "libavcodec.so.62"), "");
			process.env.OPENSCREEN_FFMPEG_PATH = decoy;

			expect(resolveFfmpeg(here)).toBe(staged);
		});

		it.runIf(process.platform !== "win32")(
			"passes over a leading candidate that is not executable",
			() => {
				const decoy = path.join(here, "decoy-ffmpeg");
				writeFileSync(decoy, "", { mode: 0o644 });
				process.env.OPENSCREEN_FFMPEG_PATH = decoy;

				expect(resolveFfmpeg(here)).toBe(staged);
			},
		);

		// An unreadable-but-executable binary is legitimate on Unix, so it must be
		// ACCEPTED rather than fallen through — `X_OK` is deliberately not paired
		// with `R_OK`. Skipped as root, for whom access checks always pass.
		it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
			"still accepts an execute-only binary",
			() => {
				const executableOnly = path.join(here, "exec-only-ffmpeg");
				writeFileSync(executableOnly, "", { mode: 0o111 });
				process.env.OPENSCREEN_FFMPEG_PATH = executableOnly;

				expect(resolveFfmpeg(here)).toBe(executableOnly);
			},
		);
	});
});

// Only runs where the binary is actually staged; skipped elsewhere rather than
// failing a checkout that has not run scripts/fetch-ffmpeg.mjs.
const staged = resolveFfmpeg(ROOT);
describe.runIf(staged)("decoding a real file", () => {
	it("produces peaks in range, with real signal in them", async () => {
		// A synthetic 5s 440 Hz tone from ffmpeg's own lavfi source — no user
		// recording in the repo, and a signal whose shape is known rather than
		// "whatever this capture happened to contain".
		const fixture = path.join(ROOT, "electron", "media", "__fixtures__", "peaks-sample.m4a");
		if (!existsSync(fixture)) return;
		const { getAudioPeaks } = await import("./audioPeaks");
		const peaks = await getAudioPeaks(fixture, 5);
		expect(peaks).not.toBeNull();
		if (!peaks) return;
		expect(peaks.length).toBe(peakBlockCount(5) * 2);
		// [min, max] pairs, both inside [-1, 1], min <= 0 <= max (the folder starts
		// each block at the silence baseline, like the worker does).
		for (let i = 0; i < peaks.length; i += 2) {
			expect(peaks[i]).toBeLessThanOrEqual(0);
			expect(peaks[i + 1]).toBeGreaterThanOrEqual(0);
			expect(peaks[i]).toBeGreaterThanOrEqual(-1);
			expect(peaks[i + 1]).toBeLessThanOrEqual(1);
		}
		// Not all silence — otherwise everything above would pass on a pipeline
		// that returned a zeroed array.
		//
		// The bound is tight rather than "> 0" because loose is the same as
		// absent here: the mistakes worth catching are all scale errors — int16
		// divided by 65536 instead of 32768, a stereo downmix halving the signal,
		// a block whose samples never get compared — and every one of them is a
		// factor of two. 0.214 is what ffmpeg itself decodes this fixture to
		// (verified with `-f s16le` straight to a file), so this asserts the fold
		// agrees with the decoder rather than restating the fixture's nominal
		// amplitude, which lavfi's volume filter does not actually deliver.
		let mn = 0;
		let mx = 0;
		for (const v of peaks) {
			if (v < mn) mn = v;
			if (v > mx) mx = v;
		}
		expect(mx).toBeCloseTo(0.214, 1);
		expect(mn).toBeCloseTo(-0.205, 1);
	}, 120_000);
});

describe("countAudioStreams", () => {
	it("counts the audio streams in ffmpeg's listing, and nothing else", () => {
		// The layout of an older macOS recording, as ffmpeg 8.1 lists it.
		const listing = [
			"Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'recording.mp4':",
			"  Duration: 00:00:12.00, start: 0.000000, bitrate: 5012 kb/s",
			"  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 60 fps (default)",
			"  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo (default)",
			"    Metadata:",
			"      handler_name    : Audio: system",
			"  Stream #0:2[0x3](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, mono (default)",
			"At least one output file must be specified",
		].join("\n");
		expect(countAudioStreams(listing)).toBe(2);
		expect(countAudioStreams("  Stream #0:0: Video: ffv1, 16x16")).toBe(0);
	});
});

const ffmpegOnPath = spawnSync("ffmpeg", ["-version"], { timeout: 5_000 }).status === 0;

describe.skipIf(!ffmpegOnPath)("peaks on the media clock, with real FFmpeg", () => {
	let fixtureDir: string;
	let delayed: string;
	let twoTracks: string;

	/** A four-second video from zero, muxed with the given audio inputs, one stream each. */
	function makeFixture(filename: string, audioInputs: string[][]): string {
		const filePath = path.join(fixtureDir, filename);
		const result = spawnSync(
			"ffmpeg",
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-y",
				"-f",
				"lavfi",
				"-i",
				"color=c=black:s=16x16:r=1:d=4",
				...audioInputs.flat(),
				"-map",
				"0:v",
				...audioInputs.flatMap((_, i) => ["-map", `${i + 1}:a`]),
				"-c:v",
				"ffv1",
				"-c:a",
				"pcm_s16le",
				filePath,
			],
			{ encoding: "utf8", timeout: 10_000 },
		);
		if (result.status !== 0) throw new Error(result.error?.message ?? result.stderr);
		return filePath;
	}

	/** Seconds into the clip of the first block with signal in it, or -1. */
	function firstAudibleSec(peaks: Float32Array): number {
		for (let i = 0; i < peaks.length; i += 2) {
			if (peaks[i + 1] > 0.01) return i / 2 / 200;
		}
		return -1;
	}

	beforeAll(() => {
		fixtureDir = mkdtempSync(path.join(tmpdir(), "openscreen-peaks-clock-"));
		const delayedTone = (sec: number, duration: number) => [
			"-itsoffset",
			String(sec),
			"-f",
			"lavfi",
			"-i",
			`sine=frequency=440:sample_rate=16000:duration=${duration}`,
		];
		// Video from zero, audio from two seconds, no encoded silence in between.
		delayed = makeFixture("delayed.mkv", [delayedTone(2, 2)]);
		// Older macOS layout: a silent stereo system track, which is the stream ffmpeg
		// picks on its own, and a mono microphone speaking from the first second.
		twoTracks = makeFixture("two-tracks.mkv", [
			["-f", "lavfi", "-i", "anullsrc=r=16000:cl=stereo:d=4"],
			delayedTone(1, 3),
		]);
	});

	afterAll(() => {
		if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
	});

	it("draws audio that starts after the video where it plays, not at zero", async () => {
		// Pulled to zero, the waveform runs two seconds ahead of the transcript and of
		// the export, both of which keep the offset.
		const peaks = await decodePeaks("ffmpeg", delayed, 4);
		expect(peaks.length).toBe(peakBlockCount(4) * 2);
		expect(firstAudibleSec(peaks)).toBe(2);
	});

	it("draws every audio stream, each on the media clock, as the export mixes them", async () => {
		const peaks = await decodePeaks("ffmpeg", twoTracks, 4);
		expect(firstAudibleSec(peaks)).toBe(1);
	});

	it("kills the stream probe on abort instead of waiting it out", async () => {
		// Killed before it lists anything, the probe counts no stream at all.
		const args = await mediaClockAudioArgs("ffmpeg", twoTracks, AbortSignal.abort());
		expect(args).not.toContain("-filter_complex");
	});
});
