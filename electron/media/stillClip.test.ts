import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { isStillAsset } from "../../src/lib/ai-edition/timeline/clip-parts";
import { resolveFfmpeg } from "./audioPeaks";
import {
	ensureStillClip,
	isImagePath,
	parseImageSize,
	probeImageSize,
	stillClipArgs,
	stillClipPath,
	stillEncoderArgs,
	stillFrameSize,
} from "./stillClip";

const SPEC = {
	imagePath: "C:/img/logo.png",
	holdSec: 5,
	width: 801,
	height: 601,
	platform: "win32" as const,
	arch: "x64",
};

describe("stillClipArgs", () => {
	const args = stillClipArgs(SPEC, "C:/rec/stills/logo.still.mp4");
	const after = (flag: string) => args[args.indexOf(flag) + 1];

	it("loops the one image at 30 fps for exactly the hold, with no sound", () => {
		expect(args.slice(args.indexOf("-loop"), args.indexOf("-i") + 2)).toEqual([
			"-loop",
			"1",
			"-framerate",
			"30",
			"-i",
			"C:/img/logo.png",
		]);
		expect(after("-t")).toBe("5.000");
		expect(args).toContain("-an");
	});

	it("flattens alpha, converts to BT.709 limited, pads to even sides, then goes 4:2:0", () => {
		expect(after("-vf").split(",")).toEqual([
			"premultiply=inplace=1",
			"scale=out_color_matrix=bt709:out_range=tv",
			"pad=802:602",
			"format=yuv420p",
			"setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv",
		]);
		expect(after("-colorspace")).toBe("bt709");
		expect(after("-color_primaries")).toBe("bt709");
		expect(after("-color_trc")).toBe("bt709");
		expect(after("-color_range")).toBe("tv");
	});

	it("scales down only past 3840x2160, keeping the aspect ratio", () => {
		const big = stillClipArgs({ ...SPEC, width: 5000, height: 3000 }, "out.mp4");
		expect(big[big.indexOf("-vf") + 1]).toContain(
			"scale=w=3600:h=2160:flags=lanczos:out_color_matrix=bt709:out_range=tv,pad=3600:2160",
		);
		const uhd = stillClipArgs({ ...SPEC, width: 3840, height: 2160 }, "out.mp4");
		expect(uhd[uhd.indexOf("-vf") + 1]).toContain("scale=out_color_matrix");
	});

	it("puts a keyframe every 2 seconds and the image's path in the metadata", () => {
		expect(after("-g")).toBe("60");
		expect(after("-metadata")).toBe("comment=C:/img/logo.png");
		expect(args.at(-1)).toBe("C:/rec/stills/logo.still.mp4");
	});

	it("uses the encoder each platform's bundled ffmpeg has", () => {
		// BtbN's LGPL builds (Windows, Linux) carry openh264; the macOS build has VideoToolbox only.
		expect(stillEncoderArgs("win32", "x64")).toEqual([
			"-c:v",
			"libopenh264",
			"-qmin",
			"14",
			"-qmax",
			"22",
		]);
		expect(stillEncoderArgs("linux", "arm64")).toContain("libopenh264");
		expect(stillEncoderArgs("darwin", "arm64")).toEqual([
			"-c:v",
			"h264_videotoolbox",
			"-q:v",
			"75",
		]);
		// Constant quality is Apple Silicon only.
		expect(stillEncoderArgs("darwin", "x64")).toEqual(["-c:v", "h264_videotoolbox", "-b:v", "20M"]);
		expect(stillClipArgs({ ...SPEC, platform: "darwin", arch: "arm64" }, "o.mp4")).toContain(
			"h264_videotoolbox",
		);
	});
});

describe("stillFrameSize", () => {
	it("keeps an image that fits, made even", () => {
		expect(stillFrameSize(1920, 1080)).toEqual({ scaled: null, width: 1920, height: 1080 });
		expect(stillFrameSize(801, 601)).toEqual({ scaled: null, width: 802, height: 602 });
	});

	it("fits a larger one inside 3840x2160 and never exceeds it", () => {
		expect(stillFrameSize(7680, 4320)).toMatchObject({ width: 3840, height: 2160 });
		expect(stillFrameSize(10000, 1001)).toMatchObject({ width: 3840, height: 384 });
		expect(stillFrameSize(1001, 9999)).toMatchObject({ height: 2160 });
	});
});

