// A contact sheet: frames of a video laid out as one picture, each with its time on it, so a
// client reads a film's rhythm, or a transition frame by frame, for the cost of one image.
//
// Pixels only. The host decodes and encodes (frame-images.ts, Electron's own codec), so the
// layout and the labels run under plain vitest.

/** Raw pixels, four bytes each, in whatever channel order the host's decoder gives. The sheet
 *  only moves them and draws in white, black and grey, which read the same in any order. */
export interface Bitmap {
	width: number;
	height: number;
	pixels: Buffer;
}

/** Part of a frame, as fractions of its width and height from its top-left corner. */
export interface FrameRegion {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** The pixel work the media tools ask their host for. */
export interface FrameImages {
	/** A JPEG's pixels, scaled down to at most `maxWidth` wide. */
	decode(jpeg: Buffer, maxWidth: number): Bitmap;
	encode(bitmap: Bitmap): Buffer;
	/** The part of a JPEG inside `region`, at its own resolution, scaled down only when it is
	 *  wider than `maxWidth`. */
	crop(jpeg: Buffer, region: FrameRegion, maxWidth: number): Buffer;
}

/** `region` in whole pixels of a `width` by `height` picture: inside it, and never empty. */
export function regionRect(
	width: number,
	height: number,
	region: FrameRegion,
): { x: number; y: number; width: number; height: number } {
	const x = Math.min(width - 1, Math.max(0, Math.round(region.x * width)));
	const y = Math.min(height - 1, Math.max(0, Math.round(region.y * height)));
	return {
		x,
		y,
		width: Math.max(1, Math.min(width - x, Math.round(region.width * width))),
		height: Math.max(1, Math.min(height - y, Math.round(region.height * height))),
	};
}

/** How far a channel must move for a pixel to count as changed: above what resampling leaves
 *  beside an edit, below a faint tint or shadow. */
const CHANGE_THRESHOLD = 8;

/**
 * Where two pictures of the same size differ: the share of their pixels that changed, and the
 * box around all of them as fractions of the picture, the form a frame's `region` takes.
 * `null` when no pixel changed.
 */
export function changedRegion(
	before: Bitmap,
	after: Bitmap,
): { share: number; region: FrameRegion } | null {
	const { width, height } = before;
	let changed = 0;
	let left = width;
	let top = height;
	let right = -1;
	let bottom = -1;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const at = (y * width + x) * 4;
			if (
				Math.abs(before.pixels[at] - after.pixels[at]) <= CHANGE_THRESHOLD &&
				Math.abs(before.pixels[at + 1] - after.pixels[at + 1]) <= CHANGE_THRESHOLD &&
				Math.abs(before.pixels[at + 2] - after.pixels[at + 2]) <= CHANGE_THRESHOLD
			) {
				continue;
			}
			changed++;
			left = Math.min(left, x);
			right = Math.max(right, x);
			top = Math.min(top, y);
			bottom = Math.max(bottom, y);
		}
	}
	if (changed === 0) return null;
	return {
		share: changed / (width * height),
		region: {
			x: left / width,
			y: top / height,
			width: (right - left + 1) / width,
			height: (bottom - top + 1) / height,
		},
	};
}

/** As wide as a single frame of getFrames, so a sheet costs a client what one frame does. */
const SHEET_WIDTH = 1280;
/** Between two tiles: enough to tell where one frame ends. */
const GAP = 2;
/** Behind the tiles, and in place of a frame the video does not have. */
const BACKGROUND = 32;

export function tileWidthFor(columns: number): number {
	return Math.floor((SHEET_WIDTH - GAP * (columns - 1)) / columns);
}

