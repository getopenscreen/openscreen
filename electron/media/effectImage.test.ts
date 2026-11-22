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
/** A file that says it is an image; the size reader decides whether it decodes. */
function file(dir: string, name: string, bytes = "pixels"): string {
	const target = path.join(dir, name);
	writeFileSync(target, bytes);
	return target;
}
const sized = () => ({ width: 400, height: 100 });

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
		expect(readFileSync(stored.path, "utf8")).toBe("pixels");
	});

	it("stores the same image once, whatever it is called, and another image apart", async () => {
		const dir = tmp();
		const recordings = path.join(dir, "recordings");
		const first = await storeEffectImage(file(dir, "a.jpg"), recordings, sized);
		const again = await storeEffectImage(file(dir, "b.jpeg"), recordings, sized);
		const other = await storeEffectImage(file(dir, "c.jpg", "other pixels"), recordings, sized);
		expect(again.path).toBe(first.path);
		expect(first.path.endsWith(".jpg")).toBe(true);
		expect(other.path).not.toBe(first.path);
		// No half-written file is left beside them.
		expect(readdirSync(path.join(recordings, EFFECT_IMAGES_DIR))).toHaveLength(2);
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
		// A text file renamed .png: the decoder is the judge, not the extension.
		expect(await refusal(file(dir, "notes.png"), () => null)).toContain(
			"could not be read as an image",
		);
		// One byte over the cap, refused on its size before anything is read.
		const huge = file(dir, "huge.png");
		truncateSync(huge, MAX_EFFECT_IMAGE_BYTES + 1);
		expect(await refusal(huge)).toContain("larger than 32 MB");
		// Nothing was copied for a refusal: the folder was never made.
		expect(existsSync(path.join(recordings, EFFECT_IMAGES_DIR))).toBe(false);
	});
});
