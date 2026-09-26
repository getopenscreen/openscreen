import { describe, expect, it } from "vitest";
import {
	contrastRatio,
	isReadableOn,
	MIN_TEXT_CONTRAST,
	paletteFor,
	parseRgb,
	readableText,
	TEXT_PALETTE,
	textForPlate,
} from "./textContrast";

const DARK = "rgba(0, 0, 0, 0.7)";
const LIGHT = "rgba(255, 255, 255, 0.85)";

describe("text contrast", () => {
	it("reads the forms the compositor parses", () => {
		expect(parseRgb("#fff")).toEqual({ r: 255, g: 255, b: 255 });
		expect(parseRgb("#1d4ed8")).toEqual({ r: 29, g: 78, b: 216 });
		expect(parseRgb("rgba(0, 0, 0, 0.7)")).toEqual({ r: 0, g: 0, b: 0 });
		expect(parseRgb("transparent")).toBeNull();
	});

	it("matches the WCAG reference ratios", () => {
		expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
		expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
	});

	it("offers four palette colours on each plate and all eight without one", () => {
		expect(paletteFor(DARK)).toHaveLength(4);
		expect(paletteFor(LIGHT)).toHaveLength(4);
		expect(paletteFor("transparent")).toEqual([...TEXT_PALETTE]);
	});

	it("never offers text the colour of its plate", () => {
		for (const plate of [DARK, LIGHT, "#000000", "#ffffff"]) {
			for (const c of paletteFor(plate)) {
				expect(contrastRatio(c, plate)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
			}
		}
	});

	it("keeps readable text and swaps unreadable text when the plate changes", () => {
		expect(textForPlate("#fde047", DARK)).toBe("#fde047");
		expect(textForPlate("#ffffff", LIGHT)).toBe("#111111");
		expect(textForPlate("#111111", DARK)).toBe("#ffffff");
		expect(textForPlate("#111111", "transparent")).toBe("#111111");
	});

	it("pushes a free colour just far enough to read, keeping its hue", () => {
		const fixed = readableText("#3b82f6", DARK);
		expect(isReadableOn(fixed, DARK)).toBe(true);
		expect(fixed).not.toBe("#ffffff");
		expect(isReadableOn(readableText("#3b82f6", LIGHT), LIGHT)).toBe(true);
		expect(readableText("#ffffff", DARK)).toBe("#ffffff");
	});
});
