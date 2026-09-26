// Typed read/write layer over `document.legacyEditor`.
//
// The v3 schema keeps `legacyEditor` as a `Record<string, unknown>` envelope so
// v2 projects round-trip without losing fields. The right panes and the
// per-region inspectors need a typed surface — this module provides it.
//
// The shape mirrors the legacy editor's `ProjectEditorState` so the same names
// are used everywhere; values that v3 owns directly (zoomRanges, annotations,
// transcripts, clips) stay in their dedicated fields.

import {
	type CropRegion,
	type CursorVisualSettings,
	DEFAULT_CROP_REGION,
	isWallpaperMotion,
	isWebcamBackgroundMode,
	type WallpaperMotion,
	type WebcamBackgroundMode,
	type WebcamLayoutPreset,
	type WebcamMaskShape,
	type WebcamPosition,
	type WebcamSizePreset,
} from "@/components/video-editor/types";
import { normalizeCursorThemeId } from "@/lib/cursor/cursorThemes";
import {
	DEFAULT_PROJECT_APPEARANCE,
	type FrameTheme,
	isFrameTheme,
	type RecordingFrame,
	readBounded,
	readRecordingFrame,
	readWebcamAnchor,
	readWebcamMask,
	type WebcamAnchor,
	type WebcamMask,
} from "@/lib/projectDefaults";
import type { AspectRatio } from "@/utils/aspectRatioUtils";
import type { AxcutDocument } from "../schema";

// ponytail: avoid dragging in lib/exporter full surface here — we only
// need the type names. Wallpaper + cursor theme are stored as plain strings
// for the same reason (their canonical types live in lib/wallpaper and
// lib/cursor/cursorThemes as the source of truth).

/** Output gain bound, shared by the slider, this store and `finish_audio` (Rust).
 *
 *  A linear gain is the one audio setting that behaves identically on the preview's source
 *  file and on the export's assembled timeline, which is why it is the only one left. A sync
 *  offset was tried and removed: the preview seeks in SOURCE time while the export shifts the
 *  stretched, concatenated timeline, so the same value meant different delays under a speed
 *  region, and near a cut the export pulls audio across the junction while the preview cannot. */
export const AUDIO_GAIN_DB_LIMIT = 12;
export const AUDIO_TRACK_GAIN_DB_MIN = -60;
export const AUDIO_TRACK_GAIN_DB_MAX = 12;

/** dB to the linear scalar every side of the boundary multiplies by.
 *
 *  Exported rather than written out three times. `finish_audio` applies
 *  `10f32.powf(gain_db / 20.0)` per sample; the preview feeds this to a `GainNode`; the
 *  timeline waveform scales its bars by it. The claim those three make together — that what
 *  you see is what you hear is what you export — only holds while they are the same number,
 *  and a hand-copied `10 ** (dB / 20)` is exactly how that stops being true. */
export function audioGainScalar(gainDb: number): number {
	return 10 ** (gainDb / 20);
}

/**
 * Where the webcam crop window sits inside the room its zoom leaves, 0..1 per axis:
 * 0 hard against one edge, 1 against the other, 0.5 centred.
 *
 * Stored because the rect cannot hold it. At 100% zoom the crop IS the frame, so `x` and `y`
 * are necessarily 0 and the pan they used to be read back from is gone — which meant a trip
 * down to 100% and back erased the framing the user had set. Expressed as a fraction of the
 * available room, the pan survives every zoom, including the one where it does not apply.
 *
 * This never leaves the app. `webcamCropRegion` remains the only thing the scene carries to
 * the compositor, so the preview and the export see exactly what they saw before.
 */
export interface CropPan {
	x: number;
	y: number;
}

/** Centred: the crop window sits in the middle of whatever room the zoom leaves. */
const DEFAULT_CROP_PAN: CropPan = { x: 0.5, y: 0.5 };

