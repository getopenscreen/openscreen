// The project's look for the agent: `setEditorSettings`, which writes it, and the `settings`
// block `getCurrentDocument` reads it back through (#1180, batch A).
//
// Both sides speak `EditorSettingsPatch`, so what the agent reads it can write back as is. The
// write goes through `applySettingsPatch`, the editor's own, with what the editor does around a
// pick: a format picked for the first time fills the frame, an untouched camera roundness follows
// its shape, and the camera framing is stored as the size-and-pan pair the pane writes.
//
// The read also says, per knob, why the editor hides it in the current state, so an agent does
// not set a value that changes nothing and report it as done.

import { z } from "zod";
import {
	WALLPAPER_MOTIONS,
	WEBCAM_BACKGROUND_MODES,
} from "../../src/components/video-editor/types";
import {
	collectNativeFormats,
	type FormatFillAvailability,
	formatFillAvailability,
	isAutoFormatAvailable,
} from "../../src/lib/ai-edition/document/outputFormat";
import type { AxcutDocument } from "../../src/lib/ai-edition/schema";
import {
	AUDIO_GAIN_DB_LIMIT,
	type EditorSettingsPatch,
	getEditorSettings,
	panOfCropRegion,
} from "../../src/lib/ai-edition/store/editorSettings";
import { applySettingsPatch } from "../../src/lib/ai-edition/store/settingsPatch";
import { parseStylePresetWallpaper } from "../../src/lib/ai-edition/stylePresets";
import { hasAnyClipWithCamera } from "../../src/lib/ai-edition/timeline/camera";
import {
	resolveWebcamLayoutPreset,
	supportsWebcamReactiveZoom,
	type WebcamLayoutPreset,
} from "../../src/lib/compositeLayout";
import {
	CURSOR_KIND_IDS,
	CURSOR_THEME_IDS,
	CURSOR_THEMES,
	DEFAULT_CURSOR_THEME_ID,
} from "../../src/lib/cursor/cursorThemes";
import {
	DEFAULT_WEBCAM_ROUNDNESS,
	FRAME_THEMES,
	RECORDING_FRAMES,
	SETTING_BOUNDS,
	type SettingBound,
	WEBCAM_ANCHORS,
} from "../../src/lib/projectDefaults";
import { classifyWallpaper, WALLPAPER_PATHS } from "../../src/lib/wallpaper";
import type { SegmentationSupport } from "../../src/native/contracts";
import { ASPECT_RATIO_PRESETS, type AspectRatio } from "../../src/utils/aspectRatioUtils";
import type { AgentToolExecution } from "./agent-tools";
import { measureTextInShippedFonts } from "./text-measure";

const WEBCAM_LAYOUT_PRESETS = [
	"picture-in-picture",
	"dual-frame",
	"vertical-stack",
	"no-webcam",
] as const satisfies readonly WebcamLayoutPreset[];

/** The tightest the camera framing goes: a third of the picture (the pane's `MIN_CROP_SIZE`). */
const MIN_WEBCAM_CROP_SIZE = 1 / 3;

const bounded = (bound: SettingBound) =>
	z.number().min(SETTING_BOUNDS[bound][0]).max(SETTING_BOUNDS[bound][1]);

/** The security boundary: only self-contained values, never a file path or a URL. */
const wallpaperArg = (key: string) =>
	z.string().superRefine((value, ctx) => {
		try {
			parseStylePresetWallpaper(value, key);
		} catch (error) {
			ctx.addIssue({
				code: "custom",
				message: String(error instanceof Error ? error.message : error).replace(
					/^Style preset /,
					"",
				),
			});
		}
	});

const fraction = z.number().min(0).max(1);

