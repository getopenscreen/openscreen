// The font families text can be drawn in: captions and annotations alike.
//
// Each family ships as two files in `public/fonts`, `<Family without spaces>-Regular.ttf` and
// `-Bold.ttf` (the only two weights a control can produce). The compositor registers them
// privately when it starts (`OPENSCREEN_FONTS_DIR`, set by compositorViewService.ts) and never
// looks at the fonts installed on the machine, so a family that is not listed here cannot be
// drawn. Offering one anyway is a control that changes nothing: the picker used to list 17
// families from Google Fonts, and on a machine without them every choice rendered in the same
// fallback face.

import { getAssetPath } from "./assetPath";

export const TEXT_FONT_FAMILIES = ["Inter", "Lora", "Oswald", "Caveat", "IBM Plex Mono"] as const;

export type TextFontFamily = (typeof TEXT_FONT_FAMILIES)[number];

export const DEFAULT_TEXT_FONT_FAMILY: TextFontFamily = "Inter";

/**
 * A stored family, read back: itself when it ships, the default otherwise. Projects saved while
 * the picker offered families that never shipped keep rendering, in the face every one of those
 * choices actually fell back to on a machine without the font.
 */
export function resolveTextFontFamily(value: unknown): TextFontFamily {
	return (TEXT_FONT_FAMILIES as readonly unknown[]).includes(value)
		? (value as TextFontFamily)
		: DEFAULT_TEXT_FONT_FAMILY;
}

/** Where a family's weight ships, relative to the asset base (`public/` in dev). */
export function textFontFile(family: TextFontFamily, weight: "normal" | "bold"): string {
	return `fonts/${family.replace(/ /g, "")}-${weight === "bold" ? "Bold" : "Regular"}.ttf`;
}

/**
 * Makes the shipped files the renderer's faces too, so the picker shows each family exactly as
 * the compositor will draw it, offline included. Faces load lazily, on first use. Cosmetic, so
 * it never throws: a picker without specimens still picks.
 */
export function registerTextFontFaces(): void {
	if (typeof FontFace === "undefined" || typeof document === "undefined" || !document.fonts) {
		return;
	}
	try {
		for (const family of TEXT_FONT_FAMILIES) {
			for (const weight of ["normal", "bold"] as const) {
				const url = getAssetPath(textFontFile(family, weight));
				document.fonts.add(new FontFace(family, `url("${url}")`, { weight }));
			}
		}
	} catch (error) {
		console.warn("[fonts] text font specimens unavailable:", error);
	}
}