export interface EditorSettingsSnapshot {
	wallpaper: string;
	/** Only a gradient wallpaper moves; kept as chosen when the wallpaper changes kind. */
	wallpaperMotion: WallpaperMotion;
	/** The frame drawn around the recording (window chrome or a modelled device), or "none". */
	frame: RecordingFrame;
	/** Light or dark, for whichever frame is on. Inert with `frame: "none"`. */
	frameTheme: FrameTheme;
	aspectRatio: AspectRatio;
	/**
	 * Under a fixed format that is not the recording's shape: fill the frame with a window of
	 * the recording that follows the smoothed cursor (true), or show it whole (false). `null`
	 * until the user picks a format or this option: projects from before it keep showing the
	 * recording whole. See `formatFillAvailability`.
	 */
	formatFollowCursor: boolean | null;
	shadowIntensity: number;
	showBlur: boolean;
	motionBlurAmount: number;
	depthOfField: boolean;
	borderRadius: number;
	padding: number;
	cropRegion: CropRegion;
	webcamLayoutPreset: WebcamLayoutPreset;
	/** The camera's proportions. `circle` and `rounded` are read as a roundness: see `readWebcamMask`. */
	webcamMaskShape: WebcamMask;
	/** 0 square corners to 1 fully round, a fraction of half the camera's short side. */
	webcamRoundness: number;
	webcamMirrored: boolean;
	webcamReactiveZoom: boolean;
	webcamSizePreset: WebcamSizePreset;
	/** Where the picture-in-picture camera sits, at a constant distance from the border. */
	webcamAnchor: WebcamAnchor;
	webcamCropRegion: CropRegion;
	/** Where the crop window sits in the room the zoom leaves it, 0..1 per axis.
	 *  Authoritative: `webcamCropRegion.x/y` are rebuilt from it on read. */
	webcamCropPan: CropPan;
	audioGainDb: number;
	webcamBackgroundMode: WebcamBackgroundMode;
	webcamWallpaper: string;
	webcamBlurIntensity: number;
	cursor: CursorVisualSettings;
	cursorShow: boolean;
	cursorAutoHide: boolean;
	cursorTheme: string;
	autoFocusAll: boolean;
}

export const DEFAULT_EDITOR_SETTINGS: EditorSettingsSnapshot = {
	// Opinionated by default: the wallpaper and the padding were already on, but
	// with square corners and no shadow the recording read as a rectangle pasted
	// onto the background rather than a window floating above it (#271 reported
	// the symptom and blamed the padding). These three are the rest of that look;
	// shipping the background without them was shipping half a composition.
	...DEFAULT_PROJECT_APPEARANCE,
	cropRegion: DEFAULT_CROP_REGION,
	webcamCropRegion: DEFAULT_CROP_REGION,
	webcamCropPan: DEFAULT_CROP_PAN,
	audioGainDb: 0,
	formatFollowCursor: null,
};

interface LegacyShape {
	wallpaper?: string;
	wallpaperMotion?: WallpaperMotion;
	/** `unknown`: it may still hold `window-light` / `window-dark` (`readRecordingFrame`). */
	frame?: unknown;
	frameTheme?: FrameTheme;
	aspectRatio?: AspectRatio;
	formatFollowCursor?: boolean;
	shadowIntensity?: number;
	showBlur?: boolean;
	motionBlurAmount?: number;
	depthOfField?: boolean;
	borderRadius?: number;
	padding?: number;
	cropRegion?: CropRegion;
	webcamLayoutPreset?: WebcamLayoutPreset;
	webcamMaskShape?: WebcamMaskShape;
	webcamRoundness?: number;
	webcamMirrored?: boolean;
	webcamReactiveZoom?: boolean;
	webcamSizePreset?: WebcamSizePreset;
	webcamAnchor?: WebcamAnchor;
	/** Written by builds that let the camera be dragged anywhere; read as the nearest anchor. */
	webcamPosition?: WebcamPosition | null;
	webcamCropRegion?: CropRegion;
	webcamCropPan?: CropPan;
	audioGainDb?: number;
	webcamBackgroundMode?: WebcamBackgroundMode;
	webcamWallpaper?: string;
	webcamBlurIntensity?: number;
	cursorSize?: number;
	cursorSmoothing?: number;
	cursorMotionBlur?: number;
	cursorClickBounce?: number;
	cursorModel3d?: boolean;
	cursorAlwaysArrow?: boolean;
	cursorShow?: boolean;
	cursorAutoHide?: boolean;
	cursorTheme?: string;
	autoFocusAll?: boolean;
}
function isShape(value: unknown): value is LegacyShape {
	return typeof value === "object" && value !== null;
}

function isNumber(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v);
}
function isBoolean(v: unknown): v is boolean {
	return typeof v === "boolean";
}
function isString(v: unknown): v is string {
	return typeof v === "string";
}

