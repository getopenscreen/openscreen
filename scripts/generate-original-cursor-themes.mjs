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
	{
		id: "studio-ink",
		hotspots: { arrow: [158, 48], pointer: [1258, 50] },
		modelHotspots: { arrow: [158, 44], pointer: [1256, 86] },
	},
	{
		id: "prism-glow",
		hotspots: { arrow: [208, 42], pointer: [1220, 50] },
		modelHotspots: { arrow: [204, 40], pointer: [1219, 55] },
	},
	{
		id: "pop-coral",
		hotspots: { arrow: [265, 58], pointer: [1245, 65] },
		modelHotspots: { arrow: [254, 61], pointer: [1263, 92] },
	},
	{
		id: "pixel-candy",
		hotspots: { arrow: [273, 76], pointer: [1218, 78] },
		modelHotspots: { arrow: [294, 113], pointer: [1238, 112] },
	},
	{
		id: "star-sprout",
		hotspots: { arrow: [210, 65], pointer: [1218, 65] },
		modelHotspots: { arrow: [234, 119], pointer: [1227, 103] },
	},
];

const browser = await chromium.launch();
try {
	const page = await browser.newPage();
	const modelFaces = [];
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

		// The model face is authored separately from its flat 2D face. The relief PNG is
		// grayscale height data, aligned pixel-for-pixel with model-arrow/model-pointer.png.
		const modelSource = await readFile(path.join(SOURCE_DIR, theme.id, "model-source.png"));
		for (const type of ["arrow", "pointer"]) {
			const result = await page.evaluate(
				async ({ png, type, size, innerSize, hotspot, themeId }) => {
					const image = new Image();
					image.src = `data:image/png;base64,${png}`;
					await image.decode();
					const halfWidth = Math.floor(image.width / 2);
					const sourceX = type === "arrow" ? 0 : halfWidth;
					const sourceCanvas = document.createElement("canvas");
					sourceCanvas.width = halfWidth;
					sourceCanvas.height = image.height;
					const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
					sourceContext.drawImage(image, -sourceX, 0);
					const sourcePixels = sourceContext.getImageData(0, 0, halfWidth, image.height);
					const sourceMask = new Uint8Array(halfWidth * image.height);
					for (let i = 0; i < sourceMask.length; i++) {
						const alphaIndex = i * 4 + 3;
						if (
							themeId === "studio-ink" &&
							type === "pointer" &&
							sourcePixels.data[alphaIndex] >= 32
						) {
							const colorIndex = i * 4;
							const luminance =
								0.2126 * sourcePixels.data[colorIndex] +
								0.7152 * sourcePixels.data[colorIndex + 1] +
								0.0722 * sourcePixels.data[colorIndex + 2];
							// The 3D glove is ivory ceramic. Drop the generated dark ink fringe so
							// that it cannot become a fake blue/black sidewall in the volume.
							if (luminance < 84) sourcePixels.data[alphaIndex] = 0;
						}
						if (sourcePixels.data[alphaIndex] < 32) sourcePixels.data[alphaIndex] = 0;
						sourceMask[i] = sourcePixels.data[alphaIndex] >= 32 ? 1 : 0;
					}

					// Drop disconnected specks from the transparent cutout without trimming the
					// separate Star Sprout charm, which is deliberately a second modeled piece.
					const visited = new Uint8Array(sourceMask.length);
					const queue = new Int32Array(sourceMask.length);
					const smallComponents = [];
					for (let start = 0; start < sourceMask.length; start++) {
						if (!sourceMask[start] || visited[start]) continue;
						let head = 0;
						let tail = 0;
						queue[tail++] = start;
						visited[start] = 1;
						while (head < tail) {
							const at = queue[head++];
							const x = at % halfWidth;
							const y = Math.floor(at / halfWidth);
							for (let oy = -1; oy <= 1; oy++) {
								for (let ox = -1; ox <= 1; ox++) {
									const nx = x + ox;
									const ny = y + oy;
									if (nx < 0 || nx >= halfWidth || ny < 0 || ny >= image.height) continue;
									const next = ny * halfWidth + nx;
									if (sourceMask[next] && !visited[next]) {
										visited[next] = 1;
										queue[tail++] = next;
									}
								}
							}
						}
						if (tail < 180) smallComponents.push(queue.slice(0, tail));
					}
					for (const component of smallComponents) {
						for (const at of component) sourcePixels.data[at * 4 + 3] = 0;
					}
					sourceContext.putImageData(sourcePixels, 0, 0);

					let minX = halfWidth;
					let minY = image.height;
					let maxX = 0;
					let maxY = 0;
					for (let y = 0; y < image.height; y++) {
						for (let x = 0; x < halfWidth; x++) {
							if (sourcePixels.data[(y * halfWidth + x) * 4 + 3] < 28) continue;
							minX = Math.min(minX, x);
							minY = Math.min(minY, y);
							maxX = Math.max(maxX, x);
							maxY = Math.max(maxY, y);
						}
					}
					if (minX > maxX || minY > maxY) throw new Error(`${themeId}/${type}: empty model art`);
					const width = maxX - minX + 1;
					const height = maxY - minY + 1;
					const scale = innerSize / Math.max(width, height);
					const targetWidth = width * scale;
					const targetHeight = height * scale;
					const targetX = (size - targetWidth) / 2;
					const targetY = (size - targetHeight) / 2;
					const canvas = document.createElement("canvas");
					canvas.width = canvas.height = size;
					const context = canvas.getContext("2d", { willReadFrequently: true });
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
					const face = context.getImageData(0, 0, size, size);
					const mask = new Uint8Array(size * size);
					const distance = new Float32Array(size * size);
					const inf = 10000;
					let bx0 = size;
					let by0 = size;
					let bx1 = 0;
					let by1 = 0;
					for (let y = 0; y < size; y++) {
						for (let x = 0; x < size; x++) {
							const i = y * size + x;
							mask[i] = face.data[i * 4 + 3] >= 96 ? 1 : 0;
							distance[i] = mask[i] ? inf : 0;
							if (mask[i]) {
								bx0 = Math.min(bx0, x);
								by0 = Math.min(by0, y);
								bx1 = Math.max(bx1, x);
								by1 = Math.max(by1, y);
							}
						}
					}
					const diagonal = Math.SQRT2;
					for (let y = 0; y < size; y++) {
						for (let x = 0; x < size; x++) {
							const i = y * size + x;
							if (!mask[i]) continue;
							let d = distance[i];
							if (x > 0) d = Math.min(d, distance[i - 1] + 1);
							if (y > 0) d = Math.min(d, distance[i - size] + 1);
							if (x > 0 && y > 0) d = Math.min(d, distance[i - size - 1] + diagonal);
							if (x + 1 < size && y > 0) d = Math.min(d, distance[i - size + 1] + diagonal);
							distance[i] = d;
						}
					}
					for (let y = size - 1; y >= 0; y--) {
						for (let x = size - 1; x >= 0; x--) {
							const i = y * size + x;
							if (!mask[i]) continue;
							let d = distance[i];
							if (x + 1 < size) d = Math.min(d, distance[i + 1] + 1);
							if (y + 1 < size) d = Math.min(d, distance[i + size] + 1);
							if (x + 1 < size && y + 1 < size) d = Math.min(d, distance[i + size + 1] + diagonal);
							if (x > 0 && y + 1 < size) d = Math.min(d, distance[i + size - 1] + diagonal);
							distance[i] = d;
						}
					}

					const smooth = (a, b, x) => {
						const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
						return t * t * (3 - 2 * t);
					};
					const clamp01 = (x) => Math.max(0, Math.min(1, x));
					const segment = (u, v, a, b, c, d) => {
						const vx = c - a;
						const vy = d - b;
						const t = clamp01(((u - a) * vx + (v - b) * vy) / (vx * vx + vy * vy));
						return Math.hypot(u - (a + vx * t), v - (b + vy * t));
					};
					const ridgeSegments = [
						[0.37, 0.0, 0.39, 0.52, 0.075],
						[0.57, 0.12, 0.58, 0.55, 0.075],
						[0.76, 0.23, 0.77, 0.57, 0.075],
						[0.92, 0.36, 0.92, 0.6, 0.075],
						[0.12, 0.47, 0.34, 0.68, 0.09],
					];
					const ridge = (u, v) =>
						Math.max(
							...ridgeSegments.map(([ax, ay, bx, by, radius]) =>
								Math.exp(-((segment(u, v, ax, ay, bx, by) / radius) ** 2) * 2.2),
							),
						);
					const modelCanvas = document.createElement("canvas");
					modelCanvas.width = modelCanvas.height = size;
					const modelContext = modelCanvas.getContext("2d");
					const heightMap = modelContext.createImageData(size, size);
					const bw = Math.max(bx1 - bx0, 1);
					const bh = Math.max(by1 - by0, 1);
					let peak = 0;
					for (let y = 0; y < size; y++) {
						for (let x = 0; x < size; x++) {
							const i = y * size + x;
							const out = i * 4;
							let top = 0;
							if (mask[i]) {
								const u = (x - bx0) / bw;
								const v = (y - by0) / bh;
								const edge = smooth(0.5, 12, distance[i]);
								let [r, g, b] = [0, 1, 2].map((channel) => face.data[out + channel] / 255);
								const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
								switch (themeId) {
									case "studio-ink":
										top = 0.022 + 0.024 * edge - 0.014 * smooth(0.56, 0.88, luminance);
										if (type === "pointer") {
											top +=
												0.014 *
												Math.max(
													0.46 * Math.exp(-(((u - 0.55) / 0.43) ** 2 + ((v - 0.72) / 0.33) ** 2)),
													0.52 * ridge(u, v),
												);
										}
										break;
									case "prism-glow": {
										const gx = u * 7;
										const gy = v * 7;
										const fx = gx - Math.floor(gx);
										const fy = gy - Math.floor(gy);
										const facet = Math.abs(
											(Math.floor(gx) + Math.floor(gy)) % 2 === 0 ? fx - fy : fx + fy - 1,
										);
										const facetHeight = 1 - smooth(0.02, 0.5, facet);
										top = 0.016 + 0.028 * edge + 0.022 * facetHeight + 0.012 * (1 - luminance);
										break;
									}
									case "pop-coral": {
										const dome = Math.max(
											0,
											1 - ((u - 0.5) / 0.59) ** 2 - ((v - 0.52) / 0.75) ** 2,
										);
										top = 0.015 + 0.075 * dome + (type === "pointer" ? 0.013 * ridge(u, v) : 0);
										break;
									}
									case "pixel-candy": {
										const stair = Math.floor(Math.min(distance[i], 16) / 3);
										const block = (Math.floor(u * 16) + 2 * Math.floor(v * 16)) % 3;
										const side =
											distance[i] <= 5 && ((u > 0.64 && v > 0.18) || v > 0.78 || u < 0.11);
										if (side) {
											// Keep the original plum palette as a stepped rear/side face.
											// It is directional and recessed instead of a uniform ink outline.
											[r, g, b] = [0.36, 0.19, 0.47];
											face.data[out] = Math.round(r * 255);
											face.data[out + 1] = Math.round(g * 255);
											face.data[out + 2] = Math.round(b * 255);
											top = 0.012 + Math.max(0, stair - 1) * 0.003;
										} else {
											top =
												0.012 + stair * 0.0045 + block * 0.002 + 0.012 * smooth(0.7, 1, luminance);
											if (type === "pointer") top += Math.floor(ridge(u, v) * 4) * 0.004;
										}
										break;
									}
									case "star-sprout": {
										const yellow = r > 0.55 && g > 0.3 && b < 0.48;
										const leaf = g > r * 1.08 && g > b * 0.72;
										const dome = Math.max(
											0,
											1 - ((u - 0.5) / 0.62) ** 2 - ((v - 0.52) / 0.75) ** 2,
										);
										top =
											0.016 +
											0.045 * dome +
											(yellow ? 0.035 : 0) +
											(leaf ? 0.018 : 0) +
											(type === "pointer" ? 0.018 * ridge(u, v) : 0);
										break;
									}
								}
								top = Math.min(top, 0.12);
								peak = Math.max(peak, top);
							}
							const encoded = Math.round((top / 0.12) * 255);
							heightMap.data[out] = encoded;
							heightMap.data[out + 1] = encoded;
							heightMap.data[out + 2] = encoded;
							heightMap.data[out + 3] = 255;
						}
					}
					context.putImageData(face, 0, 0);
					modelContext.putImageData(heightMap, 0, 0);
					const colorPng = canvas.toDataURL("image/png").split(",")[1];
					const heightPng = modelCanvas.toDataURL("image/png").split(",")[1];
					return {
						colorPng,
						heightPng,
						peak,
						hotspotX: (targetX + (hotspot[0] - sourceX - minX) * scale) / size,
						hotspotY: (targetY + (hotspot[1] - minY) * scale) / size,
					};
				},
				{
					png: modelSource.toString("base64"),
					type,
					size: SIZE,
					innerSize: INNER_SIZE,
					hotspot: theme.modelHotspots[type],
					themeId: theme.id,
				},
			);
			const base = `model-${type}`;
			await writeFile(path.join(output, `${base}.png`), Buffer.from(result.colorPng, "base64"));
			await writeFile(
				path.join(output, `${base}-depth.png`),
				Buffer.from(result.heightPng, "base64"),
			);
			modelFaces.push({ theme: theme.id, type, png: result.colorPng });
			console.log(
				`${theme.id}/${base}.png: hotspot ${result.hotspotX.toFixed(4)}, ${result.hotspotY.toFixed(4)}, relief ${result.peak.toFixed(3)}`,
			);
		}
	}
	const sheet = await page.evaluate(async (items) => {
		const canvas = document.createElement("canvas");
		canvas.width = 1150;
		canvas.height = 540;
		const context = canvas.getContext("2d");
		context.fillStyle = "#eef2f8";
		context.fillRect(0, 0, canvas.width, canvas.height);
		for (let index = 0; index < items.length; index++) {
			const item = items[index];
			const column = Math.floor(index / 2);
			const row = index % 2;
			const x = column * 230 + 8;
			const y = row * 270 + 8;
			context.fillStyle = "#ffffff";
			context.fillRect(x, y, 214, 254);
			context.strokeStyle = "#d9e1ec";
			context.strokeRect(x + 0.5, y + 0.5, 213, 253);
			context.fillStyle = "#283347";
			context.font = "600 14px system-ui, sans-serif";
			context.textAlign = "center";
			context.fillText(item.theme.replaceAll("-", " "), x + 107, y + 22);
			context.fillStyle = "#68758a";
			context.font = "11px system-ui, sans-serif";
			context.fillText(item.type === "arrow" ? "ARROW" : "POINTING HAND", x + 107, y + 42);
			const image = new Image();
			image.src = `data:image/png;base64,${item.png}`;
			await image.decode();
			context.imageSmoothingEnabled = item.theme !== "pixel-candy";
			context.drawImage(image, x + 28, y + 52, 158, 158);
		}
		return canvas.toDataURL("image/png").split(",")[1];
	}, modelFaces);
	await writeFile(path.join(SOURCE_DIR, "model-face-sheet.png"), Buffer.from(sheet, "base64"));
} finally {
	await browser.close();
}
