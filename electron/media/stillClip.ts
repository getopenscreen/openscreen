/**
 * A still image as a clip: a silent video of the image, made once, at import.
 *
 * Not an `image` asset kind on purpose. A new kind makes every older OpenScreen refuse the
 * whole project (the asset enum is parsed strictly), and a real image source would need a
 * decode path of its own in every GPU backend and in both the preview and the export, which
 * must stay identical. A generated video goes down the path every recording already takes,
 * as the extension clips do (`extensionClip.ts`).
 *
 * What it gives up: transparent pixels are flattened onto black, the picture is stored as
 * lossy 4:2:0, an image larger than 3840x2160 is scaled down to fit, and a still cannot be
 * made longer than the hold it was imported with.
 *
 * DERIVED from the image, which is never moved or modified: the file name carries a hash of
 * the image's path, modification time and size and the hold, so an edited image or another
 * hold names another file, and the MP4's `comment` carries the image's path.
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { STILL_SUFFIX } from "../../src/lib/ai-edition/timeline/clip-parts";
import { resolveFfmpeg } from "./audioPeaks";

/** What `importMedia` and the editor's import turn into a still, by extension. */
export const IMAGE_EXTENSIONS: readonly string[] = [".png", ".jpg", ".jpeg", ".webp"];

export function isImagePath(filePath: string): boolean {
	return IMAGE_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
}

/** The editor's import holds an image this long; `importMedia` takes `holdSec`. */
export const DEFAULT_HOLD_SEC = 5;
export const MIN_HOLD_SEC = 0.5;
export const MAX_HOLD_SEC = 60;

/** The subfolder of the recordings folder the stills are written to. */
export const STILLS_DIR = "stills";

const FPS = 30;
/** A keyframe every 2 s, so a seek into a long hold decodes at most 60 frames. */
const GOP_FRAMES = 2 * FPS;
const MAX_WIDTH = 3840;
const MAX_HEIGHT = 2160;

export interface StillClip {
	path: string;
	/** The picture's size in the video: the image's, scaled down past 3840x2160, made even. */
	width: number;
	height: number;
}

/** The video's picture size for an image of `width` x `height`. */
export function stillFrameSize(
	width: number,
	height: number,
): { scaled: { width: number; height: number } | null; width: number; height: number } {
	const k = Math.min(MAX_WIDTH / width, MAX_HEIGHT / height);
	const scaled =
		k < 1
			? { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) }
			: null;
	const w = scaled?.width ?? width;
	const h = scaled?.height ?? height;
	// 4:2:0 needs even sides: padded rather than cropped, so no pixel of the image is lost.
	return { scaled, width: w + (w % 2), height: h + (h % 2) };
}

/**
 * The H.264 encoder the bundled ffmpeg has, and its settings, chosen by measurement: at least
 * 45 dB of luma PSNR on a text-heavy screenshot, on every frame.
 *
 * The Windows and Linux builds are BtbN's LGPL builds, which carry `libopenh264`; the macOS
 * build is compiled by `scripts/fetch-ffmpeg-macos.mjs` with VideoToolbox and no openh264.
 * VideoToolbox's constant quality (`-q:v`) exists only on Apple Silicon, so an Intel Mac
 * gets a bitrate instead.
 */
export function stillEncoderArgs(platform: NodeJS.Platform, arch: string): string[] {
	if (platform === "darwin") {
		return arch === "arm64"
			? ["-c:v", "h264_videotoolbox", "-q:v", "75"]
			: ["-c:v", "h264_videotoolbox", "-b:v", "20M"];
	}
	return ["-c:v", "libopenh264", "-qmin", "14", "-qmax", "22"];
}

/** The ffmpeg arguments, as a pure function so the command can be asserted without running it. */
export function stillClipArgs(
	spec: {
		imagePath: string;
		holdSec: number;
		/** The image's own size. */
		width: number;
		height: number;
		platform: NodeJS.Platform;
		arch: string;
	},
	outPath: string,
): string[] {
	const frame = stillFrameSize(spec.width, spec.height);
	const size = frame.scaled
		? `w=${frame.scaled.width}:h=${frame.scaled.height}:flags=lanczos:`
		: "";
	const filters = [
		// Transparent pixels go to black: the alpha channel is dropped by 4:2:0 below.
		"premultiply=inplace=1",
		// The compositor's shader assumes BT.709, limited range.
		`scale=${size}out_color_matrix=bt709:out_range=tv`,
		`pad=${frame.width}:${frame.height}`,
		"format=yuv420p",
		// The tags the encoder writes, read off the frames.
		"setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv",
	].join(",");
	return [
		"-y",
		"-hide_banner",
		"-loglevel",
		"error",
		"-loop",
		"1",
		"-framerate",
		String(FPS),
		"-i",
		spec.imagePath,
		"-t",
		spec.holdSec.toFixed(3),
		"-an",
		"-vf",
		filters,
		...stillEncoderArgs(spec.platform, spec.arch),
		"-g",
		String(GOP_FRAMES),
		"-colorspace",
		"bt709",
		"-color_primaries",
		"bt709",
		"-color_trc",
		"bt709",
		"-color_range",
		"tv",
		"-metadata",
		`comment=${spec.imagePath}`,
		"-f",
		"mp4",
		outPath,
	];
}

