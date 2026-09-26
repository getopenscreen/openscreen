import { describe, expect, it } from "vitest";
import { parseCssGradient } from "@/lib/exporter/gradientParser";
import { gradientSeedColor, oneColorGradient } from "./gradientBuilder";

function lightness(hex: string): number {
	const n = Number.parseInt(hex.slice(1), 16);
	const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255);
	return ((Math.max(...channels) + Math.min(...channels)) / 2) * 100;
}

function stopsOf(css: string): string[] {
	return parseCssGradient(css)?.stops.map((s) => s.color) ?? [];
}

describe("oneColorGradient", () => {
	it("makes two hex stops, the shape the compositor and the presets share", () => {
		const css = oneColorGradient("#3b82f6");
		expect(css).toMatch(/^linear-gradient\(135deg, #[0-9a-f]{6}, #[0-9a-f]{6}\)$/);
		expect(stopsOf(css)).toHaveLength(2);
	});

	it("keeps a mid-tone colour as the first stop", () => {
		expect(stopsOf(oneColorGradient("#3b82f6"))[0]).toBe("#3b82f6");
	});

	it("holds both ends between 35% and 85% lightness, whatever is picked", () => {
		for (const pick of ["#000000", "#ffffff", "#ff0000", "#0a0a2a", "#fffde0", "#777", "#10b981"]) {
			for (const stop of stopsOf(oneColorGradient(pick))) {
				const l = lightness(stop);
				// One unit of slack for the rounding to 8-bit channels.
				expect(l).toBeGreaterThanOrEqual(34.5);
				expect(l).toBeLessThanOrEqual(85.5);
			}
		}
	});

	it("gives two different stops, so the gradient is visible", () => {
		for (const pick of ["#000000", "#ffffff", "#3b82f6"]) {
			const [a, b] = stopsOf(oneColorGradient(pick));
			expect(a).not.toBe(b);
		}
	});
});

describe("gradientSeedColor", () => {
	it("reads the first stop back from a gradient it made", () => {
		expect(gradientSeedColor(oneColorGradient("#3b82f6"))).toBe("#3b82f6");
	});

	it("has nothing to offer for a colour, an image or an rgb() stop", () => {
		expect(gradientSeedColor("#3b82f6")).toBeNull();
		expect(gradientSeedColor("/wallpapers/wallpaper1.jpg")).toBeNull();
		expect(
			gradientSeedColor("linear-gradient(135deg, rgb(1, 2, 3) 0%, rgb(4, 5, 6) 100%)"),
		).toBeNull();
	});
});