export function getEditorSettings(doc: AxcutDocument | null | undefined): EditorSettingsSnapshot {
	const legacy = isShape(doc?.legacyEditor) ? (doc.legacyEditor as LegacyShape) : null;
	const num = (v: unknown, fallback: number) => (isNumber(v) ? v : fallback);
	const bool = (v: unknown, fallback: boolean) => (isBoolean(v) ? v : fallback);
	const str = (v: unknown, fallback: string) => (isString(v) ? v : fallback);
	// `window-light` / `window-dark` were the frame AND its theme; they split here.
	const stored = readRecordingFrame(legacy?.frame);

	const defaults = DEFAULT_EDITOR_SETTINGS;
	const cursor: CursorVisualSettings = {
		size: readBounded(legacy?.cursorSize, "cursorSize", defaults.cursor.size),
		smoothing: readBounded(legacy?.cursorSmoothing, "cursorSmoothing", defaults.cursor.smoothing),
		motionBlur: readBounded(
			legacy?.cursorMotionBlur,
			"cursorMotionBlur",
			defaults.cursor.motionBlur,
		),
		clickBounce: readBounded(
			legacy?.cursorClickBounce,
			"cursorClickBounce",
			defaults.cursor.clickBounce,
		),
		// Absent in every project saved before the setting existed: those keep the flat cursor.
		model3d: bool(legacy?.cursorModel3d, DEFAULT_EDITOR_SETTINGS.cursor.model3d),
		alwaysArrow: bool(legacy?.cursorAlwaysArrow, DEFAULT_EDITOR_SETTINGS.cursor.alwaysArrow),
		autoHide: bool(legacy?.cursorAutoHide, DEFAULT_EDITOR_SETTINGS.cursorAutoHide),
	};

	// The pan is authoritative and the rect's offset is rebuilt from it, so the two cannot
	// drift apart — on disk, or in a patch that wrote one and not the other. Only the SIZE
	// survives from the stored rect; `pan * (1 - size)` is a position that cannot leave the
	// frame, which is why nothing here clamps it.
	// `circle` and `rounded` were a proportion and a rounding in one value; they split here.
	const webcamMask = readWebcamMask(legacy?.webcamMaskShape, legacy?.webcamRoundness);

	const storedCrop = normaliseCropRegion(legacy?.webcamCropRegion);
	const webcamCropPan = normaliseCropPan(legacy?.webcamCropPan, storedCrop);
	const webcamCrop: CropRegion = {
		...storedCrop,
		x: webcamCropPan.x * (1 - storedCrop.width),
		y: webcamCropPan.y * (1 - storedCrop.height),
	};

	return {
		wallpaper: str(legacy?.wallpaper, DEFAULT_EDITOR_SETTINGS.wallpaper),
		wallpaperMotion: isWallpaperMotion(legacy?.wallpaperMotion)
			? legacy.wallpaperMotion
			: DEFAULT_EDITOR_SETTINGS.wallpaperMotion,
		// An unknown value (a frame a newer build added) reads as no frame, like the compositor.
		// `window-light` / `window-dark` split into a frame PLUS a theme, so a project written
		// before the theme existed opens with the look it had (`readRecordingFrame`).
		frame: stored?.frame ?? DEFAULT_EDITOR_SETTINGS.frame,
		frameTheme: isFrameTheme(legacy?.frameTheme)
			? legacy.frameTheme
			: (stored?.theme ?? DEFAULT_EDITOR_SETTINGS.frameTheme),
		aspectRatio: legacy?.aspectRatio ?? DEFAULT_EDITOR_SETTINGS.aspectRatio,
		formatFollowCursor:
			typeof legacy?.formatFollowCursor === "boolean" ? legacy.formatFollowCursor : null,
		// Every number below is read into its `SETTING_BOUNDS` range: the slider's range, and the
		// one a preset and the agent are held to. A stored value past it plays at the bound.
		shadowIntensity: readBounded(
			legacy?.shadowIntensity,
			"shadowIntensity",
			defaults.shadowIntensity,
		),
		showBlur: bool(legacy?.showBlur, DEFAULT_EDITOR_SETTINGS.showBlur),
		motionBlurAmount: readBounded(
			legacy?.motionBlurAmount,
			"motionBlurAmount",
			defaults.motionBlurAmount,
		),
		depthOfField: bool(legacy?.depthOfField, DEFAULT_EDITOR_SETTINGS.depthOfField),
		borderRadius: readBounded(legacy?.borderRadius, "borderRadius", defaults.borderRadius),
		padding: readBounded(legacy?.padding, "padding", defaults.padding),
		cropRegion: legacy?.cropRegion ?? DEFAULT_EDITOR_SETTINGS.cropRegion,
		webcamLayoutPreset: legacy?.webcamLayoutPreset ?? DEFAULT_EDITOR_SETTINGS.webcamLayoutPreset,
		webcamMaskShape: webcamMask.shape,
		webcamRoundness: webcamMask.roundness,
		webcamMirrored: bool(legacy?.webcamMirrored, DEFAULT_EDITOR_SETTINGS.webcamMirrored),
		webcamReactiveZoom: bool(
			legacy?.webcamReactiveZoom,
			DEFAULT_EDITOR_SETTINGS.webcamReactiveZoom,
		),
		webcamSizePreset: readBounded(
			legacy?.webcamSizePreset,
			"webcamSizePreset",
			defaults.webcamSizePreset,
		),
		webcamAnchor: readWebcamAnchor(legacy?.webcamAnchor, legacy?.webcamPosition),
		webcamCropRegion: webcamCrop,
		webcamCropPan: webcamCropPan,
		// Same bound the slider offers and the native `finish_audio` clamps to. Two
		// different ranges for one value is how a project ends up exporting a gain the
		// UI cannot display.
		audioGainDb: Math.min(
			AUDIO_GAIN_DB_LIMIT,
			Math.max(-AUDIO_GAIN_DB_LIMIT, num(legacy?.audioGainDb, 0)),
		),
		webcamBackgroundMode: isWebcamBackgroundMode(legacy?.webcamBackgroundMode)
			? legacy.webcamBackgroundMode
			: DEFAULT_EDITOR_SETTINGS.webcamBackgroundMode,
		webcamWallpaper: str(legacy?.webcamWallpaper, DEFAULT_EDITOR_SETTINGS.webcamWallpaper),
		// Unclamped, a stored 1000 reached `blur(25000px)` on the preview canvas and wedged the
		// compositing thread.
		webcamBlurIntensity: readBounded(
			legacy?.webcamBlurIntensity,
			"webcamBlurIntensity",
			defaults.webcamBlurIntensity,
		),
		cursor,
		cursorShow: bool(legacy?.cursorShow, DEFAULT_EDITOR_SETTINGS.cursorShow),
		cursorAutoHide: bool(legacy?.cursorAutoHide, DEFAULT_EDITOR_SETTINGS.cursorAutoHide),
		// A pack the app no longer ships reads as the default art, which is what the renderer
		// draws for it anyway. Left raw, the id would also switch off the modelled cursor: the
		// compositor only builds it for the default theme.
		cursorTheme: normalizeCursorThemeId(legacy?.cursorTheme),
		autoFocusAll: bool(legacy?.autoFocusAll, DEFAULT_EDITOR_SETTINGS.autoFocusAll),
	};
}
export interface EditorSettingsPatch {
	wallpaper?: string;
	wallpaperMotion?: WallpaperMotion;
	frame?: RecordingFrame;
	frameTheme?: FrameTheme;
	aspectRatio?: AspectRatio;
	formatFollowCursor?: boolean;
	shadowIntensity?: number;
	showBlur?: boolean;
	motionBlurAmount?: number;
	depthOfField?: boolean;
	borderRadius?: number;
	padding?: number;
	cropRegion?: CropRegion;
	webcamLayoutPreset?: WebcamLayoutPreset;
	webcamMaskShape?: WebcamMask;
	webcamRoundness?: number;
	webcamMirrored?: boolean;
	webcamReactiveZoom?: boolean;
	webcamSizePreset?: WebcamSizePreset;
	webcamAnchor?: WebcamAnchor;
	webcamCropRegion?: CropRegion;
	webcamCropPan?: CropPan;
	audioGainDb?: number;
	webcamBackgroundMode?: WebcamBackgroundMode;
	webcamWallpaper?: string;
	webcamBlurIntensity?: number;
	cursor?: Partial<CursorVisualSettings> & { theme?: string; show?: boolean; autoHide?: boolean };
	cursorAutoHide?: boolean;
	autoFocusAll?: boolean;
}

