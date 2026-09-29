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
		frameTheme: settings.frameTheme,
		aspectRatio: settings.aspectRatio,
		shadowIntensity: settings.shadowIntensity,
		backgroundBlur: settings.backgroundBlur,
		motionBlurAmount: settings.motionBlurAmount,
		depthOfField: settings.depthOfField,
		borderRadius: settings.borderRadius,
		padding: settings.padding,
		webcamLayoutPreset: settings.webcamLayoutPreset,
		webcamMaskShape: settings.webcamMaskShape,
		webcamRoundness: settings.webcamRoundness,
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
			asArrow: [...settings.cursor.asArrow],
			clickImpact: settings.cursor.clickImpact,
		},
		cursorShow: settings.cursorShow,
		cursorAutoHide: settings.cursorAutoHide,
		cursorTheme: settings.cursorTheme,
	};
}

/** Whether two appearances look the same. The output format is part of the look: left out of
 *  this, two presets saved at different formats match at once and switching between them
 *  applies an identical patch — nothing moves, and two rows read as active. */
export function sameStylePresetLook(a: StylePresetAppearance, b: StylePresetAppearance): boolean {
	return sameValue(a, b);
}

/** Structural equality over plain JSON-shaped values. A preset read from disk carries its
 *  keys in file order, so a key-order-sensitive comparison would never light a row. */
function sameValue(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	const aKeys = Object.keys(a);
	const bKeys = Object.keys(b);
	if (aKeys.length !== bKeys.length) return false;
	return aKeys.every((key) =>
		sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
	);
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
 *
 * `aspectRatio` travels with the look: a preset saved at 16:9 restores 16:9, and a look is
 * only ever active at the one format it was saved at. `aspectRatio` stays out of what a NEW
 * project takes from a preset (`stylePresetLegacyEditor`) — the format belongs to the take.
 */
export function stylePresetPatch(appearance: StylePresetAppearance): EditorSettingsPatch {
	return {
		wallpaper: appearance.wallpaper,
		wallpaperMotion: appearance.wallpaperMotion,
		frame: appearance.frame,
		frameTheme: appearance.frameTheme,
		aspectRatio: appearance.aspectRatio,
		shadowIntensity: appearance.shadowIntensity,
		backgroundBlur: appearance.backgroundBlur,
		motionBlurAmount: appearance.motionBlurAmount,
		depthOfField: appearance.depthOfField,
		borderRadius: appearance.borderRadius,
		padding: appearance.padding,
		webcamLayoutPreset: appearance.webcamLayoutPreset,
		webcamMaskShape: appearance.webcamMaskShape,
		webcamRoundness: appearance.webcamRoundness,
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
