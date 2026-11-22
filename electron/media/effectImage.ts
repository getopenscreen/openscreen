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

/** The names an image for an effect may have: the formats the compositor decodes. */
const EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);
/** A screenshot at 8K is under this; past it a file is not a picture for an effect. */
export const MAX_EFFECT_IMAGE_BYTES = 32 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The copy's extension, from what the bytes are rather than what the file is called. */
function extensionOf(bytes: Buffer): ".png" | ".jpg" | null {
	if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return ".png";
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return ".jpg";
	return null;
}

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
	const notAnImage = new Error(`"${sourcePath}" is not a PNG or a JPEG.`);
	if (!EXTENSIONS.has(path.extname(sourcePath).toLowerCase())) throw notAnImage;
	const info = await stat(sourcePath).catch(() => null);
	if (!info?.isFile()) throw new Error(`"${sourcePath}" is not a file OpenScreen can read.`);
	const tooLarge = new Error(
		`"${sourcePath}" is larger than 32 MB, the most an effect's image may be.`,
	);
	if (info.size > MAX_EFFECT_IMAGE_BYTES) throw tooLarge;
	// One snapshot of the bytes: what is checked, measured and kept is that, whatever the user's
	// file becomes meanwhile.
	const bytes = await readFile(sourcePath);
	if (bytes.length > MAX_EFFECT_IMAGE_BYTES) throw tooLarge;
	const extension = extensionOf(bytes);
	if (!extension) throw notAnImage;
	const name = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
	const stored = path.join(recordingsDir, EFFECT_IMAGES_DIR, `${name}${extension}`);
	const measured = async (file: string) => {
		const size = await sizeOf(file);
		if (!size || size.width < 1 || size.height < 1) {
			throw new Error(`"${sourcePath}" could not be read as an image.`);
		}
		return { path: stored, width: size.width, height: size.height };
	};
	// The same bytes were kept before: that copy is this image.
	if (await stat(stored).catch(() => null)) return measured(stored);
	await mkdir(path.dirname(stored), { recursive: true });
	// Written aside, measured there, then renamed: an interrupted or undecodable copy never
	// passes for a whole one.
	const part = path.join(path.dirname(stored), `${name}.${randomUUID()}.part${extension}`);
	try {
		await writeFile(part, bytes);
		const image = await measured(part);
		await rename(part, stored);
		return image;
	} finally {
		await rm(part, { force: true });
	}
}
