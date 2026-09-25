import { DEFAULT_CURSOR_THEME_ID } from "@/lib/cursor/cursorThemes";
import type { ExportFormat, ExportQuality, GifFrameRate, GifSizePreset } from "@/lib/exporter";
import { DEFAULT_PROJECT_APPEARANCE } from "@/lib/projectDefaults";
import { DEFAULT_WALLPAPER } from "@/lib/wallpaper";
import type { AspectRatio } from "@/utils/aspectRatioUtils";
import {
	type CursorVisualSettings,
	DEFAULT_CROP_REGION,
	DEFAULT_CURSOR_AUTO_HIDE,
	DEFAULT_CURSOR_CLICK_BOUNCE,
	DEFAULT_CURSOR_MODEL3D,
	DEFAULT_CURSOR_MOTION_BLUR,
	DEFAULT_CURSOR_SIZE,
	DEFAULT_CURSOR_SMOOTHING,
	DEFAULT_WEBCAM_LAYOUT_PRESET,
	DEFAULT_WEBCAM_MASK_SHAPE,
	DEFAULT_WEBCAM_POSITION,
	DEFAULT_WEBCAM_SIZE_PRESET,
	type WebcamLayoutPreset,
	type WebcamMaskShape,
	type WebcamPosition,
	type WebcamSizePreset,
} from "./types";

export const DEFAULT_SOURCE_DIMENSIONS = {
	width: 1920,
	height: 1080,
} as const;

export const DEFAULT_GIF_OUTPUT_DIMENSIONS = {
	width: 1280,
	height: 720,
} as const;

export const DEFAULT_EDITOR_APPEARANCE_SETTINGS: {
	shadowIntensity: number;
	showBlur: boolean;
	motionBlurAmount: number;
	borderRadius: number;
} = {
	// The project defaults the v4 shell reads (`DEFAULT_PROJECT_APPEARANCE`), not a copy of them:
	// this is what the CLI and a v2 project file fall back to, and a copy kept "in sync" by hand
	// was one change away from rendering a different look there.
	shadowIntensity: DEFAULT_PROJECT_APPEARANCE.shadowIntensity,
	showBlur: DEFAULT_PROJECT_APPEARANCE.showBlur,
	motionBlurAmount: DEFAULT_PROJECT_APPEARANCE.motionBlurAmount,
	borderRadius: DEFAULT_PROJECT_APPEARANCE.borderRadius,
};

export const DEFAULT_EDITOR_LAYOUT_SETTINGS: {
	padding: number;
	aspectRatio: AspectRatio;
	cropRegion: typeof DEFAULT_CROP_REGION;
	wallpaper: string;
} = {
	padding: DEFAULT_PROJECT_APPEARANCE.padding,
	// What a v2 project file means when it states no ratio. Every such file predates Auto, so
	// the answer stays 16:9 for good, as the v8 upgrader pins it for documents. New projects
	// state their ratio instead (see CliRecordRunner).
	aspectRatio: "16:9",
	cropRegion: DEFAULT_CROP_REGION,
	wallpaper: DEFAULT_WALLPAPER,
};

export const DEFAULT_WEBCAM_SETTINGS = {
	layoutPreset: DEFAULT_WEBCAM_LAYOUT_PRESET,
	maskShape: DEFAULT_WEBCAM_MASK_SHAPE,
	sizePreset: DEFAULT_WEBCAM_SIZE_PRESET,
	position: DEFAULT_WEBCAM_POSITION,
} as const satisfies {
	layoutPreset: WebcamLayoutPreset;
	maskShape: WebcamMaskShape;
	sizePreset: WebcamSizePreset;
	position: WebcamPosition | null;
};

export const DEFAULT_CURSOR_SETTINGS: CursorVisualSettings & { show: boolean; theme: string } = {
	show: true,
	autoHide: DEFAULT_CURSOR_AUTO_HIDE,
	size: DEFAULT_CURSOR_SIZE,
	smoothing: DEFAULT_CURSOR_SMOOTHING,
	motionBlur: DEFAULT_CURSOR_MOTION_BLUR,
	clickBounce: DEFAULT_CURSOR_CLICK_BOUNCE,
	model3d: DEFAULT_CURSOR_MODEL3D,
	alwaysArrow: false,
	theme: DEFAULT_CURSOR_THEME_ID,
};

export const DEFAULT_EXPORT_SETTINGS: {
	quality: ExportQuality;
	format: ExportFormat;
} = {
	quality: "good",
	format: "mp4",
};

export const DEFAULT_GIF_SETTINGS: {
	frameRate: GifFrameRate;
	loop: boolean;
	sizePreset: GifSizePreset;
	outputDimensions: typeof DEFAULT_GIF_OUTPUT_DIMENSIONS;
} = {
	frameRate: 15,
	loop: true,
	sizePreset: "medium",
	outputDimensions: DEFAULT_GIF_OUTPUT_DIMENSIONS,
};
