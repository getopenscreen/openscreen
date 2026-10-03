#!/usr/bin/env node
/** node scripts/media/encode-backgrounds.mjs --dir <output>; originals stay in public/wallpapers. */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { BACKGROUND_WALLPAPERS, BACKGROUND_WIDTHS } from "../../src/lib/background-media.ts";

const { values } = parseArgs({ options: { dir: { type: "string" } } });
if (!values.dir) throw new Error("usage: encode-backgrounds.mjs --dir <output>");
const dir = resolve(values.dir);
await mkdir(dir, { recursive: true });
const root = resolve(import.meta.dirname, "../../..");
// Run sequentially: AV1 encoding is an offline task, not a reason to monopolise the developer's CPU.
for (const [index, wallpaper] of BACKGROUND_WALLPAPERS.entries()) {
	for (const width of BACKGROUND_WIDTHS) {
		const source = resolve(root, "public/wallpapers", `wallpaper${wallpaper}.jpg`);
		const resized = sharp(source).resize(width, Math.round((width * 9) / 16), { fit: "cover" });
		for (const format of ["avif", "webp"]) {
			const image = resized.clone();
			const output =
				format === "avif"
					? await image
							.avif({ quality: 80, effort: 6, chromaSubsampling: "4:4:4", bitdepth: 10 })
							.toBuffer()
					: await image.webp({ quality: 90, effort: 6, smartSubsample: true }).toBuffer();
			const name = `bg-${index + 1}-${width}.${format}`;
			await writeFile(resolve(dir, name), output);
			console.log(`${name}: ${output.length} B`);
		}
	}
}
