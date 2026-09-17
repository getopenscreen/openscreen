// Style presets — reusable editor appearance, one JSON file per preset.
//
// Imported by the main process (electron/ai-edition/style-preset-service.ts), so this
// module stays main-process safe: relative imports only, and only TYPE imports from
// renderer modules (they are erased before anything runs). The renderer half — reading a
// preset out of the editor settings and patching it back in — is stylePresetsEditor.ts.
//
// A preset is the project's LOOK, never its content: nothing here depends on the footage
// (crop, webcam framing or position, audio gain, captions, timeline). Such a preset can be
// applied to any project, and shared as a file, without dragging one recording's framing
// into another.

import type {
	CursorVisualSettings,
	WallpaperMotion,
	WebcamBackgroundMode,
	WebcamLayoutPreset,
	WebcamMaskShape,
	WebcamSizePreset,
} from "../../components/video-editor/types";
import { type AspectRatio, isAspectRatio } from "../../utils/aspectRatioUtils";
import { CURSOR_THEME_IDS, DEFAULT_CURSOR_THEME_ID } from "../cursor/cursorThemes";
import { isRecordingFrame, type RecordingFrame } from "../projectDefaults";

export const STYLE_PRESET_FILE_EXTENSION = ".openscreenpreset";
export const STYLE_PRESET_FORMAT = "openscreen-style-preset";
export const STYLE_PRESET_FORMAT_VERSION = 1;
export const STYLE_PRESET_NAME_MAX_LENGTH = 80;
/** Reserved for the built-in row; a user preset must never resolve to this file id. */
export const FACTORY_STYLE_PRESET_ID = "openscreen-factory";
/** Characters, not bytes: a 15 MB base64 image is ~11 MB decoded, far past any wallpaper. */
export const STYLE_PRESET_DATA_URL_MAX_LENGTH = 15 * 1024 * 1024;
/** Colours and gradients are CSS text; anything this long is not one a user typed. */
const CSS_WALLPAPER_MAX_LENGTH = 10_000;

/** The appearance fields of `EditorSettingsSnapshot`, in the snapshot's own shape. */
export interface StylePresetAppearance {
	wallpaper: string;
	wallpaperMotion: WallpaperMotion;
	frame: RecordingFrame;
	aspectRatio: AspectRatio;
	shadowIntensity: number;
	showBlur: boolean;
	motionBlurAmount: number;
	depthOfField: boolean;
	borderRadius: number;
	padding: number;
	webcamLayoutPreset: WebcamLayoutPreset;
	webcamMaskShape: WebcamMaskShape;
	webcamMirrored: boolean;
	webcamReactiveZoom: boolean;
	webcamSizePreset: WebcamSizePreset;
	webcamBackgroundMode: WebcamBackgroundMode;
	webcamWallpaper: string;
	webcamBlurIntensity: number;
	/** `autoHide` is left out: the snapshot's source of truth for it is `cursorAutoHide`. */
	cursor: Omit<CursorVisualSettings, "autoHide">;
	cursorShow: boolean;
	cursorAutoHide: boolean;
	cursorTheme: string;
}

export interface StylePreset {
	/** The file's base name, without the extension. */
	id: string;
	name: string;
	/** ISO timestamp of the file's last modification. */
	updatedAt: string;
	appearance: StylePresetAppearance;
}

export interface StylePresetFile {
	format: typeof STYLE_PRESET_FORMAT;
	version: typeof STYLE_PRESET_FORMAT_VERSION;
	name: string;
	appearance: StylePresetAppearance;
}

// Local copies of renderer enums: the modules that own them import through `@/`, which
// the main process cannot load. `satisfies` keeps each list from naming a value the type
// does not have; a value ADDED to the type still has to be added here.
const WEBCAM_LAYOUT_PRESETS = [
	"picture-in-picture",
	"vertical-stack",
	"dual-frame",
	"no-webcam",
] as const satisfies readonly WebcamLayoutPreset[];
const WEBCAM_MASK_SHAPES = [
	"rectangle",
	"circle",
	"square",
	"rounded",
] as const satisfies readonly WebcamMaskShape[];
const WEBCAM_BACKGROUND_MODES = [
	"none",
	"transparent",
	"blur",
	"custom",
] as const satisfies readonly WebcamBackgroundMode[];
const WALLPAPER_MOTIONS = [
	"none",
	"drift",
	"aurora",
	"waves",
] as const satisfies readonly WallpaperMotion[];

