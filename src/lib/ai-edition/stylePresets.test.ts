import { describe, expect, it } from "vitest";
import {
	parseStylePresetAppearance,
	parseStylePresetFile,
	parseStylePresetWallpaper,
	STYLE_PRESET_DATA_URL_MAX_LENGTH,
	STYLE_PRESET_FORMAT,
	STYLE_PRESET_FORMAT_VERSION,
	type StylePresetAppearance,
	sanitizeStylePresetName,
	serializeStylePresetFile,
	stylePresetFileBaseName,
} from "./stylePresets";

function appearance(overrides: Partial<StylePresetAppearance> = {}): StylePresetAppearance {
	return {
		wallpaper: "/wallpapers/wallpaper3.jpg",
		wallpaperMotion: "drift",
		frame: "window",
		frameTheme: "dark",
		aspectRatio: "16:9",
		shadowIntensity: 0.2,
		showBlur: false,
		motionBlurAmount: 0.2,
		depthOfField: true,
		borderRadius: 40,
		padding: 50,
		webcamLayoutPreset: "picture-in-picture",
		webcamMaskShape: "circle",
		webcamMirrored: true,
		webcamReactiveZoom: true,
		webcamSizePreset: 25,
		webcamBackgroundMode: "blur",
		webcamWallpaper: "#112233",
		webcamBlurIntensity: 0.5,
		cursor: {
			size: 3,
			smoothing: 0.67,
			motionBlur: 0.35,
			clickBounce: 2.5,
			model3d: false,
			clipToBounds: false,
		},
		cursorShow: true,
		cursorAutoHide: false,
		cursorTheme: "default",
		...overrides,
	};
}

describe("parseStylePresetAppearance", () => {
	it("accepts a complete appearance and drops unknown keys", () => {
		const parsed = parseStylePresetAppearance({ ...appearance(), cropRegion: { x: 0 } });
		expect(parsed).toEqual(appearance());
		expect(parsed).not.toHaveProperty("cropRegion");
	});

	it("rejects a missing field instead of guessing a factory value", () => {
		const { padding: _padding, ...rest } = appearance();
		expect(() => parseStylePresetAppearance(rest)).toThrow(/padding/);
	});

	// Added after format version 1 shipped: an older preset has a still wallpaper.
	it("reads a preset without a wallpaper motion as still, and refuses an unknown one", () => {
		const { wallpaperMotion: _motion, ...older } = appearance();
		expect(parseStylePresetAppearance(older).wallpaperMotion).toBe("none");
		expect(() =>
			parseStylePresetAppearance({ ...appearance(), wallpaperMotion: "plasma" }),
		).toThrow(/wallpaperMotion/);
	});

	it("keeps depth of field on for a preset saved before the setting existed", () => {
		const { depthOfField: _dof, ...older } = appearance({ depthOfField: false });
		expect(parseStylePresetAppearance(older).depthOfField).toBe(true);
		expect(parseStylePresetAppearance(appearance({ depthOfField: false })).depthOfField).toBe(
			false,
		);
		expect(() => parseStylePresetAppearance({ ...appearance(), depthOfField: "on" })).toThrow(
			/depthOfField/,
		);
	});

	it("rejects out-of-range numbers, wrong types and unknown enum values", () => {
		expect(() => parseStylePresetAppearance(appearance({ padding: 101 }))).toThrow(TypeError);
		expect(() => parseStylePresetAppearance(appearance({ borderRadius: -1 }))).toThrow(
			/borderRadius/,
		);
		expect(() => parseStylePresetAppearance(appearance({ webcamSizePreset: 5 }))).toThrow(
			/webcamSizePreset/,
		);
		expect(() =>
			parseStylePresetAppearance({ ...appearance(), shadowIntensity: Number.NaN }),
		).toThrow(/shadowIntensity/);
		expect(() => parseStylePresetAppearance({ ...appearance(), showBlur: "yes" })).toThrow(
			/showBlur/,
		);
		expect(() => parseStylePresetAppearance({ ...appearance(), webcamMaskShape: "star" })).toThrow(
			/webcamMaskShape/,
		);
		expect(() => parseStylePresetAppearance({ ...appearance(), aspectRatio: "wide" })).toThrow(
			/aspectRatio/,
		);
		expect(() =>
			parseStylePresetAppearance({
				...appearance(),
				cursor: { ...appearance().cursor, size: 11 },
			}),
		).toThrow(/cursor\.size/);
	});

	it("drops the retired cursor.volume and cursor.hover keys of an older preset", () => {
		const older = {
			...appearance(),
			cursor: { ...appearance().cursor, volume: 0.6, hover: 0.4 },
		};
		expect(parseStylePresetAppearance(older).cursor).toEqual(appearance().cursor);
	});

	it("reads a preset written before the 3D cursor as a flat cursor, and type-checks it", () => {
		const { model3d: _model3d, ...flat } = appearance().cursor;
		expect(parseStylePresetAppearance({ ...appearance(), cursor: flat }).cursor.model3d).toBe(
			false,
		);
		expect(
			parseStylePresetAppearance({
				...appearance(),
				cursor: { ...appearance().cursor, model3d: true },
			}).cursor.model3d,
		).toBe(true);
		expect(() =>
			parseStylePresetAppearance({
				...appearance(),
				cursor: { ...appearance().cursor, model3d: 1 },
			}),
		).toThrow(/cursor\.model3d/);
	});

	it("reads a preset saved before the frame existed as frameless, and rejects an unknown frame", () => {
		const { frame: _frame, ...older } = appearance();
		expect(parseStylePresetAppearance(older).frame).toBe("none");
		expect(() => parseStylePresetAppearance({ ...appearance(), frame: "window-sepia" })).toThrow(
			/frame/,
		);
	});

	it("defaults a preset without frame fields to no frame in the light theme", () => {
		const { frame: _frame, frameTheme: _theme, ...older } = appearance();
		const parsed = parseStylePresetAppearance(older);
		expect(parsed.frame).toBe("none");
		expect(parsed.frameTheme).toBe("light");
	});

	it("splits the legacy window-light and window-dark values into a frame and a theme", () => {
		const { frameTheme: _theme, ...legacy } = appearance();
		for (const [stored, theme] of [
			["window-light", "light"],
			["window-dark", "dark"],
		] as const) {
			const parsed = parseStylePresetAppearance({ ...legacy, frame: stored });
			expect(parsed.frame).toBe("window");
			expect(parsed.frameTheme).toBe(theme);
		}
	});

	it("rejects an unknown frame theme", () => {
		expect(() => parseStylePresetAppearance({ ...appearance(), frameTheme: "sepia" })).toThrow(
			/frameTheme/,
		);
	});

	it("falls back to the default cursor theme for an id this build does not ship", () => {
		expect(
			parseStylePresetAppearance(appearance({ cursorTheme: "theme-from-the-future" })).cursorTheme,
		).toBe("default");
	});
});

