// Renderer half of style presets: between the editor settings snapshot and a preset's
// appearance. The file format and its validation live in stylePresets.ts, which the main
// process shares.

import {
	DEFAULT_EDITOR_SETTINGS,
	type EditorSettingsPatch,
	type EditorSettingsSnapshot,
} from "@/lib/ai-edition/store/editorSettings";
import type { StylePresetAppearance } from "@/lib/ai-edition/stylePresets";

/** Copies the appearance fields out of a settings snapshot — nothing footage-dependent. */
export function stylePresetAppearanceFromSettings(
	settings: EditorSettingsSnapshot,
): StylePresetAppearance {
	return {
		wallpaper: settings.wallpaper,
		wallpaperMotion: settings.wallpaperMotion,
		frame: settings.frame,
		aspectRatio: settings.aspectRatio,
		shadowIntensity: settings.shadowIntensity,
		showBlur: settings.showBlur,
		motionBlurAmount: settings.motionBlurAmount,
		depthOfField: settings.depthOfField,
		borderRadius: settings.borderRadius,
		padding: settings.padding,
		webcamLayoutPreset: settings.webcamLayoutPreset,
		webcamMaskShape: settings.webcamMaskShape,
		webcamMirrored: settings.webcamMirrored,
		webcamReactiveZoom: settings.webcamReactiveZoom,
		webcamSizePreset: settings.webcamSizePreset,
		webcamBackgroundMode: settings.webcamBackgroundMode,
		webcamWallpaper: settings.webcamWallpaper,
		webcamBlurIntensity: settings.webcamBlurIntensity,
		cursor: {
			size: settings.cursor.size,
			smoothing: settings.cursor.smoothing,
			motionBlur: settings.cursor.motionBlur,
			clickBounce: settings.cursor.clickBounce,
			model3d: settings.cursor.model3d,
			clipToBounds: settings.cursor.clipToBounds,
		},
		cursorShow: settings.cursorShow,
		cursorAutoHide: settings.cursorAutoHide,
		cursorTheme: settings.cursorTheme,
	};
}

export function factoryStylePresetAppearance(): StylePresetAppearance {
	return stylePresetAppearanceFromSettings(DEFAULT_EDITOR_SETTINGS);
}

/**
 * The whole preset as ONE settings patch, so `useEditorSettings().set(patch)` applies it as
 * a single undo step.
 *
 * `EditorSettingsPatch` has no top-level `cursorTheme` or `cursorShow`: both travel inside
 * `cursor` as `theme` and `show`. Auto-hide is written both ways (`cursor.autoHide` and
 * `cursorAutoHide`) because `nextLegacy` accepts either and they land on the same key.
 */
export function stylePresetPatch(appearance: StylePresetAppearance): EditorSettingsPatch {
	return {
		wallpaper: appearance.wallpaper,
		wallpaperMotion: appearance.wallpaperMotion,
		frame: appearance.frame,
		aspectRatio: appearance.aspectRatio,
		shadowIntensity: appearance.shadowIntensity,
		showBlur: appearance.showBlur,
		motionBlurAmount: appearance.motionBlurAmount,
		depthOfField: appearance.depthOfField,
		borderRadius: appearance.borderRadius,
		padding: appearance.padding,
		webcamLayoutPreset: appearance.webcamLayoutPreset,
		webcamMaskShape: appearance.webcamMaskShape,
		webcamMirrored: appearance.webcamMirrored,
		webcamReactiveZoom: appearance.webcamReactiveZoom,
		webcamSizePreset: appearance.webcamSizePreset,
		webcamBackgroundMode: appearance.webcamBackgroundMode,
		webcamWallpaper: appearance.webcamWallpaper,
		webcamBlurIntensity: appearance.webcamBlurIntensity,
		cursor: {
			...appearance.cursor,
			theme: appearance.cursorTheme,
			show: appearance.cursorShow,
			autoHide: appearance.cursorAutoHide,
		},
		cursorAutoHide: appearance.cursorAutoHide,
	};
}
