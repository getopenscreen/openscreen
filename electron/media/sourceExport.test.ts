import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: undefined }));

import { resolveFfmpeg } from "./audioPeaks";
import {
	exportSourceAudioFile,
	exportSourceSrtFile,
	inspectSourceAudio,
	originalAudioExtension,
	sourceAudioArgs,
	unusedExportPath,
} from "./sourceExport";

const temporaryDirs: string[] = [];
async function fixtureDir(): Promise<string> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "openscreen-source-export-"));
	temporaryDirs.push(dir);
	return dir;
}
afterEach(async () => {
	await Promise.all(
		temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("audio export decisions", () => {
	it("stream-copies common codecs into compatible audio containers", () => {
		expect(originalAudioExtension("aac")).toBe("m4a");
		expect(originalAudioExtension("alac")).toBe("m4a");
		expect(originalAudioExtension("opus")).toBe("ogg");
		expect(originalAudioExtension("vorbis")).toBe("ogg");
		expect(originalAudioExtension("mp3")).toBe("mp3");
		expect(originalAudioExtension("flac")).toBe("flac");
		expect(originalAudioExtension("pcm_s24le")).toBe("wav");
		expect(originalAudioExtension("pcm_f32le")).toBe("wav");
		expect(originalAudioExtension("dts")).toBe("mka");
		const args = sourceAudioArgs("/source file.mp4", "/target.m4a", "original");
		expect(args).toContain("/source file.mp4");
		expect(args.slice(args.indexOf("-c:a"), args.indexOf("-c:a") + 2)).toEqual(["-c:a", "copy"]);
	});
	it("preserves PCM sample rate/channels and uses AAC present in the LGPL bundle", () => {
		const wav = sourceAudioArgs("/source.mp4", "/target.wav", "wav");
		expect(wav).toContain("pcm_s24le");
		expect(wav).toContain("-rf64");
		expect(wav).not.toContain("-ar");
		expect(wav).not.toContain("-ac");
		const compressed = sourceAudioArgs("/source.mp4", "/target.m4a", "m4a");
		expect(compressed).toContain("aac");
		expect(compressed).toContain("192k");
	});
	it("suggests a new filename and never overwrites existing SRT or source files", async () => {
		const dir = await fixtureDir();
		const source = path.join(dir, "source.mp4");
		const srt = path.join(dir, "source-subtitles.srt");
		await writeFile(source, "source bytes");
		await writeFile(srt, "existing subtitles");
		expect(await unusedExportPath(source, "-subtitles", "srt")).toBe(
			path.join(dir, "source-subtitles-2.srt"),
		);
		await expect(exportSourceSrtFile(source, srt, "replacement")).rejects.toThrow("already exists");
		await expect(
			exportSourceAudioFile({
				sourcePath: source,
				outputPath: source,
				format: "original",
				codec: "aac",
			}),
		).rejects.toThrow();
		expect(await readFile(srt, "utf8")).toBe("existing subtitles");
		expect(await readFile(source, "utf8")).toBe("source bytes");
	});
	it("does not follow an existing destination symlink or publish SRT with the wrong extension", async () => {
		const dir = await fixtureDir();
		const source = path.join(dir, "source.mp4");
		const alias = path.join(dir, "alias.srt");
		await writeFile(source, "original");
		await symlink(source, alias);
		await expect(exportSourceSrtFile(source, alias, "new")).rejects.toThrow("already exists");
		await expect(
			exportSourceSrtFile(source, path.join(dir, "source.session.json"), "new"),
		).rejects.toThrow(".srt");
		expect(await readFile(source, "utf8")).toBe("original");
	});
	it("writes UTF-8 subtitles beside the source with no temporary leftovers", async () => {
		const dir = await fixtureDir();
		const source = path.join(dir, "source.mp4");
		const target = path.join(dir, "source.srt");
		await writeFile(source, "original");
		const srt = "1\n00:00:00,000 --> 00:00:01,000\n繁體字幕\n";
		await exportSourceSrtFile(source, target, srt);
		expect(await readFile(target, "utf8")).toBe(srt);
		expect((await readdir(dir)).sort()).toEqual(["source.mp4", "source.srt"]);
	});
});

const ffmpeg = resolveFfmpeg();
describe.skipIf(!ffmpeg)("bundled ffmpeg synthetic audio round trip", () => {
	it("keeps original PCM in a WAV container with identical sample bytes", async () => {
		const dir = await fixtureDir();
		const source = path.join(dir, "source.wav");
		const outputPath = path.join(dir, "original.wav");
		execFileSync(ffmpeg!, [
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"sine=duration=0.2:sample_rate=48000",
			"-c:a",
			"pcm_s24le",
			source,
		]);
		const codec = await inspectSourceAudio(source);
		expect(originalAudioExtension(codec)).toBe("wav");
		await exportSourceAudioFile({ sourcePath: source, outputPath, format: "original", codec });
		const samples = (file: string) =>
			execFileSync(ffmpeg!, ["-v", "error", "-i", file, "-c:a", "copy", "-f", "s24le", "-"]);
		expect(samples(outputPath)).toEqual(samples(source));
	});
	it("exports all formats, preserves copied packet bytes and WAV rate/channels, and cleans failed/canceled jobs", async () => {
		const dir = await fixtureDir();
		const source = path.join(dir, "source with spaces.m4a");
		execFileSync(ffmpeg!, [
			"-hide_banner",
			"-loglevel",
			"error",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:sample_rate=48000:duration=2",
			"-ac",
			"2",
			"-c:a",
			"aac",
			source,
		]);
		const sourceHash = createHash("sha256")
			.update(await readFile(source))
			.digest("hex");
		const codec = await inspectSourceAudio(source);
		expect(codec).toBe("aac");
		for (const format of ["original", "wav", "m4a"] as const) {
			const outputPath = path.join(dir, `${format}.${format === "original" ? "m4a" : format}`);
			await exportSourceAudioFile({ sourcePath: source, outputPath, format, codec });
			expect((await stat(outputPath)).size).toBeGreaterThan(100);
			const actualCodec = await inspectSourceAudio(outputPath);
			expect(actualCodec).toBe(format === "wav" ? "pcm_s24le" : "aac");
			// The decoder must be able to read the full result, not merely its header.
			execFileSync(ffmpeg!, ["-v", "error", "-i", outputPath, "-f", "null", "-"], {
				stdio: "pipe",
			});
		}
		const packetBytes = (file: string) =>
			execFileSync(ffmpeg!, [
				"-v",
				"error",
				"-i",
				file,
				"-map",
				"0:a:0",
				"-c:a",
				"copy",
				"-f",
				"adts",
				"-",
			]);
		expect(packetBytes(path.join(dir, "original.m4a"))).toEqual(packetBytes(source));
		const wav = await readFile(path.join(dir, "wav.wav"));
		const fmtOffset = wav.indexOf(Buffer.from("fmt ")) + 8;
		expect(wav.readUInt16LE(fmtOffset + 2)).toBe(2);
		expect(wav.readUInt32LE(fmtOffset + 4)).toBe(48_000);
		expect(wav.readUInt16LE(fmtOffset + 14)).toBe(24);
		const canceled = new AbortController();
		canceled.abort();
		await expect(
			exportSourceAudioFile(
				{ sourcePath: source, outputPath: path.join(dir, "canceled.wav"), format: "wav", codec },
				{ signal: canceled.signal },
			),
		).rejects.toThrow();
		const badSource = path.join(dir, "bad.mp4");
		await writeFile(badSource, "not media");
		await expect(
			exportSourceAudioFile({
				sourcePath: badSource,
				outputPath: path.join(dir, "failed.wav"),
				format: "wav",
				codec,
			}),
		).rejects.toThrow("Audio export failed");
		const files = await readdir(dir);
		expect(
			files.some(
				(name) =>
					name.startsWith(".openscreen") || name === "failed.wav" || name === "canceled.wav",
			),
		).toBe(false);
		expect(
			createHash("sha256")
				.update(await readFile(source))
				.digest("hex"),
		).toBe(sourceHash);
	}, 30_000);
});
