import { describe, expect, it } from "vitest";
import {
	type Bitmap,
	changedRegion,
	composeContactSheet,
	regionRect,
	tileWidthFor,
} from "./contact-sheet";

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

describe("changedRegion", () => {
	/** A flat picture with one pixel set apart. */
	function withPixel(x: number, y: number, value: number): Bitmap {
		const bitmap = flat(100, 50, 60);
		bitmap.pixels.fill(value, (y * 100 + x) * 4, (y * 100 + x) * 4 + 3);
		return bitmap;
	}

	it("finds nothing between two pictures that match", () => {
		expect(changedRegion(flat(100, 50, 60), flat(100, 50, 60))).toBeNull();
	});

	it("boxes every changed pixel, in fractions of the picture", () => {
		const after = flat(100, 50, 60);
		for (const [x, y] of [
			[20, 10],
			[59, 10],
			[40, 29],
		]) {
			after.pixels.fill(200, (y * 100 + x) * 4, (y * 100 + x) * 4 + 3);
		}
		expect(changedRegion(flat(100, 50, 60), after)).toEqual({
			share: 3 / 5000,
			region: { x: 0.2, y: 0.2, width: 0.4, height: 0.4 },
		});
	});

	it("lets through what resampling leaves, and catches a faint tint", () => {
		const before = flat(100, 50, 60);
		expect(changedRegion(before, withPixel(5, 5, 68))).toBeNull();
		expect(changedRegion(before, withPixel(5, 5, 69))?.share).toBe(1 / 5000);
		// One channel is enough: a tint moves a colour, not a brightness.
		const tinted = flat(100, 50, 60);
		tinted.pixels[(5 * 100 + 5) * 4 + 2] = 90;
		expect(changedRegion(before, tinted)?.region).toEqual({
			x: 0.05,
			y: 0.1,
			width: 0.01,
			height: 0.02,
		});
	});
});

describe("a sheet of thin strips", () => {
	it("gives each row the height of its label, so no time spills into the next cell", () => {
		const tileWidth = tileWidthFor(2);
		// Three strips one pixel high, two across: the fourth cell stays empty.
		const strip = () => flat(tileWidth, 1, 120);
		const sheet = composeContactSheet(
			[
				{ bitmap: strip(), label: "1.00s" },
				{ bitmap: strip(), label: "2.00s" },
				{ bitmap: strip(), label: "3.00s" },
			],
			2,
			tileWidth,
			1,
		);
		// A label plate is 9 glyph rows of 4 px at this width: each row is that tall.
		expect(sheet.height).toBe(2 * 36 + 2);
		// The third strip starts the second row, at 36 + 2, seen right of its label plate...
		expect(count(sheet, tileWidth - 10, 38, 10, 1, 120)).toBe(10);
		// ...and the gap above it is background: it was not laid over the first label.
		expect(count(sheet, 0, 36, tileWidth, 2, 32)).toBe(tileWidth * 2);
		// The empty fourth cell is background all over: the second label did not reach it.
		expect(count(sheet, tileWidth + 2, 38, tileWidth, 36, 32)).toBe(tileWidth * 36);
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