describe("stillClipPath", () => {
	const image = { mtimeMs: 1000, size: 42 };
	const at = (overrides: Partial<typeof image> = {}, hold = 5) =>
		stillClipPath(
			path.join("rec"),
			path.join("pics", "logo.png"),
			{ ...image, ...overrides },
			hold,
		);

	it("is in the stills folder, named from the image, a hash and the hold", () => {
		expect(at()).toMatch(/^rec[\\/]stills[\\/]logo_[0-9a-f]{8}_5000\.still\.mp4$/);
	});

	it("names another file when the image changes or the hold does", () => {
		expect(at({ mtimeMs: 2000 })).not.toBe(at());
		expect(at({ size: 43 })).not.toBe(at());
		expect(at({}, 2.5)).toMatch(/_2500\.still\.mp4$/);
		expect(at()).toBe(at());
	});
});

describe("isImagePath and isStillAsset", () => {
	it("recognises images by extension", () => {
		for (const name of ["a.png", "b.JPG", "c.jpeg", "d.webp"]) expect(isImagePath(name)).toBe(true);
		for (const name of ["a.mp4", "b.gif", "c"]) expect(isImagePath(name)).toBe(false);
	});

	it("knows a still by its file", () => {
		expect(isStillAsset({ originalPath: "C:/rec/stills/logo_1a2b3c4d_5000.still.mp4" })).toBe(true);
		expect(isStillAsset({ originalPath: "C:/rec/take.mp4" })).toBe(false);
		expect(isStillAsset({})).toBe(false);
	});
});

describe("parseImageSize", () => {
	it("reads the size of the frame ffmpeg decoded, never the header's alone", () => {
		const header =
			"  Stream #0:0: Video: png, rgba(pc, gbr/unknown/unknown), 801x601, 25 fps, 25 tbr";
		const frame =
			"[Parsed_showinfo_0 @ 000001] n:   0 pts:      0 pts_time:0       duration:1 fmt:rgba cl:unspecified sar:1/1 s:801x601 i:P iskey:1 type:I";
		expect(parseImageSize(`${header}\n${frame}`)).toEqual({ width: 801, height: 601 });
		// The header read, the pixels did not: no frame reached the filter.
		expect(parseImageSize(`${header}\n[png @ 000001] inflate returned error -3`)).toBeNull();
		expect(parseImageSize("notes.txt: Invalid data found when processing input")).toBeNull();
	});

	it("prefers the size the decoder hands on, after an EXIF orientation turned the image", () => {
		const probe = [
			"  Stream #0:0: Video: mjpeg (Baseline), yuvj420p(pc, bt470bg/unknown/unknown), 1200x800",
			"[Parsed_showinfo_0 @ 000001] n:   0 pts:      0 pts_time:0       duration:1 fmt:yuvj420p cl:center sar:1/1 s:800x1200 i:P iskey:1 type:I",
		].join("\n");
		expect(parseImageSize(probe)).toEqual({ width: 800, height: 1200 });
	});
});

describe("ensureStillClip without ffmpeg", () => {
	it("refuses with a message rather than crashing", async () => {
		vi.resetModules();
		vi.doMock("./audioPeaks", () => ({ resolveFfmpeg: () => null }));
		try {
			const { ensureStillClip: ensure } = await import("./stillClip");
			await expect(ensure("C:/img/logo.png", 5, "C:/rec")).rejects.toThrow("no ffmpeg");
		} finally {
			vi.doUnmock("./audioPeaks");
		}
	});
});

// The real thing, where an ffmpeg resolves (a dev checkout with the bundled one, or
// OPENSCREEN_FFMPEG_PATH). CI has none: these skip there.
const ffmpeg = resolveFfmpeg();

