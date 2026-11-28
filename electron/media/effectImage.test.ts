import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	EFFECT_IMAGES_DIR,
	type ImageSizeReader,
	MAX_EFFECT_IMAGE_BYTES,
	storeEffectImage,
} from "./effectImage";

const temps: string[] = [];
afterEach(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
	temps.length = 0;
});
function tmp(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "effect-image-"));
	temps.push(dir);
	return dir;
}
/** What a PNG and a JPEG start with, then the rest: the size reader decides whether it decodes. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const image = (head: Buffer, rest = "pixels") => Buffer.concat([head, Buffer.from(rest)]);
function file(dir: string, name: string, bytes: Buffer | string = image(PNG)): string {
	const target = path.join(dir, name);
	writeFileSync(target, bytes);
	return target;
}
const sized = async () => ({ width: 400, height: 100 });

describe("storeEffectImage", () => {
	it("keeps a copy named after the content, and says how large the image is", async () => {
		const dir = tmp();
		const recordings = path.join(dir, "recordings");
		const stored = await storeEffectImage(file(dir, "Logo.PNG"), recordings, sized);
		expect(stored).toEqual({
			path: path.join(recordings, EFFECT_IMAGES_DIR, path.basename(stored.path)),
			width: 400,
			height: 100,
		});
		expect(path.basename(stored.path)).toMatch(/^[0-9a-f]{16}\.png$/);
		expect(readFileSync(stored.path)).toEqual(image(PNG));
	});

	it("stores the same image once, whatever it is called, and another image apart", async () => {
		const dir = tmp();
		const recordings = path.join(dir, "recordings");
		const first = await storeEffectImage(file(dir, "a.jpg", image(JPEG)), recordings, sized);
		const again = await storeEffectImage(file(dir, "b.jpeg", image(JPEG)), recordings, sized);
		const other = await storeEffectImage(
			file(dir, "c.jpg", image(JPEG, "other pixels")),
			recordings,
			sized,
		);
		expect(again.path).toBe(first.path);
		expect(first.path.endsWith(".jpg")).toBe(true);
		expect(other.path).not.toBe(first.path);
		// No half-written file is left beside them.
		expect(readdirSync(path.join(recordings, EFFECT_IMAGES_DIR))).toHaveLength(2);
	});

	it("names the copy by what it holds: a JPEG called .png is kept as a .jpg", async () => {
		const dir = tmp();
		const stored = await storeEffectImage(
			file(dir, "logo.png", image(JPEG)),
			path.join(dir, "recordings"),
			sized,
		);
		expect(stored.path.endsWith(".jpg")).toBe(true);
	});

	it("measures the bytes it keeps, even when the file changes meanwhile", async () => {
		const dir = tmp();
		const source = file(dir, "logo.png");
		const recordings = path.join(dir, "recordings");
		const measuredFiles: string[] = [];
		const stored = await storeEffectImage(source, recordings, async (measuredFile) => {
			measuredFiles.push(measuredFile);
			// The user saves another picture over it while it is measured.
			writeFileSync(source, image(JPEG, "a different picture"));
			return { width: 400, height: 100 };
		});
		// Measured on OpenScreen's copy, not on the user's file, and that copy holds the bytes read.
		expect(path.dirname(measuredFiles[0])).toBe(path.join(recordings, EFFECT_IMAGES_DIR));
		expect(readFileSync(stored.path)).toEqual(image(PNG));
	});

	it("refuses what is not an image an effect can read, and says which", async () => {
		const dir = tmp();
		const recordings = path.join(dir, "recordings");
		const refusal = (source: string, sizeOf: ImageSizeReader = sized) =>
			storeEffectImage(source, recordings, sizeOf).then(
				() => "stored",
				(error: Error) => error.message,
			);
		expect(await refusal("logo.png")).toContain("must be absolute");
		expect(await refusal(file(dir, "logo.webp"))).toContain("is not a PNG or a JPEG");
		expect(await refusal(path.join(dir, "absent.png"))).toContain("not a file OpenScreen can read");
		// A text file renamed .png: its bytes say what it is, not its name.
		expect(await refusal(file(dir, "notes.png", "these are not pixels"))).toContain(
			"is not a PNG or a JPEG",
		);
		// It starts like a PNG and does not decode: the decoder is the judge.
		expect(await refusal(file(dir, "broken.png"), async () => null)).toContain(
			"could not be read as an image",
		);
		// One byte over the cap, refused on its size before anything is read.
		const huge = file(dir, "huge.png");
		truncateSync(huge, MAX_EFFECT_IMAGE_BYTES + 1);
		expect(await refusal(huge)).toContain("larger than 32 MB");
		// Nothing was kept for a refusal, not even a part file.
		const kept = path.join(recordings, EFFECT_IMAGES_DIR);
		expect(existsSync(kept) ? readdirSync(kept) : []).toEqual([]);
	});
});
