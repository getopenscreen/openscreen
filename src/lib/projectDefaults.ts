/**
 * The frame drawn around the recording, a project setting like the wallpaper. "none" draws
 * nothing and renders exactly as before the setting existed.
 */
export type RecordingFrame = "none" | "window-light" | "window-dark";

export const RECORDING_FRAMES = [
	"none",
	"window-light",
	"window-dark",
] as const satisfies readonly RecordingFrame[];

export function isRecordingFrame(value: unknown): value is RecordingFrame {
	return typeof value === "string" && (RECORDING_FRAMES as readonly string[]).includes(value);
}

export interface ProjectAppearanceDefaults {
	wallpaper: string;
	wallpaperMotion: "none" | "drift" | "aurora" | "waves";
	frame: RecordingFrame;
	aspectRatio: `${number}:${number}` | "native";
	shadowIntensity: number;
	showBlur: boolean;
	motionBlurAmount: number;
	/** Defocus a 3D-tilted screen by its depth; inert on flat zooms. */
	depthOfField: boolean;
	borderRadius: number;
	padding: number;
	webcamLayoutPreset: "picture-in-picture" | "vertical-stack" | "dual-frame" | "no-webcam";
	webcamMaskShape: "rectangle" | "circle" | "square" | "rounded";
	webcamMirrored: boolean;
	webcamReactiveZoom: boolean;
	webcamSizePreset: number;
	webcamPosition: { cx: number; cy: number } | null;
	webcamBackgroundMode: "none" | "transparent" | "blur" | "custom";
	webcamWallpaper: string;
	webcamBlurIntensity: number;
	cursor: {
		size: number;
		smoothing: number;
		motionBlur: number;
		clickBounce: number;
		model3d: boolean;
		clipToBounds: boolean;
		autoHide: boolean;
	};
	cursorShow: boolean;
	cursorAutoHide: boolean;
	cursorTheme: string;
	autoFocusAll: boolean;
}

/** The factory appearance every new project starts from. */
export const DEFAULT_PROJECT_APPEARANCE: ProjectAppearanceDefaults = {
	wallpaper: "/wallpapers/wallpaper1.jpg",
	wallpaperMotion: "none",
	frame: "none",
	aspectRatio: "16:9",
	shadowIntensity: 0.2,
	showBlur: false,
	motionBlurAmount: 0.2,
	// On: it only acts on tilted zooms, where the blur already scales with the real angle.
	depthOfField: true,
	borderRadius: 40,
	padding: 50,
	webcamLayoutPreset: "picture-in-picture",
	webcamMaskShape: "rectangle",
	webcamMirrored: false,
	webcamReactiveZoom: true,
	webcamSizePreset: 25,
	webcamPosition: null,
	webcamBackgroundMode: "none",
	webcamWallpaper: "/wallpapers/wallpaper1.jpg",
	webcamBlurIntensity: 0.5,
	cursor: {
		size: 3,
		smoothing: 0.67,
		motionBlur: 0.35,
		clickBounce: 2.5,
		model3d: false,
		clipToBounds: false,
		autoHide: false,
	},
	cursorShow: true,
	cursorAutoHide: false,
	cursorTheme: "default",
	autoFocusAll: false,
};
