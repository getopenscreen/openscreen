import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	CURSOR_THEMES,
	type CursorTheme,
	DEFAULT_CURSOR_SPRITES,
	DEFAULT_CURSOR_THEME_ID,
	normalizeCursorThemeId,
	resolveCursorSprites,
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

	it.each(CURSOR_THEMES)("keeps the original $name theme", (theme) => {
		expect(normalizeCursorThemeId(theme.id)).toBe(theme.id);
		const sprites = resolveCursorSprites(theme.id);
		expect(sprites.arrow.assetPath).toBe(theme.assets.arrow?.assetPath);
		expect(sprites.pointer.assetPath).toBe(theme.assets.pointer?.assetPath);
		expect(sprites.text).toBe(DEFAULT_CURSOR_SPRITES.text);
		expect(sprites.arrow.hotspotX).toBeCloseTo((theme.assets.arrow?.hotspotX ?? 0) / 32);
		expect(sprites.pointer.hotspotY).toBeCloseTo((theme.assets.pointer?.hotspotY ?? 0) / 32);
		for (const asset of [theme.assets.arrow, theme.assets.pointer]) {
			if (!asset) throw new Error(`${theme.id} needs both cursor states`);
			const png = readFileSync(join(process.cwd(), "public", asset.assetPath));
			expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
			expect(png.readUInt32BE(16)).toBe(128);
			expect(png.readUInt32BE(20)).toBe(128);
		}
	});

	it.each(CURSOR_THEMES)("ships aligned 3D arrow and hand assets for $name", (theme) => {
		const sprites = resolveCursorSprites(theme.id, false, true);
		for (const state of ["arrow", "pointer"] as const) {
			const asset = theme.assets[state];
			if (!asset?.model3d) throw new Error(`${theme.id}/${state} needs a 3D face and relief map`);

			expect(sprites[state].assetPath).toBe(asset.model3d.assetPath);
			expect(sprites[state].modelDepthPath).toBe(asset.model3d.depthPath);
			expect(sprites[state].hotspotX).toBeCloseTo(asset.model3d.hotspotX / 32);
			expect(sprites[state].hotspotY).toBeCloseTo(asset.model3d.hotspotY / 32);

			for (const path of [asset.model3d.assetPath, asset.model3d.depthPath]) {
				const png = readFileSync(join(process.cwd(), "public", path));
				expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
				expect(png.readUInt32BE(16)).toBe(128);
				expect(png.readUInt32BE(20)).toBe(128);
			}
		}
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
