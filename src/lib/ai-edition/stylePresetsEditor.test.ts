import { describe, expect, it } from "vitest";
import { createEmptyDocument } from "./schema";
import {
	DEFAULT_EDITOR_SETTINGS,
	type EditorSettingsSnapshot,
	getEditorSettings,
	patchEditorSettings,
} from "./store/editorSettings";
import { parseStylePresetAppearance } from "./stylePresets";
import {
	factoryStylePresetAppearance,
	stylePresetAppearanceFromSettings,
	stylePresetPatch,
} from "./stylePresetsEditor";

const EXCLUDED_KEYS = [
	"cropRegion",
	"webcamCropRegion",
	"webcamCropPan",
	"webcamPosition",
	"audioGainDb",
	"autoFocusAll",
] as const;

function styledSettings(): EditorSettingsSnapshot {
	return {
		...DEFAULT_EDITOR_SETTINGS,
		wallpaper: "linear-gradient(90deg, #000, #fff)",
		wallpaperMotion: "waves",
		aspectRatio: "9:16",
		shadowIntensity: 0.8,
		showBlur: true,
		motionBlurAmount: 0.6,
		borderRadius: 12,
		padding: 20,
		webcamLayoutPreset: "dual-frame",
		webcamMaskShape: "rounded",
		webcamMirrored: true,
		webcamReactiveZoom: false,
		webcamSizePreset: 40,
		webcamBackgroundMode: "custom",
		webcamWallpaper: "#123456",
		webcamBlurIntensity: 0.9,
		cursor: {
			size: 5,
			smoothing: 0.1,
			motionBlur: 0.9,
			clickBounce: 4,
			volume: 0.6,
			clipToBounds: true,
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
		appearance.cursor.size = 9;
		expect(settings.cursor.size).toBe(5);
		expect(appearance.cursor).not.toHaveProperty("autoHide");
	});

	it("round-trips settings -> appearance -> patch without touching excluded fields", () => {
		const styled = styledSettings();
		const appearance = stylePresetAppearanceFromSettings(styled);

		// A project with its own footage-dependent state, still on the factory look.
		const base = patchEditorSettings(createEmptyDocument({ projectId: "proj_a", title: "A" }), {
			cropRegion: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
			webcamPosition: { cx: 0.2, cy: 0.8 },
			audioGainDb: 6,
			autoFocusAll: true,
		});
		const before = getEditorSettings(base);

		const after = getEditorSettings(patchEditorSettings(base, stylePresetPatch(appearance)));

		expect(stylePresetAppearanceFromSettings(after)).toEqual(appearance);
		for (const key of EXCLUDED_KEYS) {
			expect(after[key]).toEqual(before[key]);
		}
	});
});
