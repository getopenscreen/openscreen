import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TEXT_FONT_FAMILIES, textFontFile } from "@/lib/textFonts";
import { type FontMetrics, measureWithFontTables, readFontMetrics } from "./fontTables";

const FONTS = path.resolve(__dirname, "../../../../public");

function shipped(family: (typeof TEXT_FONT_FAMILIES)[number], weight: "normal" | "bold") {
	const metrics = readFontMetrics(readFileSync(path.join(FONTS, textFontFile(family, weight))));
	if (!metrics) throw new Error(`${family} ${weight} unreadable`);
	return metrics;
}

const style = (
	overrides: Partial<Parameters<ReturnType<typeof measureWithFontTables>>[1]> = {},
) => ({
	color: "#ffffff",
	backgroundColor: "rgba(0, 0, 0, 0.7)",
	fontSize: 64,
	fontFamily: "Inter",
	fontWeight: "bold" as const,
	fontStyle: "normal" as const,
	textDecoration: "none" as const,
	textAlign: "center" as const,
	textAnimation: "none" as const,
	...overrides,
});

describe("readFontMetrics", () => {
	it("reads every shipped font", () => {
		for (const family of TEXT_FONT_FAMILIES) {
			for (const weight of ["normal", "bold"] as const) {
				const font = shipped(family, weight);
				expect(font.unitsPerEm).toBeGreaterThan(0);
				expect(font.lineHeight).toBeGreaterThan(font.unitsPerEm);
				expect(font.advanceOf("A".codePointAt(0) ?? 0)).toBeGreaterThan(0);
			}
		}
	});

	it("knows a glyph the font lacks from one it has", () => {
		const inter = shipped("Inter", "bold");
		expect(inter.advanceOf(" ".codePointAt(0) ?? 0)).toBeGreaterThan(0);
		// A CJK ideograph: not in Inter.
		expect(inter.advanceOf(0x4e2d)).toBeNull();
	});

	it("refuses bytes that are not a font", () => {
		expect(readFontMetrics(new Uint8Array([1, 2, 3, 4]))).toBeNull();
	});
});

describe("measureWithFontTables", () => {
	const measure = measureWithFontTables(shipped);

	it("measures Inter bold at its real width, wider than the old estimate", () => {
		// What the chat agent stored for "Demo OpenScreen" at 64 px: 15 × 0.56 em, 538 px. Inter
		// bold draws it 586 px wide, and the compositor wrapped the second word out of the box.
		const block = measure("Demo OpenScreen", style());
		expect(block.width).toBeCloseTo(586.5, 1);
		expect(block.width).toBeGreaterThan(15 * 0.56 * 64 + 40);
	});

	it("tells the weights and the families apart, and scales with the size", () => {
		const bold = measure("Demo OpenScreen", style());
		expect(measure("Demo OpenScreen", style({ fontWeight: "normal" })).width).toBeLessThan(
			bold.width,
		);
		expect(measure("Demo OpenScreen", style({ fontFamily: "Oswald" })).width).toBeLessThan(
			bold.width,
		);
		expect(measure("Demo OpenScreen", style({ fontSize: 32 })).width).toBeCloseTo(
			bold.width / 2,
			6,
		);
	});

	it("takes the longest line, and one line height per line", () => {
		const one = measure("Demo", style());
		const two = measure("Demo\nOpenScreen", style());
		expect(two.width).toBeCloseTo(measure("OpenScreen", style()).width, 6);
		expect(two.height).toBeCloseTo(2 * one.height, 6);
		// Inter's hhea line is about 1.21 em.
		expect(one.height / 64).toBeGreaterThan(1.1);
		expect(one.height / 64).toBeLessThan(1.35);
	});

	it("counts a character the font lacks as an em, and falls back without the font", () => {
		expect(measure("中", style()).width).toBeCloseTo(64, 6);
		const none: (f: string, w: string) => FontMetrics | null = () => null;
		const fallback = measureWithFontTables(none)("Demo OpenScreen", style());
		expect(fallback.width).toBeCloseTo(15 * 0.56 * 64, 6);
		// A font whose advances cannot be read (a truncated `hmtx`) is measured the same way.
		const truncated: FontMetrics = {
			unitsPerEm: 1000,
			lineHeight: 1200,
			advanceOf: () => {
				throw new RangeError("Offset is outside the bounds of the DataView");
			},
		};
		expect(measureWithFontTables(() => truncated)("Demo OpenScreen", style())).toEqual(fallback);
	});
});