describe.skipIf(!ffmpeg)("ensureStillClip with the bundled ffmpeg", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "openscreen-still-"));
	const recordings = path.join(dir, "recordings");
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	const make = (name: string, source: string): string | null => {
		const file = path.join(dir, name);
		const made = spawnSync(ffmpeg as string, [
			"-y",
			"-loglevel",
			"error",
			"-f",
			"lavfi",
			"-i",
			source,
			"-frames:v",
			"1",
			file,
		]);
		return made.status === 0 ? file : null;
	};
	const listing = (file: string) =>
		spawnSync(ffmpeg as string, ["-hide_banner", "-i", file], { encoding: "utf8" }).stderr;
	/** Y, U, V of the 2x2 block at (x, y) of the first frame. */
	const pixel = (file: string, x: number, y: number) => [
		...spawnSync(ffmpeg as string, [
			"-loglevel",
			"error",
			"-i",
			file,
			"-frames:v",
			"1",
			"-vf",
			`crop=2:2:${x}:${y}`,
			"-f",
			"rawvideo",
			"-pix_fmt",
			"yuv420p",
			"-",
		]).stdout,
	];

	it("makes a silent BT.709 video of an odd-sized transparent PNG, once", async () => {
		const png = make(
			"logo.png",
			// Orange everywhere, opaque only inside a box: the rest is transparent orange.
			"color=c=0xff781e:s=801x601,format=rgba,geq=r=255:g=120:b=30:a='255*between(X,200,599)*between(Y,200,399)'",
		) as string;
		const before = statSync(png);
		const still = await ensureStillClip(png, 5, recordings);

		expect(still).toMatchObject({ width: 802, height: 602 });
		expect(path.dirname(still.path)).toBe(path.join(recordings, "stills"));
		const info = listing(still.path);
		expect(info).toContain("Duration: 00:00:05.00");
		expect(info).toMatch(/Video: h264 .*yuv420p\(tv, bt709, progressive\), 802x602/);
		expect(info).not.toContain("Audio:");
		expect(info).toContain(`comment         : ${png}`);
		// The transparent corner is black; the orange box keeps its BT.709 colour.
		expect(pixel(still.path, 0, 0)[0]).toBeLessThanOrEqual(18);
		const [y, , , , u, v] = pixel(still.path, 400, 300);
		expect([Math.abs(y - 138) <= 2, Math.abs(u - 75) <= 2, Math.abs(v - 190) <= 2]).toEqual([
			true,
			true,
			true,
		]);

		const again = await ensureStillClip(png, 5, recordings);
		expect(again).toEqual(still);
		expect(statSync(still.path).mtimeMs).toBe(statSync(again.path).mtimeMs);
		// The image itself is left as it was.
		expect(statSync(png).mtimeMs).toBe(before.mtimeMs);
		expect(statSync(png).size).toBe(before.size);
	});

	it("takes a JPEG and a WebP", async (ctx) => {
		const jpeg = make("card.jpg", "testsrc2=s=640x360") as string;
		expect(listing((await ensureStillClip(jpeg, 0.5, recordings)).path)).toContain(
			"Duration: 00:00:00.50",
		);
		// The macOS build has a WebP decoder but no encoder to make the fixture with.
		const webp = make("card.webp", "testsrc2=s=640x360");
		if (!webp) return ctx.skip();
		expect((await ensureStillClip(webp, 2, recordings)).width).toBe(640);
	});

	it("takes a portrait photo stored landscape with an EXIF orientation, upright", async () => {
		const stored = make("phone.jpg", "testsrc2=s=1200x800") as string;
		// An APP1 Exif segment with one tag, Orientation (0x0112) = 6: turn 90° to display.
		const tiff = [
			0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0,
		];
		const payload = Buffer.concat([Buffer.from("Exif\0\0", "binary"), Buffer.from(tiff)]);
		const size = payload.length + 2;
		const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, size >> 8, size & 0xff]), payload]);
		const jpeg = readFileSync(stored);
		const turned = path.join(dir, "phone-turned.jpg");
		writeFileSync(turned, Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]));

		const still = await ensureStillClip(turned, 0.5, recordings);
		expect([still.width, still.height]).toEqual([800, 1200]);
		expect(listing(still.path)).toMatch(/, 800x1200[ ,]/);
		// The size an effect's image is given, by the same probe.
		expect(await probeImageSize(ffmpeg as string, turned)).toEqual({ width: 800, height: 1200 });
	});

	it("refuses a file that is not an image, with a message", async () => {
		const fake = path.join(dir, "fake.png");
		spawnSync(ffmpeg as string, [
			"-y",
			"-loglevel",
			"error",
			"-f",
			"lavfi",
			"-i",
			"anullsrc",
			"-t",
			"0.1",
			"-f",
			"wav",
			fake,
		]);
		await expect(ensureStillClip(fake, 5, recordings)).rejects.toThrow(
			"could not be read as an image",
		);
		expect(await probeImageSize(ffmpeg as string, fake)).toBeNull();
	});

	it("refuses a PNG whose header reads but whose pixels do not decode", async () => {
		const good = make("broken.png", "testsrc2=s=320x240") as string;
		const bytes = Buffer.from(readFileSync(good));
		// The middle of the first IDAT chunk's compressed data zeroed, its length and CRC kept.
		const idat = bytes.indexOf("IDAT");
		const length = bytes.readUInt32BE(idat - 4);
		bytes.fill(0, idat + 4 + Math.floor(length / 4), idat + 4 + Math.floor((3 * length) / 4));
		writeFileSync(good, bytes);
		expect(listing(good)).toMatch(/, 320x240[ ,]/);
		expect(await probeImageSize(ffmpeg as string, good)).toBeNull();
		await expect(ensureStillClip(good, 1, recordings)).rejects.toThrow(
			"could not be read as an image",
		);
	});
});