// Bounds are the editor sliders' (RightPanes.tsx), in stored units. `getEditorSettings`
// only clamps two of these, so a preset is the stricter gate: a value no slider can
// produce is a hand-edited file, and it is refused rather than applied.
const NUMBER_RANGES = {
	shadowIntensity: [0, 1],
	motionBlurAmount: [0, 1],
	borderRadius: [0, 64],
	padding: [0, 100],
	webcamSizePreset: [10, 50],
	webcamBlurIntensity: [0, 1],
} as const;
const CURSOR_NUMBER_RANGES = {
	size: [0.5, 10],
	smoothing: [0, 1],
	motionBlur: [0, 1],
	clickBounce: [0, 5],
	volume: [0, 1],
} as const;

type Fields = Record<string, unknown>;

function isRecord(value: unknown): value is Fields {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNumber(
	source: Fields,
	key: string,
	[min, max]: readonly [number, number],
	at = "",
): number {
	const value = source[key];
	if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
		throw new TypeError(`Style preset ${at}${key} must be a number between ${min} and ${max}.`);
	}
	return value;
}

function readBoolean(source: Fields, key: string, at = ""): boolean {
	const value = source[key];
	if (typeof value !== "boolean") {
		throw new TypeError(`Style preset ${at}${key} must be true or false.`);
	}
	return value;
}

function readEnum<T extends string>(source: Fields, key: string, allowed: readonly T[]): T {
	const value = source[key];
	if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
		throw new TypeError(`Style preset ${key} must be one of: ${allowed.join(", ")}.`);
	}
	return value as T;
}

/**
 * The one field a version-1 preset may omit: every preset written before the frame existed
 * lacks it, and "no frame" is exactly what those presets looked like. A value that IS there
 * must be one this build knows.
 */
function readFrame(source: Fields): RecordingFrame {
	const value = source.frame;
	if (value === undefined) return "none";
	if (!isRecordingFrame(value)) {
		throw new TypeError("Style preset frame must be one of: none, window-light, window-dark.");
	}
	return value;
}

const HEX_COLOR_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const COLOR_FUNCTION_RE = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(.*\)$/i;
const GRADIENT_RE = /^(?:repeating-)?(?:linear|radial|conic)-gradient\(.*\)$/i;
const BUNDLED_WALLPAPER_RE = /^\/wallpapers\/wallpaper\d+\.jpg$/;
const DATA_URL_RE = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;
// Same pattern as projectPersistence.ts: only the known install layouts (packaged
// resources/[assets/]wallpapers, dev public/wallpapers), so a user's own file under some
// "wallpapers" folder is not mistaken for a bundled one.
const LEGACY_FILE_WALLPAPER_RE =
	/^file:\/\/.*?\/(?:resources\/(?:assets\/)?|public\/)wallpapers\/(wallpaper\d+\.jpg)$/i;

/**
 * Validates one wallpaper value and returns it in canonical form.
 *
 * A preset is a file people pass around, so the wallpaper is the field that could reach
 * outside it: a `file://` or absolute path names something on the author's disk (or probes
 * the reader's), and an `http(s)` URL makes applying a preset a network request. Only
 * self-contained values pass — CSS colours and gradients, the bundled images, and inline
 * PNG/JPEG data. A CSS value that smuggles a `url(` is refused for the same reason.
 */