describe("parseStylePresetWallpaper", () => {
	it.each([
		"#abc",
		"#aabbccdd",
		"rgb(10 20 30)",
		"oklch(70% 0.1 200)",
		"linear-gradient(90deg, #000 0%, #fff 100%)",
		"repeating-conic-gradient(red 0 10deg, blue 10deg 20deg)",
		"/wallpapers/wallpaper12.jpg",
		"data:image/png;base64,iVBORw0KGgo=",
		"data:image/jpeg;base64,/9j/4AAQ",
	])("accepts %s", (value) => {
		expect(parseStylePresetWallpaper(value)).toBe(value);
	});

	it("normalises a legacy bundled file:// wallpaper to its canonical path", () => {
		expect(
			parseStylePresetWallpaper(
				"file:///Applications/OpenScreen.app/Contents/Resources/wallpapers/wallpaper4.jpg",
			),
		).toBe("/wallpapers/wallpaper4.jpg");
	});

	it.each([
		"file:///Users/alice/Pictures/beach.jpg",
		"file:///C:/Users/alice/wallpapers/wallpaper1.jpg",
		"/Users/alice/beach.jpg",
		"C:\\Users\\alice\\beach.jpg",
		"https://example.com/bg.png",
		"http://example.com/bg.png",
		"red",
		"linear-gradient(url(file:///etc/passwd), #fff)",
		"url(x), linear-gradient(#000, #fff)",
		"data:image/svg+xml;base64,PHN2Zz4=",
		"data:image/png,notbase64",
	])("rejects %s", (value) => {
		expect(() => parseStylePresetWallpaper(value)).toThrow(TypeError);
	});

	it("rejects an oversized data URL with a clear message", () => {
		const big = `data:image/png;base64,${"A".repeat(STYLE_PRESET_DATA_URL_MAX_LENGTH)}`;
		expect(() => parseStylePresetWallpaper(big, "webcamWallpaper")).toThrow(
			/webcamWallpaper image is too large/,
		);
	});
});

describe("preset names", () => {
	it("trims, collapses whitespace and caps the length", () => {
		expect(sanitizeStylePresetName("  My   cool\n preset ")).toBe("My cool preset");
		expect(Array.from(sanitizeStylePresetName("é".repeat(200)))).toHaveLength(80);
	});

	it("throws on an empty name", () => {
		expect(() => sanitizeStylePresetName("   ")).toThrow(TypeError);
	});

	it("keeps Unicode but strips characters Windows refuses", () => {
		expect(stylePresetFileBaseName('Démo 日本 <a>:"b"/c\\d|e?f*')).toBe("Démo 日本 abcdef");
		expect(stylePresetFileBaseName("Trailing dots... ")).toBe("Trailing dots");
		expect(stylePresetFileBaseName("tab\there")).toBe("tab here");
	});

	it("never produces a Windows reserved device name", () => {
		expect(stylePresetFileBaseName("CON")).toBe("CON_");
		expect(stylePresetFileBaseName("nul")).toBe("nul_");
		expect(stylePresetFileBaseName("com1")).toBe("com1_");
		expect(stylePresetFileBaseName("LPT9.txt")).toBe("LPT9.txt_");
		expect(stylePresetFileBaseName("Console")).toBe("Console");
	});

	it("falls back to a placeholder when nothing survives stripping", () => {
		expect(stylePresetFileBaseName("???")).toBe("Preset");
	});
});

describe("preset file format", () => {
	it("round-trips through serialize and parse", () => {
		const text = serializeStylePresetFile({ name: " Studio ", appearance: appearance() });
		const parsed = parseStylePresetFile(JSON.parse(text));
		expect(parsed).toEqual({
			format: STYLE_PRESET_FORMAT,
			version: STYLE_PRESET_FORMAT_VERSION,
			name: "Studio",
			appearance: appearance(),
		});
	});

	it("rejects other formats and future versions", () => {
		expect(() => parseStylePresetFile({ name: "x", appearance: appearance() })).toThrow(
			/Not an OpenScreen style preset/,
		);
		expect(() =>
			parseStylePresetFile({
				format: STYLE_PRESET_FORMAT,
				version: 2,
				name: "x",
				appearance: appearance(),
			}),
		).toThrow(/version 2/);
	});
});