export const setEditorSettingsArgs = z
	.object({
		wallpaper: wallpaperArg("wallpaper").describe(
			"A bundled wallpaper path (settingsContext.bundledWallpapers), a CSS colour (#1e1e2e, rgb(…)), a CSS gradient, or a base64 PNG/JPEG data URL. No file paths, no web URLs.",
		),
		wallpaperMotion: z.enum(WALLPAPER_MOTIONS),
		frame: z.enum(RECORDING_FRAMES),
		frameTheme: z.enum(FRAME_THEMES),
		aspectRatio: z
			.string()
			.describe(
				'"auto", one of the presets, or a token from settingsContext.originalAspectRatios.',
			),
		formatFollowCursor: z.boolean(),
		shadowIntensity: bounded("shadowIntensity"),
		backgroundBlur: bounded("backgroundBlur"),
		motionBlurAmount: bounded("motionBlurAmount"),
		depthOfField: z.boolean(),
		borderRadius: bounded("borderRadius").describe("Corner radius in px at 1080p."),
		padding: bounded("padding").describe("Percent."),
		webcamLayoutPreset: z.enum(WEBCAM_LAYOUT_PRESETS),
		webcamMaskShape: z.enum(["rectangle", "square"]),
		webcamRoundness: bounded("webcamRoundness"),
		webcamMirrored: z.boolean(),
		webcamReactiveZoom: z.boolean(),
		webcamSizePreset: bounded("webcamSizePreset").describe(
			"The camera's long side, in percent of the frame's short side.",
		),
		webcamAnchor: z.enum(WEBCAM_ANCHORS),
		webcamCropRegion: z
			.object({
				x: fraction,
				y: fraction,
				width: z.number().min(MIN_WEBCAM_CROP_SIZE).max(1),
				height: z.number().min(MIN_WEBCAM_CROP_SIZE).max(1),
			})
			.strict()
			.refine((r) => Math.abs(r.width - r.height) < 1e-6, {
				message: "width and height must be equal: the framing keeps the camera's proportions.",
			})
			.refine((r) => r.x + r.width <= 1 + 1e-6 && r.y + r.height <= 1 + 1e-6, {
				message: "The framing must stay inside the picture: x + width and y + height ≤ 1.",
			}),
		webcamCropPan: z.object({ x: fraction, y: fraction }).strict(),
		webcamBackgroundMode: z.enum(WEBCAM_BACKGROUND_MODES),
		webcamWallpaper: wallpaperArg("webcamWallpaper"),
		webcamBlurIntensity: bounded("webcamBlurIntensity"),
		webcamChromaKeyColor: z
			.string()
			.regex(/^#[0-9a-fA-F]{6}$/, "Must be a 6-digit hex color like #00FF00."),
		webcamChromaKeySimilarity: bounded("webcamChromaKeySimilarity"),
		webcamChromaKeySmoothness: bounded("webcamChromaKeySmoothness"),
		webcamChromaKeySpill: bounded("webcamChromaKeySpill"),
		audioGainDb: z.number().min(-AUDIO_GAIN_DB_LIMIT).max(AUDIO_GAIN_DB_LIMIT),
		autoFocusAll: z.boolean(),
		cursor: z
			.object({
				show: z.boolean(),
				autoHide: z.boolean(),
				theme: z.enum([...CURSOR_THEME_IDS] as [string, ...string[]]),
				asArrow: z.array(z.enum(CURSOR_KIND_IDS as [string, ...string[]])),
				size: bounded("cursorSize"),
				smoothing: bounded("cursorSmoothing"),
				motionBlur: bounded("cursorMotionBlur"),
				clickBounce: bounded("cursorClickBounce"),
				clickImpact: z.boolean(),
				clickSound: z.boolean(),
				clickSoundGainDb: bounded("cursorClickSoundGainDb"),
				model3d: z.boolean(),
			})
			.partial()
			.strict(),
	})
	.partial()
	.strict();

export type SetEditorSettingsArgs = z.infer<typeof setEditorSettingsArgs>;

/** A data URL is megabytes the model cannot read: it sees what it is, and leaves the key out. */
function elideDataUrl(value: string): string {
	return value.startsWith("data:")
		? `[embedded image, ${Math.round((value.length * 0.75) / 1024)} KB: leave this key out to keep it]`
		: value;
}

/** The look, in the shape `setEditorSettings` takes. */
function settingsForModel(document: AxcutDocument) {
	const s = getEditorSettings(document);
	return {
		wallpaper: elideDataUrl(s.wallpaper),
		wallpaperMotion: s.wallpaperMotion,
		frame: s.frame,
		frameTheme: s.frameTheme,
		aspectRatio: s.aspectRatio,
		// `null` is "never chosen", which only a first fixed format reads; absent, not a third value.
		...(s.formatFollowCursor === null ? {} : { formatFollowCursor: s.formatFollowCursor }),
		shadowIntensity: s.shadowIntensity,
		backgroundBlur: s.backgroundBlur,
		motionBlurAmount: s.motionBlurAmount,
		depthOfField: s.depthOfField,
		borderRadius: s.borderRadius,
		padding: s.padding,
		webcamLayoutPreset: s.webcamLayoutPreset,
		webcamMaskShape: s.webcamMaskShape,
		webcamRoundness: s.webcamRoundness,
		webcamMirrored: s.webcamMirrored,
		webcamReactiveZoom: s.webcamReactiveZoom,
		webcamSizePreset: s.webcamSizePreset,
		webcamAnchor: s.webcamAnchor,
		webcamCropRegion: s.webcamCropRegion,
		webcamCropPan: s.webcamCropPan,
		webcamBackgroundMode: s.webcamBackgroundMode,
		webcamWallpaper: elideDataUrl(s.webcamWallpaper),
		webcamBlurIntensity: s.webcamBlurIntensity,
		webcamChromaKeyColor: s.webcamChromaKeyColor,
		webcamChromaKeySimilarity: s.webcamChromaKeySimilarity,
		webcamChromaKeySmoothness: s.webcamChromaKeySmoothness,
		webcamChromaKeySpill: s.webcamChromaKeySpill,
		audioGainDb: s.audioGainDb,
		autoFocusAll: s.autoFocusAll,
		cursor: {
			show: s.cursorShow,
			autoHide: s.cursorAutoHide,
			theme: s.cursorTheme,
			asArrow: s.cursor.asArrow,
			size: s.cursor.size,
			smoothing: s.cursor.smoothing,
			motionBlur: s.cursor.motionBlur,
			clickBounce: s.cursor.clickBounce,
			clickImpact: s.cursor.clickImpact,
			clickSound: s.cursor.clickSound,
			clickSoundGainDb: s.cursor.clickSoundGainDb,
			model3d: s.cursor.model3d,
		},
	};
}

const FORMAT_FILL_REASONS: Record<Exclude<FormatFillAvailability, "available">, string> = {
	none: "The format is auto or the recording's own shape, so the recording already fills it.",
	mixed: "The clips differ in shape, so no single window rule suits them all.",
	layout: "A side-by-side or stacked camera layout already fills its own slot.",
	frame: "A device frame is drawn around the whole recording.",
};

const WEBCAM_KEYS = [
	"webcamLayoutPreset",
	"webcamMaskShape",
	"webcamRoundness",
	"webcamMirrored",
	"webcamReactiveZoom",
	"webcamSizePreset",
	"webcamAnchor",
	"webcamCropRegion",
	"webcamCropPan",
	"webcamBackgroundMode",
	"webcamWallpaper",
	"webcamBlurIntensity",
	"webcamChromaKeyColor",
	"webcamChromaKeySimilarity",
	"webcamChromaKeySmoothness",
	"webcamChromaKeySpill",
] as const;

/**
 * Each setting the editor hides (or disables) in this state, with why. Its value is stored and
 * comes back when the state changes, but it changes nothing on screen until then. Keys are the
 * `setEditorSettings` ones, `cursor.*` for the cursor's.
 */
export function inactiveSettings(
	document: AxcutDocument,
	segmentation: SegmentationSupport | null,
): Record<string, string> {
	const s = getEditorSettings(document);
	const out: Record<string, string> = {};
	if (classifyWallpaper(s.wallpaper).kind === "color") {
		out.wallpaperMotion = "Only a gradient or image wallpaper moves; this one is a solid colour.";
	}
	const fill = formatFillAvailability(document);
	if (fill !== "available") out.formatFollowCursor = FORMAT_FILL_REASONS[fill];
	if (s.frame === "none") out.frameTheme = "No frame is drawn (frame is none).";
	if (s.padding === 0 && s.frame === "none") {
		out.borderRadius = "At padding 0 with no frame the corners are square.";
	}
	if (!document.zoomRanges.some((zoom) => zoom.rotationPreset != null)) {
		out.depthOfField = "It only blurs a 3D-tilted zoom (rotationPreset), and there is none.";
	}

	if (!hasAnyClipWithCamera(document.assets, document.timeline.clips)) {
		for (const key of WEBCAM_KEYS) out[key] = "No clip on the timeline has a camera.";
	} else {
		const preset = resolveWebcamLayoutPreset(s.webcamLayoutPreset, true);
		if (preset !== "picture-in-picture") {
			const why = `Only the picture-in-picture layout has it; the layout is ${preset}.`;
			for (const key of [
				"webcamMaskShape",
				"webcamRoundness",
				"webcamSizePreset",
				"webcamAnchor",
			] as const) {
				out[key] = why;
			}
		}
		if (!supportsWebcamReactiveZoom(preset)) {
			out.webcamReactiveZoom = `Only a picture-in-picture camera shrinks on zoom; the layout is ${preset}.`;
		}
		if (segmentation !== null && segmentation !== "ready") {
			const why = `This machine cannot cut out the camera background (${segmentation}).`;
			out.webcamBackgroundMode = why;
			out.webcamBlurIntensity = why;
			out.webcamWallpaper = why;
		} else {
			if (s.webcamBackgroundMode !== "blur") {
				out.webcamBlurIntensity = "Only used when webcamBackgroundMode is blur.";
			}
			if (s.webcamBackgroundMode !== "custom") {
				out.webcamWallpaper = "Only used when webcamBackgroundMode is custom.";
			}
		}
		if (s.webcamBackgroundMode !== "chromakey") {
			for (const key of [
				"webcamChromaKeyColor",
				"webcamChromaKeySimilarity",
				"webcamChromaKeySmoothness",
				"webcamChromaKeySpill",
			] as const) {
				out[key] = "Only used when webcamBackgroundMode is chromakey.";
			}
		}
	}

	if (!s.cursorShow) {
		const why = "The cursor is hidden (cursor.show is false).";
		for (const key of ["autoHide", "model3d", "asArrow", "clickImpact", "clickSound"]) {
			out[`cursor.${key}`] = why;
		}
		out["cursor.clickSoundGainDb"] = why;
	} else if (!s.cursor.clickSound) {
		out["cursor.clickSoundGainDb"] = "The click sound is off (cursor.clickSound is false).";
	}
	return out;
}

/** The project's look and what the editor would offer for it, for `getCurrentDocument`. */
export function editorSettingsSnapshot(
	document: AxcutDocument,
	segmentation: SegmentationSupport | null,
) {
	const autoAvailable = isAutoFormatAvailable(document);
	return {
		settings: settingsForModel(document),
		settingsContext: {
			note: "settings uses setEditorSettings' own shape. inactive lists each setting the editor hides in this state, and why: a value set there is stored but changes nothing until that state changes. cameraSegmentation null means this server could not check whether the machine can cut out the camera background. The captions are not here: getCaptions reads them, setCaptionSettings sets them.",
			aspectRatios: [...(autoAvailable ? ["auto"] : []), ...ASPECT_RATIO_PRESETS],
			originalAspectRatios: collectNativeFormats(document).map(({ ratio: _ratio, ...f }) => f),
			formatFill: formatFillAvailability(document),
			hasTiltedZoom: document.zoomRanges.some((zoom) => zoom.rotationPreset != null),
			bundledWallpapers: WALLPAPER_PATHS,
			cursorThemes: [
				{ id: DEFAULT_CURSOR_THEME_ID, name: "Default" },
				...CURSOR_THEMES.map(({ id, name }) => ({ id, name })),
			],
			cameraSegmentation: segmentation,
			inactive: inactiveSettings(document, segmentation),
		},
	};
}

/** What the format picker offers: auto (while the timeline holds one composition), a preset, or
 *  one of the timeline's own shapes. The current value always passes, so a read written back
 *  as is never fails on it. */
function aspectRatioError(document: AxcutDocument, value: string): string | null {
	const original = collectNativeFormats(document).map((f) => f.token);
	const auto = isAutoFormatAvailable(document) ? ["auto"] : [];
	const allowed = [...auto, ...ASPECT_RATIO_PRESETS, ...original];
	return allowed.includes(value) || value === getEditorSettings(document).aspectRatio
		? null
		: `aspectRatio ${JSON.stringify(value)} is not offered for this project. Use one of: ${allowed.join(", ")}.`;
}

/** The parsed args as the editor would write them, with what its pane does around each pick. */
function editorPatch(document: AxcutDocument, args: SetEditorSettingsArgs): EditorSettingsPatch {
	const current = getEditorSettings(document);
	const { webcamCropRegion, webcamCropPan, wallpaper, webcamWallpaper, ...rest } = args;
	const patch: EditorSettingsPatch = {
		...(rest as Omit<EditorSettingsPatch, "aspectRatio">),
		aspectRatio: args.aspectRatio as AspectRatio | undefined,
	};
	if (wallpaper !== undefined) patch.wallpaper = parseStylePresetWallpaper(wallpaper);
	if (webcamWallpaper !== undefined) {
		patch.webcamWallpaper = parseStylePresetWallpaper(webcamWallpaper, "webcamWallpaper");
	}
	// A format picked while the project never chose how to fill it fills the frame (`fillDefault`).
	if (
		args.aspectRatio !== undefined &&
		args.aspectRatio !== "auto" &&
		args.formatFollowCursor === undefined &&
		current.formatFollowCursor === null
	) {
		patch.formatFollowCursor = true;
	}
	// An untouched roundness follows the shape to its own default; a tuned one stays.
	if (
		args.webcamMaskShape !== undefined &&
		args.webcamRoundness === undefined &&
		current.webcamRoundness === DEFAULT_WEBCAM_ROUNDNESS[current.webcamMaskShape]
	) {
		patch.webcamRoundness = DEFAULT_WEBCAM_ROUNDNESS[args.webcamMaskShape];
	}
	// The pan is what is stored; the rect is rebuilt from it. A rect given alone says where it
	// sits, so its pan is read off it; a pan given alone keeps the current size.
	if (webcamCropRegion || webcamCropPan) {
		const size = webcamCropRegion?.width ?? current.webcamCropRegion.width;
		const pan =
			webcamCropPan ??
			(webcamCropRegion ? panOfCropRegion(webcamCropRegion) : current.webcamCropPan);
		patch.webcamCropPan = pan;
		patch.webcamCropRegion = {
			x: pan.x * (1 - size),
			y: pan.y * (1 - size),
			width: size,
			height: size,
		};
	}
	return patch;
}

/** A rect and a pan sent together that place the window in two different spots. At full size
 *  there is no room to place it in, so any pan agrees with the rect there. */
function cropFramingConflict(args: SetEditorSettingsArgs): string | null {
	const { webcamCropRegion: region, webcamCropPan: pan } = args;
	if (!region || !pan) return null;
	const agrees = (offset: number, size: number, share: number) =>
		Math.abs(offset - share * (1 - size)) < 1e-6;
	return agrees(region.x, region.width, pan.x) && agrees(region.y, region.height, pan.y)
		? null
		: "webcamCropRegion and webcamCropPan place the framing in two different spots: send one of them, or both as getCurrentDocument returns them.";
}

/** Every key a patch sets, `cursor.*` for the cursor's: what the result reports as applied. */
function patchKeys(patch: EditorSettingsPatch): string[] {
	const { cursor, ...rest } = patch;
	return [
		...Object.keys(rest).filter((key) => rest[key as keyof typeof rest] !== undefined),
		...Object.keys(cursor ?? {}).map((key) => `cursor.${key}`),
	];
}

export function executeSetEditorSettings(
	document: AxcutDocument,
	args: unknown,
	segmentation: SegmentationSupport | null,
): AgentToolExecution {
	const parsed = setEditorSettingsArgs.safeParse(args);
	if (!parsed.success) {
		return { ok: false, resultJson: JSON.stringify({ error: parsed.error.message }) };
	}
	const conflict = cropFramingConflict(parsed.data);
	if (conflict) return { ok: false, resultJson: JSON.stringify({ error: conflict }) };
	const patch = editorPatch(document, parsed.data);
	const keys = patchKeys(patch);
	if (keys.length === 0) {
		return {
			ok: false,
			resultJson: JSON.stringify({
				error: "Pass at least one setting; getCurrentDocument lists them under settings.",
			}),
		};
	}
	if (patch.aspectRatio !== undefined) {
		const error = aspectRatioError(document, patch.aspectRatio);
		if (error) return { ok: false, resultJson: JSON.stringify({ error }) };
	}
	// The editor's own write: frame-placed annotations keep their centre through a new format,
	// a text refitted to its words in the shipped fonts.
	const next = applySettingsPatch(document, patch, measureTextInShippedFonts);
	const inactive = inactiveSettings(next, segmentation);
	const stillInactive = Object.fromEntries(
		keys.filter((key) => key in inactive).map((key) => [key, inactive[key]]),
	);
	const settings = settingsForModel(next);
	return {
		ok: true,
		document: next,
		resultJson: JSON.stringify({
			applied: keys,
			settings,
			...(Object.keys(stillInactive).length
				? {
						inactive: stillInactive,
						inactiveNote:
							"Stored, but these change nothing in the current state, for the reason given. Say so rather than reporting the look as changed.",
					}
				: {}),
		}),
		summary: `set ${keys.join(", ")}`,
	};
}