function nextLegacy(current: LegacyShape | null, patch: EditorSettingsPatch): LegacyShape {
	const base: LegacyShape = current ?? {};
	// Spread, but only over keys the patch actually set — a plain {...base,
	// ...patch} would write undefined over a value the caller left alone.
	// `cursor` is handled separately below: its keys are renamed (size ->
	// cursorSize), so it is not a straight passthrough.
	// The Pick keeps what the 16 `if`s used to check: a patch key with no
	// LegacyShape counterpart fails to compile instead of leaking into the
	// persisted blob.
	const { cursor: _cursor, ...rest } = patch;
	const defined = Object.fromEntries(
		Object.entries(rest).filter(([, v]) => v !== undefined),
	) as Partial<Pick<LegacyShape, keyof Omit<EditorSettingsPatch, "cursor">>>;
	const next: LegacyShape = { ...base, ...defined };
	if (patch.cursor) {
		const c = patch.cursor;
		if (c.size !== undefined) next.cursorSize = c.size;
		if (c.smoothing !== undefined) next.cursorSmoothing = c.smoothing;
		if (c.motionBlur !== undefined) next.cursorMotionBlur = c.motionBlur;
		if (c.clickBounce !== undefined) next.cursorClickBounce = c.clickBounce;
		if (c.model3d !== undefined) next.cursorModel3d = c.model3d;
		if (c.alwaysArrow !== undefined) next.cursorAlwaysArrow = c.alwaysArrow;
		if (c.theme !== undefined) next.cursorTheme = c.theme;
		if (c.show !== undefined) next.cursorShow = c.show;
		if (c.autoHide !== undefined) next.cursorAutoHide = c.autoHide;
	}
	if (patch.cursorAutoHide !== undefined) next.cursorAutoHide = patch.cursorAutoHide;
	return next;
}