export function parseStylePresetWallpaper(value: unknown, key = "wallpaper"): string {
	if (typeof value !== "string") {
		throw new TypeError(`Style preset ${key} must be a string.`);
	}
	if (value.startsWith("data:")) {
		if (value.length > STYLE_PRESET_DATA_URL_MAX_LENGTH) {
			throw new TypeError(
				`Style preset ${key} image is too large (${value.length} characters; the limit is ${STYLE_PRESET_DATA_URL_MAX_LENGTH}).`,
			);
		}
		if (!DATA_URL_RE.test(value)) {
			throw new TypeError(`Style preset ${key} image must be a base64 PNG or JPEG data URL.`);
		}
		return value;
	}
	const legacy = LEGACY_FILE_WALLPAPER_RE.exec(value);
	if (legacy) return `/wallpapers/${legacy[1].toLowerCase()}`;
	if (BUNDLED_WALLPAPER_RE.test(value)) return value;
	const trimmed = value.trim();
	const isCss =
		HEX_COLOR_RE.test(trimmed) || COLOR_FUNCTION_RE.test(trimmed) || GRADIENT_RE.test(trimmed);
	if (isCss && trimmed.length <= CSS_WALLPAPER_MAX_LENGTH && !/url\(/i.test(trimmed)) {
		return trimmed;
	}
	throw new TypeError(
		`Style preset ${key} must be a colour, a gradient, a bundled wallpaper or an embedded PNG/JPEG image.`,
	);
}

/**
 * Strict validation of a preset's appearance.
 *
 * Every field is required — format version 1 is only ever written whole by
 * `serializeStylePresetFile`, so a missing field is a damaged or hand-made file, and
 * guessing a factory value for it would apply something the author never chose. The one
 * lenient field is `cursorTheme`: themes come and go between builds, so an id this build
 * does not ship falls back to the default cursor instead of rejecting a preset that is
 * otherwise sound (the editor does the same when it renders one). The others postdate the
 * first version-1 files, so a preset saved before one of them existed carries no choice about
 * it and gets the value that means "unchanged": `cursor.volume` may be absent (the preset was
 * authored flat), `wallpaperMotion` too (a still wallpaper, which is exactly what "none"
 * means), `frame` as well (no frame, see `readFrame`), and `depthOfField` keeps the factory
 * value (on). A present but ill-typed value is still refused. Unknown extra keys are dropped.
 */
export function parseStylePresetAppearance(value: unknown): StylePresetAppearance {
	if (!isRecord(value)) {
		throw new TypeError("Style preset appearance must be an object.");
	}
	if (!isAspectRatio(value.aspectRatio)) {
		throw new TypeError('Style preset aspectRatio must be "W:H" or "native".');
	}
	const cursor = value.cursor;
	if (!isRecord(cursor)) {
		throw new TypeError("Style preset cursor must be an object.");
	}
	if (typeof value.cursorTheme !== "string") {
		throw new TypeError("Style preset cursorTheme must be a string.");
	}
	return {
		wallpaper: parseStylePresetWallpaper(value.wallpaper),
		wallpaperMotion:
			value.wallpaperMotion === undefined
				? "none"
				: readEnum(value, "wallpaperMotion", WALLPAPER_MOTIONS),
		frame: readFrame(value),
		aspectRatio: value.aspectRatio,
		shadowIntensity: readNumber(value, "shadowIntensity", NUMBER_RANGES.shadowIntensity),
		showBlur: readBoolean(value, "showBlur"),
		motionBlurAmount: readNumber(value, "motionBlurAmount", NUMBER_RANGES.motionBlurAmount),
		depthOfField: value.depthOfField === undefined ? true : readBoolean(value, "depthOfField"),
		borderRadius: readNumber(value, "borderRadius", NUMBER_RANGES.borderRadius),
		padding: readNumber(value, "padding", NUMBER_RANGES.padding),
		webcamLayoutPreset: readEnum(value, "webcamLayoutPreset", WEBCAM_LAYOUT_PRESETS),
		webcamMaskShape: readEnum(value, "webcamMaskShape", WEBCAM_MASK_SHAPES),
		webcamMirrored: readBoolean(value, "webcamMirrored"),
		webcamReactiveZoom: readBoolean(value, "webcamReactiveZoom"),
		webcamSizePreset: readNumber(value, "webcamSizePreset", NUMBER_RANGES.webcamSizePreset),
		webcamBackgroundMode: readEnum(value, "webcamBackgroundMode", WEBCAM_BACKGROUND_MODES),
		webcamWallpaper: parseStylePresetWallpaper(value.webcamWallpaper, "webcamWallpaper"),
		webcamBlurIntensity: readNumber(
			value,
			"webcamBlurIntensity",
			NUMBER_RANGES.webcamBlurIntensity,
		),
		cursor: {
			size: readNumber(cursor, "size", CURSOR_NUMBER_RANGES.size, "cursor."),
			smoothing: readNumber(cursor, "smoothing", CURSOR_NUMBER_RANGES.smoothing, "cursor."),
			motionBlur: readNumber(cursor, "motionBlur", CURSOR_NUMBER_RANGES.motionBlur, "cursor."),
			clickBounce: readNumber(cursor, "clickBounce", CURSOR_NUMBER_RANGES.clickBounce, "cursor."),
			// Presets written before the setting existed have no volume: they meant a flat cursor.
			volume:
				cursor.volume === undefined
					? 0
					: readNumber(cursor, "volume", CURSOR_NUMBER_RANGES.volume, "cursor."),
			clipToBounds: readBoolean(cursor, "clipToBounds", "cursor."),
		},
		cursorShow: readBoolean(value, "cursorShow"),
		cursorAutoHide: readBoolean(value, "cursorAutoHide"),
		cursorTheme: CURSOR_THEME_IDS.has(value.cursorTheme)
			? value.cursorTheme
			: DEFAULT_CURSOR_THEME_ID,
	};
}

/** Trims, collapses inner whitespace and caps the length. Throws on an empty result. */
export function sanitizeStylePresetName(name: string): string {
	const collapsed = (typeof name === "string" ? name : "").replace(/\s+/g, " ").trim();
	if (!collapsed) {
		throw new TypeError("Style preset name must not be empty.");
	}
	// By code point, so the cap never splits a surrogate pair in half.
	return Array.from(collapsed).slice(0, STYLE_PRESET_NAME_MAX_LENGTH).join("").trim();
}

const WINDOWS_RESERVED_NAME_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/**
 * A file base name that is valid on Windows, macOS and Linux alike.
 *
 * Unicode stays — a preset called "Démo 日本" is called that on disk too. What goes is
 * what Windows refuses (`<>:"/\|?*`, control characters, trailing dots and spaces), and a
 * reserved device name gets a suffix so it no longer is one. The same rules apply on every
 * platform because the file is meant to travel: a name accepted on macOS must not become
 * uncopyable on a colleague's PC.
 */
export function stylePresetFileBaseName(name: string): string {
	const stripped = sanitizeStylePresetName(name)
		.replace(/[<>:"/\\|?*\p{Cc}]/gu, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[. ]+$/, "");
	const base = stripped || "Preset";
	return WINDOWS_RESERVED_NAME_RE.test(base) ? `${base}_` : base;
}

/** List order: by name, ignoring case and accents, then by id so ties are stable. */
export function compareStylePresets(a: StylePreset, b: StylePreset): number {
	return (
		a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id)
	);
}

export function serializeStylePresetFile(input: {
	name: string;
	appearance: StylePresetAppearance;
}): string {
	const file: StylePresetFile = {
		format: STYLE_PRESET_FORMAT,
		version: STYLE_PRESET_FORMAT_VERSION,
		name: sanitizeStylePresetName(input.name),
		appearance: parseStylePresetAppearance(input.appearance),
	};
	return `${JSON.stringify(file, null, 2)}\n`;
}

/** Validates a parsed preset file (the JSON value, not the text). */
export function parseStylePresetFile(json: unknown): StylePresetFile {
	if (!isRecord(json) || json.format !== STYLE_PRESET_FORMAT) {
		throw new TypeError("Not an OpenScreen style preset file.");
	}
	if (json.version !== STYLE_PRESET_FORMAT_VERSION) {
		throw new TypeError(
			`Unsupported style preset version ${String(json.version)} (this build reads version ${STYLE_PRESET_FORMAT_VERSION}).`,
		);
	}
	if (typeof json.name !== "string") {
		throw new TypeError("Style preset name must be a string.");
	}
	return {
		format: STYLE_PRESET_FORMAT,
		version: STYLE_PRESET_FORMAT_VERSION,
		name: sanitizeStylePresetName(json.name),
		appearance: parseStylePresetAppearance(json.appearance),
	};
}
