import { describe, expect, it } from "vitest";
import { type Bitmap, composeContactSheet, regionRect, tileWidthFor } from "./contact-sheet";

/** A tile of one value, so a pixel says which tile it came from. */
function flat(width: number, height: number, value: number): Bitmap {
	return { width, height, pixels: Buffer.alloc(width * height * 4, value) };
}

function pixel(bitmap: Bitmap, x: number, y: number): number {
	return bitmap.pixels[(y * bitmap.width + x) * 4];
}

/** How many pixels of a rectangle hold `value`. */
function count(
	bitmap: Bitmap,
	left: number,
	top: number,
	width: number,
	height: number,
	value: number,
) {
	let found = 0;
	for (let y = top; y < top + height; y++) {
		for (let x = left; x < left + width; x++) {
			if (pixel(bitmap, x, y) === value) found++;
		}
	}
	return found;
}

describe("regionRect", () => {
	it("turns fractions into pixels of the picture", () => {
		expect(regionRect(1920, 1080, { x: 0.5, y: 0.25, width: 0.25, height: 0.5 })).toEqual({
			x: 960,
			y: 270,
			width: 480,
			height: 540,
		});
	});

	it("stays inside the picture, and never comes out empty", () => {
		expect(regionRect(100, 50, { x: 0.9, y: 0.9, width: 0.5, height: 0.5 })).toEqual({
			x: 90,
			y: 45,
			width: 10,
			height: 5,
		});
		expect(regionRect(100, 50, { x: 1, y: 1, width: 0.001, height: 0.001 })).toEqual({
			x: 99,
			y: 49,
			width: 1,
			height: 1,
		});
	});
});

describe("tileWidthFor", () => {
	it("fits the columns and their gaps in the width of one frame", () => {
		expect(tileWidthFor(4)).toBe(318);
		expect(4 * tileWidthFor(4) + 3 * 2).toBeLessThanOrEqual(1280);
		expect(6 * tileWidthFor(6) + 5 * 2).toBeLessThanOrEqual(1280);
		expect(tileWidthFor(2)).toBe(639);
	});
});

describe("composeContactSheet", () => {
	const tileWidth = 80;
	const tileHeight = 45;
	const sheet = composeContactSheet(
		[
			{ bitmap: flat(tileWidth, tileHeight, 100), label: "0.50s" },
			{ bitmap: flat(tileWidth, tileHeight, 150), label: "1.00s" },
			{ bitmap: null, label: "9.99s" },
		],
		2,
		tileWidth,
		tileHeight,
	);

	it("lays the tiles out in reading order, a gap apart", () => {
		expect(sheet.width).toBe(2 * tileWidth + 2);
		expect(sheet.height).toBe(2 * tileHeight + 2);
		expect(sheet.pixels).toHaveLength(sheet.width * sheet.height * 4);
		// Bottom-right of each tile: clear of its label.
		expect(pixel(sheet, tileWidth - 1, tileHeight - 1)).toBe(100);
		expect(pixel(sheet, tileWidth + 2 + tileWidth - 1, tileHeight - 1)).toBe(150);
		// The gap, and the place of the tile that has no frame.
		expect(pixel(sheet, tileWidth, 10)).toBe(32);
		expect(pixel(sheet, tileWidth - 1, tileHeight + 2 + tileHeight - 1)).toBe(32);
		// No tile in the last cell.
		expect(pixel(sheet, tileWidth + 2 + 10, tileHeight + 2 + 30)).toBe(32);
	});

	it("is opaque everywhere", () => {
		for (let alpha = 3; alpha < sheet.pixels.length; alpha += 4) {
			if (sheet.pixels[alpha] !== 255) throw new Error(`transparent at byte ${alpha}`);
		}
	});

	it("prints each tile's time in white on a black plate, the missing frame's too", () => {
		// "0.50s" at scale 2: five characters, 12 px each, on a plate 18 px high.
		for (const [left, top] of [
			[0, 0],
			[tileWidth + 2, 0],
			[0, tileHeight + 2],
		]) {
			const white = count(sheet, left, top, 62, 18, 255);
			const black = count(sheet, left, top, 62, 18, 0);
			expect(white).toBeGreaterThan(40);
			expect(black).toBeGreaterThan(white);
			expect(white + black).toBe(62 * 18);
		}
	});

	it("draws different times differently, and the same time the same", () => {
		const one = composeContactSheet([{ bitmap: null, label: "1.00s" }], 1, 80, 45);
		const same = composeContactSheet([{ bitmap: null, label: "1.00s" }], 1, 80, 45);
		const other = composeContactSheet([{ bitmap: null, label: "7.25s" }], 1, 80, 45);
		expect(one.pixels.equals(same.pixels)).toBe(true);
		expect(one.pixels.equals(other.pixels)).toBe(false);
	});

	it("cuts a tile larger than its cell instead of spilling into the next", () => {
		const spilled = composeContactSheet(
			[
				{ bitmap: flat(tileWidth + 20, tileHeight + 20, 200), label: "" },
				{ bitmap: flat(tileWidth, tileHeight, 90), label: "" },
			],
			2,
			tileWidth,
			tileHeight,
		);
		expect(pixel(spilled, tileWidth, 20)).toBe(32);
		expect(pixel(spilled, tileWidth + 2, 20)).toBe(90);
	});
});
