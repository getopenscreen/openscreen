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

/**
 * Where the picture-in-picture camera sits: a corner or the middle of an edge, always the
 * same distance from the border of the frame. Never a free position: a camera dropped
 * anywhere else ended up against an edge or over the middle of the screen.
 */
export const WEBCAM_ANCHORS = [
	"top-left",
	"top",
	"top-right",
	"left",
	"right",
	"bottom-left",
	"bottom",
	"bottom-right",
] as const;

export type WebcamAnchor = (typeof WEBCAM_ANCHORS)[number];

export function isWebcamAnchor(value: unknown): value is WebcamAnchor {
	return (WEBCAM_ANCHORS as readonly unknown[]).includes(value);
}

/** The anchor grid, row by row. The middle cell is no place for a camera. */
export const WEBCAM_ANCHOR_GRID = [
	["top-left", "top", "top-right"],
	["left", null, "right"],
	["bottom-left", "bottom", "bottom-right"],
] as const satisfies readonly (readonly (WebcamAnchor | null)[])[];

/**
 * The anchor nearest a point of the frame, in fractions of it: the cell of a 3x3 grid, and
 * from the middle cell the nearer edge. What the camera snaps to when it is dragged, and what
 * a free position stored by an older build reads as.
 */
export function webcamAnchorAt(cx: number, cy: number): WebcamAnchor {
	const cell = (v: number) => (v < 1 / 3 ? 0 : v > 2 / 3 ? 2 : 1);
	let col = cell(cx);
	let row = cell(cy);
	if (col === 1 && row === 1) {
		if (Math.abs(cy - 0.5) >= Math.abs(cx - 0.5)) row = cy < 0.5 ? 0 : 2;
		else col = cx < 0.5 ? 0 : 2;
	}
	return WEBCAM_ANCHOR_GRID[row][col] ?? "bottom-right";
}

/** An anchor as the share of the free room the camera leaves it, per axis: 0, 0.5 or 1. */
export function webcamAnchorFractions(anchor: WebcamAnchor): [number, number] {
	const fx = anchor.endsWith("left") ? 0 : anchor.endsWith("right") ? 1 : 0.5;
	const fy = anchor.startsWith("top") ? 0 : anchor.startsWith("bottom") ? 1 : 0.5;
	return [fx, fy];
}

/** Reads a stored anchor, falling back to the free `{ cx, cy }` position older builds stored. */
export function readWebcamAnchor(anchor: unknown, legacyPosition: unknown): WebcamAnchor {
	if (isWebcamAnchor(anchor)) return anchor;
	const p = legacyPosition as { cx?: unknown; cy?: unknown } | null | undefined;
	if (p && typeof p.cx === "number" && typeof p.cy === "number") {
		return webcamAnchorAt(p.cx, p.cy);
	}
	return "bottom-right";
}

/** The camera's proportions. Its roundness is a setting of its own, `webcamRoundness`. */
export type WebcamMask = "rectangle" | "square";

/**
 * The camera's corner rounding, 0 square to 1 fully round, as a fraction of half the camera's
 * short side. A fraction, so the same value draws the same shape at any size and resolution;
 * at 1 a square camera is a circle.
 */
export const DEFAULT_WEBCAM_ROUNDNESS = 0.3;

/**
 * The picture-in-picture camera's size, in percent of the frame's short side. Past 35 it
 * covers the screen it is there to accompany; older builds allowed 50, read back as 35.
 */
export const WEBCAM_SIZE_MIN = 10;
export const WEBCAM_SIZE_MAX = 35;

/**
 * Reads a stored camera shape and roundness. `circle` and `rounded` were a proportion and a
 * rounding folded into one value; they split here into the two settings, the way
 * `readRecordingFrame` splits the old window themes. A stored roundness wins.
 */
export function readWebcamMask(
	shape: unknown,
	roundness: unknown,
): { shape: WebcamMask; roundness: number } {
	const fromShape = shape === "circle" ? 1 : shape === "rounded" ? 0.6 : DEFAULT_WEBCAM_ROUNDNESS;
	return {
		shape: shape === "square" || shape === "circle" ? "square" : "rectangle",
		roundness:
			typeof roundness === "number" && Number.isFinite(roundness)
				? Math.min(1, Math.max(0, roundness))
				: fromShape,
	};
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
	/** The camera's proportions: its own ("rectangle") or cropped square. See `readWebcamMask`. */
	webcamMaskShape: WebcamMask;
	/** 0 square corners to 1 fully round. See `DEFAULT_WEBCAM_ROUNDNESS`. */
	webcamRoundness: number;
	webcamMirrored: boolean;
	webcamReactiveZoom: boolean;
	webcamSizePreset: number;
	webcamAnchor: WebcamAnchor;
	webcamBackgroundMode: "none" | "transparent" | "blur" | "custom";
	webcamWallpaper: string;
	webcamBlurIntensity: number;
	cursor: {
		size: number;
		smoothing: number;
		motionBlur: number;
		clickBounce: number;
		model3d: boolean;
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
	webcamRoundness: DEFAULT_WEBCAM_ROUNDNESS,
	webcamMirrored: false,
	webcamReactiveZoom: true,
	webcamSizePreset: 25,
	webcamAnchor: "bottom-right",
	webcamBackgroundMode: "none",
	webcamWallpaper: "/wallpapers/wallpaper1.jpg",
	webcamBlurIntensity: 0.5,
	cursor: {
		size: 3,
		smoothing: 0.67,
		motionBlur: 0.35,
		clickBounce: 2.5,
		model3d: false,
		autoHide: false,
	},
	cursorShow: true,
	cursorAutoHide: false,
	cursorTheme: "default",
	autoFocusAll: false,
};
