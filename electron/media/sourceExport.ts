import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, lstat, realpath, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveFfmpeg } from "./audioPeaks";
import type { SourceAudioFormat } from "./sourceExportContract";

/** File exports stream through ffmpeg rather than buffering audio in the renderer. */
export async function runExportFfmpeg(
	args: string[],
	options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
	const ffmpeg = resolveFfmpeg();
	if (!ffmpeg) throw new Error("The bundled ffmpeg audio exporter is unavailable.");
	options.signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		const child = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
		let stderr = "";
		let abortReason: Error | undefined;
		const abort = () => {
			abortReason = new DOMException("Audio export canceled.", "AbortError");
			child.kill("SIGKILL");
		};
		const timer = setTimeout(
			() => {
				abortReason = new Error("Audio export timed out. Try the original-audio option.");
				child.kill("SIGKILL");
			},
			options.timeoutMs ?? 30 * 60_000,
		);
		const cleanup = () => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
		};
		options.signal?.addEventListener("abort", abort, { once: true });
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-32_768);
		});
		child.once("error", (error) => {
			cleanup();
			reject(error);
		});
		// Wait for close after SIGKILL so cleanup cannot race a still-writing encoder.
		child.once("close", (code) => {
			cleanup();
			if (abortReason) reject(abortReason);
			else if (code !== 0) reject(new Error(`Audio export failed: ${stderr.trim() || code}`));
			else resolve(stderr);
		});
	});
}

export function originalAudioExtension(codec: string): string {
	if (codec === "aac" || codec === "alac") return "m4a";
	if (codec === "mp3") return "mp3";
	if (codec === "flac") return "flac";
	if (codec === "opus" || codec === "vorbis") return "ogg";
	if (/^pcm_(?:s(?:16|24|32)le|f(?:32|64)le|u8|alaw|mulaw)$/.test(codec)) return "wav";
	// Preserve uncommon codecs without transcoding. Their playback support
	// depends on the player; WAV/M4A remain the interoperable conversion choices.
	return "mka";
}

export function sourceAudioExtension(format: SourceAudioFormat, codec: string): string {
	return format === "original" ? originalAudioExtension(codec) : format;
}

export async function inspectSourceAudio(
	sourcePath: string,
	signal?: AbortSignal,
): Promise<string> {
	await requireSourceFile(sourcePath);
	// ffprobe is not bundled on all platforms. ffmpeg's header inspection plus
	// zero-duration stream copy checks that an audio stream exists without decoding.
	const header = await runExportFfmpeg(
		[
			"-hide_banner",
			"-nostdin",
			"-i",
			sourcePath,
			"-map",
			"0:a:0",
			"-t",
			"0",
			"-c:a",
			"copy",
			"-f",
			"null",
			"-",
		],
		{ signal, timeoutMs: 30_000 },
	);
	const codec = /Stream #0:\d+[^\n]*Audio:\s*([a-zA-Z0-9_]+)/.exec(header)?.[1];
	if (!codec) throw new Error("This source has no readable audio stream.");
	return codec.toLowerCase();
}

async function requireSourceFile(sourcePath: string): Promise<void> {
	if (!path.isAbsolute(sourcePath) || !(await stat(sourcePath)).isFile()) {
		throw new Error("The source must be a readable local media file.");
	}
}

export async function unusedExportPath(
	sourcePath: string,
	suffix: string,
	extension: string,
): Promise<string> {
	const parsed = path.parse(sourcePath);
	for (let index = 1; index <= 10_000; index++) {
		const candidate = path.join(
			parsed.dir,
			`${parsed.name}${suffix}${index === 1 ? "" : `-${index}`}.${extension}`,
		);
		try {
			await lstat(candidate);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return candidate;
			throw error;
		}
	}
	throw new Error("Could not find an unused export filename.");
}

async function requireNewDestination(
	sourcePath: string,
	outputPath: string,
	extension: string,
): Promise<void> {
	if (!path.isAbsolute(outputPath) || path.extname(outputPath).toLowerCase() !== `.${extension}`) {
		throw new Error(`Choose a local filename ending in .${extension}.`);
	}
	const source = await realpath(sourcePath);
	const destination = path.join(
		await realpath(path.dirname(outputPath)),
		path.basename(outputPath),
	);
	if (source === destination) throw new Error("The original media cannot be overwritten.");
	try {
		await lstat(outputPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	throw new Error("That file already exists. Choose a new filename to preserve existing files.");
}

/** Publish a complete file without ever replacing an existing file. */
async function publishNewFile(temporary: string, outputPath: string): Promise<void> {
	try {
		await link(temporary, outputPath);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOTSUP" && code !== "EPERM" && code !== "EXDEV") throw error;
		// FAT / network drives may not support hard links. COPYFILE_EXCL still
		// refuses overwrites; Node removes a partially copied destination on error.
		await copyFile(temporary, outputPath, constants.COPYFILE_EXCL);
	}
}

export function sourceAudioArgs(
	sourcePath: string,
	outputPath: string,
	format: SourceAudioFormat,
): string[] {
	const codecArgs =
		format === "original"
			? ["-c:a", "copy"]
			: format === "wav"
				? ["-c:a", "pcm_s24le", "-rf64", "auto"]
				: ["-c:a", "aac", "-b:a", "192k"];
	return [
		"-hide_banner",
		"-loglevel",
		"error",
		"-nostdin",
		"-y",
		"-i",
		sourcePath,
		"-map",
		"0:a:0",
		"-vn",
		"-sn",
		"-dn",
		"-map_metadata",
		"-1",
		...codecArgs,
		outputPath,
	];
}

export async function exportSourceAudioFile(
	request: { sourcePath: string; outputPath: string; format: SourceAudioFormat; codec: string },
	options: { signal?: AbortSignal } = {},
): Promise<void> {
	const { sourcePath, outputPath, format, codec } = request;
	if (!["original", "wav", "m4a"].includes(format)) throw new Error("Unsupported audio format.");
	const extension = sourceAudioExtension(format, codec);
	await requireSourceFile(sourcePath);
	await requireNewDestination(sourcePath, outputPath, extension);
	const temporary = path.join(
		path.dirname(outputPath),
		`.openscreen-audio-${randomUUID()}.${extension}`,
	);
	await writeFile(temporary, "", { flag: "wx", mode: 0o600 });
	try {
		await runExportFfmpeg(sourceAudioArgs(sourcePath, temporary, format), options);
		options.signal?.throwIfAborted();
		if ((await stat(temporary)).size === 0) throw new Error("The exported audio file is empty.");
		await publishNewFile(temporary, outputPath);
	} finally {
		await unlink(temporary).catch(() => undefined);
	}
}

export async function exportSourceSrtFile(
	sourcePath: string,
	outputPath: string,
	srtText: string,
): Promise<void> {
	await requireNewDestination(sourcePath, outputPath, "srt");
	const temporary = path.join(
		path.dirname(outputPath),
		`.openscreen-subtitles-${randomUUID()}.srt`,
	);
	await writeFile(temporary, "", { flag: "wx", mode: 0o600 });
	try {
		await writeFile(temporary, srtText, { mode: 0o600 });
		await publishNewFile(temporary, outputPath);
	} finally {
		await unlink(temporary).catch(() => undefined);
	}
}
