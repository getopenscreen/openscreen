// Prepare transparent cursor PNGs from the original raster artwork in design/cursors.
// Run with `node scripts/generate-original-cursor-themes.mjs`.
// Each source PNG contains the arrow on the left and the hand on the right.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DIR = path.join(ROOT, "design", "cursors");
const PUBLIC_DIR = path.join(ROOT, "public", "cursors");
const SIZE = 128;
const INNER_SIZE = 112;

// Fingertip and arrow tip coordinates in the 1774 × 887 source PNGs.
const themes = [
	{ id: "studio-ink", hotspots: { arrow: [158, 48], pointer: [1258, 50] } },
	{ id: "prism-glow", hotspots: { arrow: [208, 42], pointer: [1220, 50] } },
	{ id: "pop-coral", hotspots: { arrow: [265, 58], pointer: [1245, 65] } },
	{ id: "pixel-candy", hotspots: { arrow: [273, 76], pointer: [1218, 78] } },
	{ id: "star-sprout", hotspots: { arrow: [210, 65], pointer: [1218, 65] } },
];

const browser = await chromium.launch();
try {
	const page = await browser.newPage();
	await page.goto("about:blank");
	for (const theme of themes) {
		const output = path.join(PUBLIC_DIR, theme.id);
		await mkdir(output, { recursive: true });
		for (const variant of theme.id === "pop-coral" ? ["", "-3d"] : [""]) {
			const source = await readFile(path.join(SOURCE_DIR, theme.id, `source${variant}.png`));
			for (const type of ["arrow", "pointer"]) {
				const result = await page.evaluate(
					async ({ png, type, size, innerSize, hotspot }) => {
						const image = new Image();
						image.src = `data:image/png;base64,${png}`;
						await image.decode();
						const halfWidth = image.width / 2;
						const sourceX = type === "arrow" ? 0 : halfWidth;
						const sourceCanvas = document.createElement("canvas");
						sourceCanvas.width = halfWidth;
						sourceCanvas.height = image.height;
						const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
						sourceContext.drawImage(image, -sourceX, 0);
						const pixels = sourceContext.getImageData(0, 0, halfWidth, image.height);
						let minX = halfWidth;
						let minY = image.height;
						let maxX = 0;
						let maxY = 0;
						for (let y = 0; y < image.height; y++) {
							for (let x = 0; x < halfWidth; x++) {
								const alphaIndex = (y * halfWidth + x) * 4 + 3;
								if (pixels.data[alphaIndex] < 28) {
									pixels.data[alphaIndex] = 0;
									continue;
								}
								minX = Math.min(minX, x);
								minY = Math.min(minY, y);
								maxX = Math.max(maxX, x);
								maxY = Math.max(maxY, y);
							}
						}
						if (minX > maxX || minY > maxY) throw new Error("Empty cursor artwork");
						sourceContext.putImageData(pixels, 0, 0);
						const width = maxX - minX + 1;
						const height = maxY - minY + 1;
						const scale = innerSize / Math.max(width, height);
						const targetWidth = width * scale;
						const targetHeight = height * scale;
						const targetX = (size - targetWidth) / 2;
						const targetY = (size - targetHeight) / 2;
						const canvas = document.createElement("canvas");
						canvas.width = canvas.height = size;
						const context = canvas.getContext("2d");
						context.imageSmoothingQuality = "high";
						context.drawImage(
							sourceCanvas,
							minX,
							minY,
							width,
							height,
							targetX,
							targetY,
							targetWidth,
							targetHeight,
						);
						return {
							png: canvas.toDataURL("image/png").split(",")[1],
							hotspotX: (targetX + (hotspot[0] - sourceX - minX) * scale) / size,
							hotspotY: (targetY + (hotspot[1] - minY) * scale) / size,
						};
					},
					{
						png: source.toString("base64"),
						type,
						size: SIZE,
						innerSize: INNER_SIZE,
						hotspot: theme.hotspots[type],
					},
				);
				const filename = `${type}${variant}.png`;
				await writeFile(path.join(output, filename), Buffer.from(result.png, "base64"));
				console.log(
					`${theme.id}/${filename}: hotspot ${result.hotspotX.toFixed(4)}, ${result.hotspotY.toFixed(4)}`,
				);
			}
		}
	}
} finally {
	await browser.close();
}
