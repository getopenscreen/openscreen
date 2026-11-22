// The image a shader effect reads with `image(uv)`: OpenScreen keeps its own copy.
//
// An effect names its image by a file the agent gives. That file is the user's: it can move, be
// edited or be deleted, and the effect would then draw nothing with no word of why. So the bytes
// are copied into the recordings folder, under a name made from their content. The same image
// attached twice is one file, and a path never changes what it holds, which is what lets the
// compositor keep a loaded image by its path alone.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ShaderEffectImage } from "../../src/lib/ai-edition/shaderEffects";

export const EFFECT_IMAGES_DIR = "effect-images";

/** The formats the compositor decodes, and the extension the copy takes. */
const EXTENSIONS: Record<string, string> = { ".png": ".png", ".jpg": ".jpg", ".jpeg": ".jpg" };
/** A screenshot at 8K is under this; past it a file is not a picture for an effect. */
export const MAX_EFFECT_IMAGE_BYTES = 32 * 1024 * 1024;

/** An image file's size in pixels once upright by its EXIF orientation, `null` if it does not decode. */
export type ImageSizeReader = (file: string) => Promise<{ width: number; height: number } | null>;

/**
 * Copies `sourcePath` into `recordingsDir` and says where and how large it is. Throws with a
 * message for the agent when the file is not an image an effect can read.
 */
export async function storeEffectImage(
	sourcePath: string,
	recordingsDir: string,
	sizeOf: ImageSizeReader,
): Promise<ShaderEffectImage> {
	if (!path.isAbsolute(sourcePath)) {
		throw new Error(`The image's path must be absolute, got "${sourcePath}".`);
	}
	const extension = EXTENSIONS[path.extname(sourcePath).toLowerCase()];
	if (!extension) throw new Error(`"${sourcePath}" is not a PNG or a JPEG.`);
	const info = await stat(sourcePath).catch(() => null);
	if (!info?.isFile()) throw new Error(`"${sourcePath}" is not a file OpenScreen can read.`);
	if (info.size > MAX_EFFECT_IMAGE_BYTES) {
		throw new Error(`"${sourcePath}" is larger than 32 MB, the most an effect's image may be.`);
	}
	const size = await sizeOf(sourcePath);
	if (!size || size.width < 1 || size.height < 1) {
		throw new Error(`"${sourcePath}" could not be read as an image.`);
	}
	const bytes = await readFile(sourcePath);
	const name = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
	const stored = path.join(recordingsDir, EFFECT_IMAGES_DIR, `${name}${extension}`);
	if (!(await stat(stored).catch(() => null))) {
		await mkdir(path.dirname(stored), { recursive: true });
		// Written aside and renamed, so an interrupted copy never passes for a whole one.
		const part = `${stored}.${randomUUID()}.part`;
		try {
			await writeFile(part, bytes);
			await rename(part, stored);
		} finally {
			await rm(part, { force: true });
		}
	}
	return { path: stored, width: size.width, height: size.height };
}