export function patchEditorSettings(doc: AxcutDocument, patch: EditorSettingsPatch): AxcutDocument {
	const current = isShape(doc.legacyEditor) ? (doc.legacyEditor as LegacyShape) : null;
	return {
		...doc,
		legacyEditor: nextLegacy(current, patch) as Record<string, unknown>,
	};
}

const MIN_CROP_SIZE = 0.01;

/**
 * Recovers the pan of a crop rect authored before the pan was stored.
 *
 * `x / (1 - width)` is the expression the pane used to derive the slider's value from the
 * rect on every render, and it has to stay that expression: every project on disk today has
 * a rect and no pan, so anything else here would silently reframe them on first open. A
 * full-frame crop has no room to sit in, so it reports centred — the one case where the
 * answer is arbitrary, and the one case where nothing depends on it.
 */
function panOfCropRegion(crop: CropRegion): CropPan {
	// Guarded at 1 and not at some epsilon below it: the zoom slider is integer percent, so
	// the smallest window short of full frame is 100/101 and leaves ~0.0099 of room — a
	// perfectly ordinary divisor that a wider guard would throw away as if it were centred.
	// `normaliseCropRegion` keeps `x + width <= 1`, so the quotient is in range by
	// construction; the clamp is for a hand-edited document that got there another way.
	const axis = (offset: number, size: number) =>
		size >= 1 ? 0.5 : Math.min(1, Math.max(0, offset / (1 - size)));
	return { x: axis(crop.x, crop.width), y: axis(crop.y, crop.height) };
}

function normaliseCropPan(value: unknown, crop: CropRegion): CropPan {
	if (!value || typeof value !== "object") return panOfCropRegion(crop);
	const candidate = value as Record<string, unknown>;
	const fallback = panOfCropRegion(crop);
	return {
		x: isNumber(candidate.x) ? Math.min(1, Math.max(0, candidate.x)) : fallback.x,
		y: isNumber(candidate.y) ? Math.min(1, Math.max(0, candidate.y)) : fallback.y,
	};
}

function normaliseCropRegion(value: unknown): CropRegion {
	if (!value || typeof value !== "object") return DEFAULT_CROP_REGION;
	const candidate = value as Record<string, unknown>;
	const x = isNumber(candidate.x) ? Math.min(1 - MIN_CROP_SIZE, Math.max(0, candidate.x)) : 0;
	const y = isNumber(candidate.y) ? Math.min(1 - MIN_CROP_SIZE, Math.max(0, candidate.y)) : 0;
	const width = isNumber(candidate.width)
		? Math.min(1 - x, Math.max(MIN_CROP_SIZE, candidate.width))
		: 1 - x;
	const height = isNumber(candidate.height)
		? Math.min(1 - y, Math.max(MIN_CROP_SIZE, candidate.height))
		: 1 - y;
	return { x, y, width, height };
}
