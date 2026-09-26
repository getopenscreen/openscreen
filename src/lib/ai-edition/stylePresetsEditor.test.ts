import { describe, expect, it } from "vitest";
import { createEmptyDocument } from "./schema";
import {
	DEFAULT_EDITOR_SETTINGS,
	type EditorSettingsSnapshot,
	getEditorSettings,
	patchEditorSettings,
} from "./store/editorSettings";
import {
	LOOK_LEGACY_EDITOR_KEYS,
	lookFromLegacyEditor,
	parseStylePresetAppearance,
	stylePresetLegacyEditor,
} from "./stylePresets";
import {
	factoryStylePresetAppearance,
	sameStylePresetLook,
	stylePresetAppearanceFromSettings,
	stylePresetPatch,
} from "./stylePresetsEditor";

const EXCLUDED_KEYS = [
	"cropRegion",
	"webcamCropRegion",
	"webcamCropPan",
	"webcamAnchor",
	"audioGainDb",
	"autoFocusAll",
] as const;

function styledSettings(): EditorSettingsSnapshot {
	return {
		...DEFAULT_EDITOR_SETTINGS,
		wallpaper: "linear-gradient(90deg, #000, #fff)",
		wallpaperMotion: "waves",
		frame: "window",
		frameTheme: "light",
		aspectRatio: "9:16",
		shadowIntensity: 0.8,
		showBlur: true,
		motionBlurAmount: 0.6,
		borderRadius: 12,
		padding: 20,
		webcamLayoutPreset: "dual-frame",
		webcamMaskShape: "square",
		webcamRoundness: 0.45,
		webcamMirrored: true,
		webcamReactiveZoom: false,
		webcamSizePreset: 30,
		webcamBackgroundMode: "custom",
		webcamWallpaper: "#123456",
		webcamBlurIntensity: 0.9,
		cursor: {
			size: 2.5,
			smoothing: 0.1,
			motionBlur: 0.9,
			clickBounce: 1.5,
			model3d: true,
			alwaysArrow: false,
		},
		cursorShow: false,
		cursorAutoHide: true,
		cursorTheme: "default",
	};
}

describe("stylePresetsEditor", () => {
	it("derives a valid factory appearance from the default settings", () => {
		const factory = factoryStylePresetAppearance();
		expect(parseStylePresetAppearance(factory)).toEqual(factory);
		expect(factory.padding).toBe(DEFAULT_EDITOR_SETTINGS.padding);
		expect(factory).not.toHaveProperty("cropRegion");
	});

	it("copies the cursor rather than sharing it", () => {
		const settings = styledSettings();
		const appearance = stylePresetAppearanceFromSettings(settings);
		appearance.cursor.size = 3;
		expect(settings.cursor.size).toBe(2.5);
		expect(appearance.cursor).not.toHaveProperty("autoHide");
	});

	it("round-trips settings -> appearance -> patch without touching excluded fields", () => {
		const styled = styledSettings();
		const appearance = stylePresetAppearanceFromSettings(styled);

		// A project with its own footage-dependent state, still on the factory look.
		const base = patchEditorSettings(createEmptyDocument({ projectId: "proj_a", title: "A" }), {
			cropRegion: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
			webcamAnchor: "bottom-left",
			audioGainDb: 6,
			autoFocusAll: true,
		});
		const before = getEditorSettings(base);

		const after = getEditorSettings(patchEditorSettings(base, stylePresetPatch(appearance)));

		// Everything but the format: the preset is 9:16, the project keeps its own.
		expect(stylePresetAppearanceFromSettings(after)).toEqual({
			...appearance,
			aspectRatio: before.aspectRatio,
		});
		expect(after.aspectRatio).toBe(DEFAULT_EDITOR_SETTINGS.aspectRatio);
		for (const key of EXCLUDED_KEYS) {
			expect(after[key]).toEqual(before[key]);
		}
	});

	it("never changes the project's format", () => {
		const vertical = patchEditorSettings(createEmptyDocument({ projectId: "p", title: "V" }), {
			aspectRatio: "9:16",
		});
		const patch = stylePresetPatch({ ...factoryStylePresetAppearance(), aspectRatio: "16:9" });
		expect(patch).not.toHaveProperty("aspectRatio");
		expect(getEditorSettings(patchEditorSettings(vertical, patch)).aspectRatio).toBe("9:16");
	});

	it("marks a preset active whatever the project's format", () => {
		const look = stylePresetAppearanceFromSettings(styledSettings());
		expect(sameStylePresetLook(look, { ...look, aspectRatio: "1:1" })).toBe(true);
		expect(sameStylePresetLook(look, { ...look, padding: look.padding + 1 })).toBe(false);
		// Key order is irrelevant: a preset read from disk carries its keys in file order.
		const reordered = Object.fromEntries(Object.entries(look).reverse()) as typeof look;
		expect(sameStylePresetLook(look, reordered)).toBe(true);
	});
});

describe("new-project look (main-process side)", () => {
	const docWith = (legacyEditor: Record<string, unknown>) => ({
		...createEmptyDocument({ projectId: "p", title: "N" }),
		legacyEditor,
	});

	it("writes a preset's look under the keys the editor reads, without the format", () => {
		const appearance = stylePresetAppearanceFromSettings(styledSettings());
		const legacy = stylePresetLegacyEditor(appearance);
		expect(Object.keys(legacy).sort()).toEqual([...LOOK_LEGACY_EDITOR_KEYS].sort());
		const read = getEditorSettings(docWith(legacy));
		expect(stylePresetAppearanceFromSettings(read)).toEqual({
			...appearance,
			aspectRatio: DEFAULT_EDITOR_SETTINGS.aspectRatio,
		});
	});

	it("takes another project's look and leaves its footage and format behind", () => {
		const styled = stylePresetAppearanceFromSettings(styledSettings());
		const source = patchEditorSettings(createEmptyDocument({ projectId: "a", title: "A" }), {
			...stylePresetPatch(styled),
			aspectRatio: "9:16",
			cropRegion: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
			webcamAnchor: "bottom-left",
			audioGainDb: 6,
			autoFocusAll: true,
		});
		const read = getEditorSettings(docWith(lookFromLegacyEditor(source.legacyEditor)));
		expect(stylePresetAppearanceFromSettings(read)).toEqual({
			...styled,
			aspectRatio: DEFAULT_EDITOR_SETTINGS.aspectRatio,
		});
		for (const key of EXCLUDED_KEYS) {
			expect(read[key]).toEqual(DEFAULT_EDITOR_SETTINGS[key]);
		}
		expect(lookFromLegacyEditor(null)).toEqual({});
	});
});
