import { describe, expect, it } from "vitest";
import {
	type CursorTheme,
	DEFAULT_CURSOR_SPRITES,
	DEFAULT_CURSOR_THEME_ID,
	normalizeCursorThemeId,
	themePickerPreviewAssets,
} from "./cursorThemes";

/** The packs removed because sweezy-cursors.com's terms forbid redistributing them.
 *  Projects and presets saved with one of these ids still exist on disk. */
const REMOVED_THEME_IDS = [
	"among-us-sus-knife-and-red-animated",
	"black-and-rainbow-stroke-gradient-animated",
	"black-pixel",
	"christmas-miles-morales",
	"hello-kitty-watermelon",
	"hollow-knight-and-game-arrow",
	"hollow-knight-nail-sword-and-mask",
	"mickey-mouse-black-hand-inflated-glove",
	"naruto-akatsuki-cloud-arrow",
	"old-roblox",
	"pink-glossy-arrow-and-hand-3d",
	"pinky-pixel",
	"pokemon-neon-gengar",
	"sanrio-gudetama-and-arrow-kawaii",
	"sanrio-kuromi-skull-arrow",
	"solo-leveling-sung-jinwoo-dark-flames",
	"spring-gradient",
];

describe("normalizeCursorThemeId", () => {
	it.each(REMOVED_THEME_IDS)("maps the removed pack %s back to the default art", (id) => {
		expect(normalizeCursorThemeId(id)).toBe(DEFAULT_CURSOR_THEME_ID);
	});

	it("keeps the default, and reads anything that is not a string as the default", () => {
		expect(normalizeCursorThemeId(DEFAULT_CURSOR_THEME_ID)).toBe(DEFAULT_CURSOR_THEME_ID);
		expect(normalizeCursorThemeId(undefined)).toBe(DEFAULT_CURSOR_THEME_ID);
		expect(normalizeCursorThemeId(42)).toBe(DEFAULT_CURSOR_THEME_ID);
	});
});

describe("themePickerPreviewAssets", () => {
	it("a pack with its own hand exposes distinct arrow and pointer", () => {
		const theme: CursorTheme = {
			id: "arrow-and-hand",
			name: "Arrow and hand",
			assets: {
				arrow: {
					assetPath: "cursors/fake/arrow.png",
					width: 32,
					height: 32,
					hotspotX: 0,
					hotspotY: 0,
				},
				pointer: {
					assetPath: "cursors/fake/pointer.png",
					width: 32,
					height: 32,
					hotspotX: 8,
					hotspotY: 0,
				},
			},
		};
		const preview = themePickerPreviewAssets(theme);
		expect(preview.arrow).toBe("cursors/fake/arrow.png");
		expect(preview.pointer).toBe("cursors/fake/pointer.png");
	});

	it("arrow-only theme has no pointer preview", () => {
		const theme: CursorTheme = {
			id: "arrow-only",
			name: "Arrow only",
			assets: {
				arrow: {
					assetPath: "cursors/fake/arrow.png",
					width: 32,
					height: 32,
					hotspotX: 0,
					hotspotY: 0,
				},
			},
		};
		const preview = themePickerPreviewAssets(theme);
		expect(preview.arrow).toBe("cursors/fake/arrow.png");
		expect(preview.pointer).toBeNull();
	});

	it("default theme uses built-in arrow and pointer when they differ", () => {
		const preview = themePickerPreviewAssets(null);
		expect(preview.arrow).toBe(DEFAULT_CURSOR_SPRITES.arrow.assetPath);
		if (DEFAULT_CURSOR_SPRITES.pointer.assetPath !== DEFAULT_CURSOR_SPRITES.arrow.assetPath) {
			expect(preview.pointer).toBe(DEFAULT_CURSOR_SPRITES.pointer.assetPath);
		} else {
			expect(preview.pointer).toBeNull();
		}
	});
});