/** Where the still of this image, as it is now, held this long, is written. */
export function stillClipPath(
	recordingsDir: string,
	imagePath: string,
	image: { mtimeMs: number; size: number },
	holdSec: number,
): string {
	const hash = createHash("sha256")
		.update(`${imagePath}\0${image.mtimeMs}\0${image.size}\0${holdSec}`)
		.digest("hex")
		.slice(0, 8);
	const name = `${path.parse(imagePath).name}_${hash}_${Math.round(holdSec * 1000)}${STILL_SUFFIX}`;
	return path.join(recordingsDir, STILLS_DIR, name);
}

/** The ffmpeg arguments that decode one frame of the image and print its size (`showinfo`). */
export const IMAGE_PROBE_ARGS = (imagePath: string): string[] => [
	"-hide_banner",
	"-i",
	imagePath,
	"-frames:v",
	"1",
	"-vf",
	"showinfo",
	"-f",
	"null",
	"-",
];

/**
 * The picture's size as the still's filters will get it, from the stderr of `IMAGE_PROBE_ARGS`:
 * `showinfo`'s `s:`, which is after ffmpeg turned the image by its EXIF orientation (a phone's
 * portrait photo is stored landscape). Only a decoded frame counts: a header can read while the
 * pixels behind it do not, and the input's listing would still give it a size.
 */
export function parseImageSize(listing: string): { width: number; height: number } | null {
	const match = listing.match(/Parsed_showinfo[^\n]*\bs:(\d+)x(\d+)/);
	if (!match) return null;
	const width = Number(match[1]);
	const height = Number(match[2]);
	return width > 0 && height > 0 ? { width, height } : null;
}

/** The image's size once ffmpeg turned it upright, or `null` when it does not decode. */
export async function probeImageSize(
	ffmpeg: string,
	imagePath: string,
): Promise<{ width: number; height: number } | null> {
	const listing = await run(ffmpeg, IMAGE_PROBE_ARGS(imagePath)).catch(
		(error: Error) => error.message,
	);
	return parseImageSize(listing);
}

/**
 * The still of `imagePath` held `holdSec` seconds, generated if it is not already there.
 * Throws with a message for the user when it cannot be made: no ffmpeg, or not an image.
 */
export async function ensureStillClip(
	imagePath: string,
	holdSec: number,
	recordingsDir: string,
): Promise<StillClip> {
	const ffmpeg = resolveFfmpeg();
	if (!ffmpeg) throw new Error("OpenScreen found no ffmpeg to turn the image into a clip with.");
	const absolute = path.resolve(imagePath);
	const image = await stat(absolute);
	const size = await probeImageSize(ffmpeg, absolute);
	if (!size) throw new Error(`"${absolute}" could not be read as an image.`);
	const frame = stillFrameSize(size.width, size.height);
	const outPath = stillClipPath(recordingsDir, absolute, image, holdSec);
	if (await stat(outPath).catch(() => null)) {
		return { path: outPath, width: frame.width, height: frame.height };
	}

	await mkdir(path.dirname(outPath), { recursive: true });
	// Written aside and renamed, so a failed or interrupted run never leaves a file that a
	// later import would take for a finished one.
	const partPath = `${outPath}.${randomUUID()}.part`;
	try {
		await run(
			ffmpeg,
			stillClipArgs(
				{ imagePath: absolute, holdSec, ...size, platform: process.platform, arch: process.arch },
				partPath,
			),
			{ check: true },
		);
		await rename(partPath, outPath);
	} finally {
		await rm(partPath, { force: true });
	}
	return { path: outPath, width: frame.width, height: frame.height };
}

/** Runs ffmpeg and resolves with its stderr; with `check`, a non-zero exit rejects. */
function run(bin: string, args: string[], options: { check?: boolean } = {}): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("error", reject);
		child.on("close", (code) =>
			code === 0 || !options.check
				? resolve(stderr)
				: reject(new Error(`ffmpeg exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`)),
		);
	});
}
