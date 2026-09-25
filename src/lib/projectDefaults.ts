/**
 * The frame drawn around the recording, a project setting like the wallpaper. "none" draws
 * nothing and renders exactly as before the setting existed.
 *
 * Two families, and the difference is not cosmetic: the window chrome is drawn FLAT in the
 * screen's own plane (shader mode 14), while the three devices are modelled in real 3D around it
 * (mode 17) — a body with thickness, a micro-chamfer and a bezel, ray-marched in the same camera
 * as the footage. Which is why the camera can move around them.
 *
 * `monitor` is labelled "Screen" in the pane: the wire value names the object, the label names
 * what a user calls it.
 */
export type RecordingFrame = "none" | "window" | "laptop" | "phone" | "monitor";

export const RECORDING_FRAMES = [
	"none",
	"window",
	"laptop",
	"phone",
	"monitor",
] as const satisfies readonly RecordingFrame[];

/**
 * The devices modelled in 3D, in menu order. They are the values that shader mode 17 draws;
 * `window` is flat.
 */
export const DEVICE_FRAMES = [
	"laptop",
	"phone",
	"monitor",
] as const satisfies readonly RecordingFrame[];

export function isRecordingFrame(value: unknown): value is RecordingFrame {
	return typeof value === "string" && (RECORDING_FRAMES as readonly string[]).includes(value);
}

/**
 * Light or dark, for EVERY frame: the window chrome and the three modelled devices alike. Light
 * is a silver body with light chrome, dark a graphite body with dark chrome.
 */
export type FrameTheme = "light" | "dark";

export const FRAME_THEMES = ["light", "dark"] as const satisfies readonly FrameTheme[];

export function isFrameTheme(value: unknown): value is FrameTheme {
	return value === "light" || value === "dark";
}

/**
 * Reads a stored `frame` value, including the two the theme used to be baked into.
 *
 * `window-light` / `window-dark` were one setting doing two jobs. They are split here rather
 * than by a document migration pass, so a project written by an older build opens with the same
 * frame AND the same theme without being rewritten — and a project that a newer build wrote
 * still opens, frameless, instead of failing.
 *
 * Returns `null` for a value this build does not know, which the caller reads as "no frame".
 */
export function readRecordingFrame(
	value: unknown,
): { frame: RecordingFrame; theme?: FrameTheme } | null {
	if (value === "window-light") return { frame: "window", theme: "light" };
	if (value === "window-dark") return { frame: "window", theme: "dark" };
	return isRecordingFrame(value) ? { frame: value } : null;
}

export interface ProjectAppearanceDefaults {
	wallpaper: string;
	wallpaperMotion: "none" | "drift" | "aurora" | "waves";
	frame: RecordingFrame;
	/** Light or dark, for whichever frame is on. Inert with `frame: "none"`. */
	frameTheme: FrameTheme;
	aspectRatio: `${number}:${number}` | "auto" | "native";
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
	frameTheme: "light",
	// Auto: the frame follows the recording, its crop, the camera layout and the padding.
	// Documents from before it stored no ratio and read 16:9; the v8 upgrader pins that.
	aspectRatio: "auto",
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
