import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_APPEARANCE } from "../projectDefaults";
import {
	CURSOR_KIND_IDS,
	CURSOR_KINDS,
	CURSOR_THEMES,
	type CursorTheme,
	DEFAULT_CURSOR_SPRITES,
	DEFAULT_CURSOR_THEME_ID,
	normalizeCursorThemeId,
	readCursorAsArrow,
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

	// The compositor models these two states itself (`crates/compositor/src/sculpt.rs`, which
	// knows the same names): in 3D the scene names the model, and the sprite stays the flat art.
	// Prism Glow is the exception: its drawing is extruded, like the default art.
	const sculptedThemes = CURSOR_THEMES.filter((theme) => theme.id !== "prism-glow");
	it.each(sculptedThemes)("names the sculpted 3D arrow and hand of $name", (theme) => {
		const flat = resolveCursorSprites(theme.id);
		const sprites = resolveCursorSprites(theme.id, [], true);
		for (const state of ["arrow", "pointer"] as const) {
			expect(theme.assets[state]?.sculpted).toBe(true);
			expect(sprites[state]).toEqual({ ...flat[state], sculpt: `${theme.id}/${state}` });
			expect(flat[state].sculpt).toBeUndefined();
		}
		expect(sprites.text).toBe(DEFAULT_CURSOR_SPRITES.text);
	});

	it.each([
		DEFAULT_CURSOR_THEME_ID,
		"prism-glow",
	])("leaves %s to the extruded sprite in 3D", (id) => {
		for (const sprite of Object.values(resolveCursorSprites(id, [], true))) {
			expect(sprite.sculpt).toBeUndefined();
		}
	});
});

describe("cursor kinds", () => {
	// "Arrow only" must leave nothing but the arrow: a state outside every kind would keep its
	// own sprite whatever the user picks.
	it("puts every cursor state but the arrow in exactly one kind", () => {
		const grouped = Object.values(CURSOR_KINDS).flat();
		expect(new Set(grouped).size).toBe(grouped.length);
		expect([...grouped, "arrow"].sort()).toEqual(Object.keys(DEFAULT_CURSOR_SPRITES).sort());
	});

	it("draws the kinds it is given with the theme's arrow, and every other state as itself", () => {
		const theme = CURSOR_THEMES[0];
		const flat = resolveCursorSprites(theme.id);
		const sprites = resolveCursorSprites(theme.id, ["pointer", "resize"]);
		for (const type of ["pointer", ...CURSOR_KINDS.resize] as const) {
			expect(sprites[type], type).toEqual(flat.arrow);
		}
		expect(sprites.text).toBe(DEFAULT_CURSOR_SPRITES.text);
		expect(sprites["open-hand"]).toBe(DEFAULT_CURSOR_SPRITES["open-hand"]);
	});

	it("gives a kind drawn as the arrow the arrow's 3D model", () => {
		const theme = CURSOR_THEMES[0];
		const sprites = resolveCursorSprites(theme.id, ["text"], true);
		expect(sprites.text.sculpt).toBe(`${theme.id}/arrow`);
	});
});

describe("readCursorAsArrow", () => {
	const fallback = ["busy"] as const;

	it("keeps the known kinds, once each, in the order of CURSOR_KINDS", () => {
		expect(
			readCursorAsArrow(["text", "sparkles", "pointer", "text", 7], undefined, fallback),
		).toEqual(["pointer", "text"]);
		expect(readCursorAsArrow([], undefined, fallback)).toEqual([]);
		expect(readCursorAsArrow("text", undefined, fallback)).toEqual(["busy"]);
	});

	// The single switch the kinds replaced: on meant every one of them. Off was its default, so it
	// says no more than an absent list does.
	it("reads the old always-arrow switch when there is no list", () => {
		expect(readCursorAsArrow(undefined, true, fallback)).toEqual(CURSOR_KIND_IDS);
		expect(readCursorAsArrow(undefined, false, fallback)).toEqual(["busy"]);
		expect(readCursorAsArrow(undefined, undefined, fallback)).toEqual(["busy"]);
		expect(readCursorAsArrow(["text"], true, fallback)).toEqual(["text"]);
	});

	// Out of the box a project shows the arrow and the hand, and nothing else: a kind added to
	// CURSOR_KINDS has to join the default too, or new projects would start drawing it.
	it("defaults to every kind but the hand", () => {
		expect(DEFAULT_PROJECT_APPEARANCE.cursor.asArrow).toEqual(
			CURSOR_KIND_IDS.filter((kind) => kind !== "pointer"),
		);
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