// Five by seven, the characters a time takes: "12.40s".
const GLYPHS: Record<string, readonly string[]> = {
	"0": [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
	"1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
	"2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
	"3": [".###.", "#...#", "....#", "..##.", "....#", "#...#", ".###."],
	"4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
	"5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
	"6": ["..##.", ".#...", "#....", "####.", "#...#", "#...#", ".###."],
	"7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
	"8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
	"9": [".###.", "#...#", "#...#", ".####", "....#", "...#.", ".##.."],
	".": [".....", ".....", ".....", ".....", ".....", ".##..", ".##.."],
	s: [".....", ".....", ".####", "#....", ".###.", "....#", "####."],
};
const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 7;

export interface SheetTile {
	/** `null` where the video has no frame: the tile keeps its place and its label. */
	bitmap: Bitmap | null;
	label: string;
}

/** The tiles in reading order, `columns` across, each `tileWidth` by `tileHeight`. */
export function composeContactSheet(
	tiles: readonly SheetTile[],
	columns: number,
	tileWidth: number,
	tileHeight: number,
): Bitmap {
	// Read at a glance on a narrow tile, without covering a wide one.
	const scale = Math.max(2, Math.round(tileWidth / 160));
	// A row is never shorter than its labels: a thin strip cropped out of a frame still has its
	// time in its own cell, not over the next row.
	const rowHeight = Math.max(tileHeight, (GLYPH_HEIGHT + 2) * scale);
	const rows = Math.ceil(tiles.length / columns);
	const width = columns * tileWidth + (columns - 1) * GAP;
	const height = rows * rowHeight + (rows - 1) * GAP;
	const pixels = Buffer.alloc(width * height * 4, BACKGROUND);
	const sheet = { width, height, pixels };
	tiles.forEach((tile, i) => {
		const left = (i % columns) * (tileWidth + GAP);
		const top = Math.floor(i / columns) * (rowHeight + GAP);
		if (tile.bitmap) blit(sheet, tile.bitmap, left, top, tileWidth, tileHeight);
		drawLabel(sheet, tile.label, left, top, scale);
	});
	// Opaque whatever the tiles carried: a sheet is a picture, not a layer.
	for (let alpha = 3; alpha < pixels.length; alpha += 4) pixels[alpha] = 255;
	return sheet;
}

/** Copies `source` onto `sheet` at (`left`, `top`), cut to `maxWidth` by `maxHeight`. */
function blit(
	sheet: Bitmap,
	source: Bitmap,
	left: number,
	top: number,
	maxWidth: number,
	maxHeight: number,
): void {
	const rowBytes = Math.min(source.width, maxWidth) * 4;
	const rows = Math.min(source.height, maxHeight);
	for (let y = 0; y < rows; y++) {
		const from = y * source.width * 4;
		source.pixels.copy(sheet.pixels, ((top + y) * sheet.width + left) * 4, from, from + rowBytes);
	}
}

function fill(
	sheet: Bitmap,
	left: number,
	top: number,
	width: number,
	height: number,
	value: number,
): void {
	const right = Math.min(sheet.width, left + width);
	const bottom = Math.min(sheet.height, top + height);
	for (let y = top; y < bottom; y++) {
		const row = y * sheet.width;
		for (let x = left; x < right; x++) {
			const at = (row + x) * 4;
			sheet.pixels[at] = value;
			sheet.pixels[at + 1] = value;
			sheet.pixels[at + 2] = value;
		}
	}
}

/** White on a black plate, in the tile's top-left corner: readable over any frame. */
function drawLabel(sheet: Bitmap, label: string, left: number, top: number, scale: number): void {
	const advance = (GLYPH_WIDTH + 1) * scale;
	fill(sheet, left, top, label.length * advance + scale, (GLYPH_HEIGHT + 2) * scale, 0);
	[...label].forEach((character, index) => {
		const glyph = GLYPHS[character];
		if (!glyph) return;
		glyph.forEach((row, y) => {
			for (let x = 0; x < GLYPH_WIDTH; x++) {
				if (row[x] !== "#") continue;
				fill(
					sheet,
					left + scale + index * advance + x * scale,
					top + scale + y * scale,
					scale,
					scale,
					255,
				);
			}
		});
	});
}
