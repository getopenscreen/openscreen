// Text that cannot be made unreadable: a short palette, named plates, and a WCAG contrast
// floor between the two. Shared by annotations and captions, which draw the same thing (text
// on an optional plate) and used to let the text take the plate's own colour in two clicks.

/** WCAG 2 AA for normal text. */
export const MIN_TEXT_CONTRAST = 4.5;

/**
 * The eight text colours offered first: four light ones for a dark plate, four dark ones for
 * a light plate. Without a plate all eight are offered. Hex6, which every renderer parses.
 */
export const TEXT_PALETTE: readonly string[] = [
	"#ffffff",
	"#fde047",
	"#86efac",
	"#7dd3fc",
	"#111111",
	"#1d4ed8",
	"#b91c1c",
	"#166534",
];

interface Rgb {
	r: number;
	g: number;
	b: number;
}

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGB_FN = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*[\d.]+\s*)?\)$/i;

/**
 * The forms the compositor's `parse_hex` reads: hex3, hex6, `rgb()` / `rgba()`. The alpha is
 * dropped on purpose, see {@link contrastRatio}. `transparent` and anything else → `null`.
 */
export function parseRgb(value: string): Rgb | null {
	const s = value.trim();
	const fn = RGB_FN.exec(s);
	if (fn) return { r: Number(fn[1]), g: Number(fn[2]), b: Number(fn[3]) };
	const hex = HEX.exec(s)?.[1];
	if (!hex) return null;
	const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
	return {
		r: Number.parseInt(full.slice(0, 2), 16),
		g: Number.parseInt(full.slice(2, 4), 16),
		b: Number.parseInt(full.slice(4, 6), 16),
	};
}

function channel(v: number): number {
	const c = v / 255;
	return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance. */
function luminance({ r, g, b }: Rgb): number {
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function ratio(a: Rgb, b: Rgb): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

/**
 * Contrast between a text colour and its plate, or `null` when there is no plate to measure
 * against (`transparent`, unparseable).
 *
 * ponytail: measured against the plate's opaque colour. What shows through a translucent
 * plate is the video, which nothing here knows; compositing over a sampled frame is the
 * upgrade if a 40% plate over a white page ever proves too weak.
 */
export function contrastRatio(text: string, plate: string): number | null {
	const fg = parseRgb(text);
	const bg = parseRgb(plate);
	return fg && bg ? ratio(fg, bg) : null;
}

/** True when the pair reads, or when there is no plate to read against. */
export function isReadableOn(text: string, plate: string): boolean {
	const r = contrastRatio(text, plate);
	return r === null || r >= MIN_TEXT_CONTRAST;
}

/** The palette entries that read on this plate: all of them without a plate. */
export function paletteFor(plate: string): string[] {
	return TEXT_PALETTE.filter((c) => isReadableOn(c, plate));
}

/**
 * The text colour to keep when the plate changes: the current one if it still reads, else
 * the palette colour with the most contrast on the new plate. Choosing a plate never leaves
 * text the colour of its plate.
 */
export function textForPlate(text: string, plate: string): string {
	if (isReadableOn(text, plate)) return text;
	const bg = parseRgb(plate);
	if (!bg) return text;
	return [...TEXT_PALETTE].sort(
		(a, b) => ratio(parseRgb(b) as Rgb, bg) - ratio(parseRgb(a) as Rgb, bg),
	)[0];
}

const toHex = ({ r, g, b }: Rgb) =>
	`#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

/**
 * A free colour, pushed just far enough toward white or black to read on the plate. Used on
 * the wheel, where the user asked for a hue: keep the hue, fix the lightness.
 */
export function readableText(text: string, plate: string): string {
	if (isReadableOn(text, plate)) return text;
	const fg = parseRgb(text);
	const bg = parseRgb(plate);
	if (!fg || !bg) return text;
	const white = { r: 255, g: 255, b: 255 };
	const black = { r: 0, g: 0, b: 0 };
	const pole = ratio(white, bg) >= ratio(black, bg) ? white : black;
	for (let t = 0.05; t < 1; t += 0.05) {
		const mixed = {
			r: fg.r + (pole.r - fg.r) * t,
			g: fg.g + (pole.g - fg.g) * t,
			b: fg.b + (pole.b - fg.b) * t,
		};
		const hex = toHex(mixed);
		if (isReadableOn(hex, plate)) return hex;
	}
	return toHex(pole);
}
