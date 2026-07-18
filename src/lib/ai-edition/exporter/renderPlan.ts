// RenderPlan: the v2 multi-asset export pipeline's pure-logic data model.
//
// ponytail: today `documentExporter` plays a single continuous source stream
// (the primary asset) and projects timeline-authored effects (zoom / annotation
// / speed) onto each frame's *source* time, so any clip that points at a
// different asset is silently dropped. The v2 renderer decodes one segment at
// a time, so effects stay keyed in VIRTUAL (output) time and the plan just
// carries an ordered list of per-clip render segments — each with its own
// source stream and intra-clip cuts — plus the output framing and the
// pass-through effect arrays.
//
// This module is the foundation: a pure (no DOM, no IPC, no side effects)
// builder + a small `isIdentityFastPathEligible` helper the renderer can use
// to skip re-encode-worthy work for untouched single-clip projects.

import { toFileUrl } from "@/components/video-editor/projectPersistence";
import type {
	AnnotationRegion,
	CropRegion,
	SpeedRegion,
	WebcamLayoutPreset,
	WebcamMaskShape,
	WebcamSizePreset,
	ZoomRegion,
} from "@/components/video-editor/types";
import { calculateMp4ExportSettings } from "@/lib/exporter/mp4ExportSettings";
import type { ExportQuality } from "@/lib/exporter/types";
import type { CursorRecordingData } from "@/native/contracts";
import {
	type AspectRatio,
	getAspectRatioValue,
	getNativeAspectRatioValue,
} from "@/utils/aspectRatioUtils";
import { type Interval, normalizeIntervals } from "../document/timeline";
import type { AxcutCursorMotionRegion, AxcutDocument } from "../schema";

export type ExportVideoCodec = "h264" | "h265" | "vp9";

// WebCodecs encoder strings per user-facing codec choice. The muxer derives
// its mp4 track family from the same string.
const CODEC_STRINGS: Record<ExportVideoCodec, string> = {
	h264: "avc1.640033",
	h265: "hvc1.1.6.L120.90",
	vp9: "vp09.00.10.08",
};

const IDENTITY_CROP: CropRegion = { x: 0, y: 0, width: 1, height: 1 };

const DEFAULT_FRAME_RATE = 60;
const DEFAULT_FALLBACK_SOURCE_WIDTH = 1920;
const DEFAULT_FALLBACK_SOURCE_HEIGHT = 1080;

// ponytail: one render segment = one source clip fed into the decoder +
// frame loop. The renderer iterates these in order; the segment loop tracks a
// running output/virtual-time cursor so effects (passed through separately,
// keyed in virtual ms) land on the right frames regardless of which asset
// each clip draws from.
export interface RenderSegment {
	clipId: string;
	assetId: string;
	videoUrl: string;
	sourceStartSec: number;
	sourceEndSec: number;
	// The clip's position on the (1:1-with-source, pre-speed) virtual timeline.
	// Timeline-authored effects (zoom/annotation/speed) are projected onto this
	// segment's source time through [timelineStart,timelineEnd)↔[sourceStart,…).
	timelineStartSec: number;
	timelineEndSec: number;
	// Cuts INSIDE this clip, scoped per segment (unlike today's single global
	// complement in `computeExportTrimRegions`). Pre-merged + clamped via
	// `normalizeIntervals` so the renderer can drop straight in.
	intraTrims: Interval[];
	cropRegion: CropRegion;
	sourceWidth: number;
	sourceHeight: number;
	// Camera (webcam) attached to this segment's asset, when present and
	// visible. The renderer treats it as a derived stream like the existing
	// exporter does — no per-clip stitching beyond what `cameraTrack.offsetMs`
	// already encodes.
	camera: { videoUrl: string; offsetMs: number } | null;
	// CursorRecordingSample.assetId identifies a sprite, not a media asset.
	cursorRecordingData: CursorRecordingData | null;
	// Regions retain virtual and source time after owner/time validation.
	cursorMotionRegions: AxcutCursorMotionRegion[];
}

export interface RenderPlanOutput {
	width: number;
	height: number;
	frameRate: number;
	bitrate: number;
	codec: string;
}

export interface RenderPlanAppearance {
	wallpaper: string;
	padding: number;
	borderRadius: number;
	shadowIntensity: number;
	showBlur: boolean;
	motionBlurAmount: number;
}

// Cursor style is shared by the export. Recording samples and sprite atlases
// stay on their owning media asset's segment.
export interface RenderPlanCursor {
	scale: number;
	smoothing?: number;
	motionBlur?: number;
	clickBounce?: number;
	clipToBounds?: boolean;
	theme?: string;
}

// Global webcam layout/style (from legacyEditor) shared by every segment. The
// per-segment webcam SOURCE (file + offset) lives on `RenderSegment.camera`; a
// segment renders a webcam overlay only when its asset has a camera track.
export interface RenderPlanWebcam {
	layoutPreset: WebcamLayoutPreset;
	maskShape: WebcamMaskShape;
	mirrored: boolean;
	reactiveZoom: boolean;
	sizePreset: WebcamSizePreset;
	position: { cx: number; cy: number } | null;
}

export interface RenderPlan {
	output: RenderPlanOutput;
	aspectRatioValue: number;
	// Timeline order = output order. Sorted by `timelineStartSec` ascending so
	// the renderer can walk segments and effects (which are keyed in virtual
	// ms) in a single forward pass.
	segments: RenderSegment[];
	// VIRTUAL (output) time. Direct pass-through of the document's regions with
	// NO projection — the segment loop already tracks the virtual-time cursor
	// that today required `projectRegionsToSourceTime`.
	zoomRegions: ZoomRegion[];
	annotationRegions: AnnotationRegion[];
	speedRegions: SpeedRegion[];
	appearance: RenderPlanAppearance;
	// Shared cursor style. `null` when there is no recording or cursor is disabled.
	cursor: RenderPlanCursor | null;
	// Shared webcam layout/style (per-segment webcam source is on the segment).
	webcam: RenderPlanWebcam;
}

export interface BuildRenderPlanCursorOptions {
	recordingDataByAssetId?: ReadonlyMap<string, CursorRecordingData>;
	scale?: number;
	smoothing?: number;
	motionBlur?: number;
	clickBounce?: number;
	clipToBounds?: boolean;
	theme?: string;
}

export interface BuildRenderPlanOptions {
	quality: ExportQuality;
	frameRate?: number;
	codec?: ExportVideoCodec;
	fallbackSourceWidth?: number;
	fallbackSourceHeight?: number;
	// Cursor recording + style, supplied by the caller (ExportDialog) — the
	// document/asset schema does not persist cursor telemetry. Omit for no cursor.
	cursor?: BuildRenderPlanCursorOptions;
}

function extractLegacyField<T>(
	legacy: Record<string, unknown> | null,
	key: string,
	fallback: T,
): T {
	if (legacy && typeof legacy[key] === typeof fallback) {
		return legacy[key] as T;
	}
	return fallback;
}

// Stable, clone-only sort — never mutates the document's clips array. JS's
// `Array.prototype.sort` is stable per ECMA-262 since ES2019, so identical
// `timelineStartSec` preserves insertion order.
function sortClipsByTimelineStart<T extends { timelineStartSec: number }>(clips: T[]): T[] {
	return [...clips].sort((a, b) => a.timelineStartSec - b.timelineStartSec);
}

function buildIntraTrims(
	document: AxcutDocument,
	clip: AxcutDocument["timeline"]["clips"][number],
	sourceStartSec: number,
	sourceEndSec: number,
): Interval[] {
	const intersected: Interval[] = [];
	for (const trim of document.timeline.trimRanges) {
		if (trim.assetId !== clip.assetId) continue;
		intersected.push({
			startSec: Math.max(trim.startSec, sourceStartSec),
			endSec: Math.min(trim.endSec, sourceEndSec),
		});
	}
	return normalizeIntervals(sourceEndSec, intersected);
}

const CURSOR_TIME_EPSILON_MS = 1;

function cursorMotionRegionsForSegment(
	regions: AxcutCursorMotionRegion[],
	segment: Pick<
		RenderSegment,
		"clipId" | "assetId" | "sourceStartSec" | "sourceEndSec" | "timelineStartSec" | "timelineEndSec"
	>,
): AxcutCursorMotionRegion[] {
	const virtualStartMs = segment.timelineStartSec * 1000;
	const virtualEndMs = segment.timelineEndSec * 1000;
	const sourceStartMs = segment.sourceStartSec * 1000;
	const sourceEndMs = segment.sourceEndSec * 1000;

	return regions.filter((region) => {
		if (region.clipId !== segment.clipId || region.assetId !== segment.assetId) return false;
		if (region.endMs <= region.startMs || region.sourceEndMs <= region.sourceStartMs) return false;
		if (
			region.startMs < virtualStartMs - CURSOR_TIME_EPSILON_MS ||
			region.endMs > virtualEndMs + CURSOR_TIME_EPSILON_MS ||
			region.sourceStartMs < sourceStartMs - CURSOR_TIME_EPSILON_MS ||
			region.sourceEndMs > sourceEndMs + CURSOR_TIME_EPSILON_MS
		) {
			return false;
		}

		const projectedStartMs = sourceStartMs + (region.startMs - virtualStartMs);
		const projectedEndMs = sourceStartMs + (region.endMs - virtualStartMs);
		return (
			Math.abs(projectedStartMs - region.sourceStartMs) <= CURSOR_TIME_EPSILON_MS &&
			Math.abs(projectedEndMs - region.sourceEndMs) <= CURSOR_TIME_EPSILON_MS
		);
	});
}

function pickReferenceDimensions(
	segments: RenderSegment[],
	fallbackWidth: number,
	fallbackHeight: number,
): { width: number; height: number } {
	if (segments.length === 0) {
		return { width: fallbackWidth, height: fallbackHeight };
	}
	let bestArea = -1;
	let best: { width: number; height: number } = { width: fallbackWidth, height: fallbackHeight };
	for (const segment of segments) {
		const area = segment.sourceWidth * segment.sourceHeight;
		if (area > bestArea) {
			bestArea = area;
			best = { width: segment.sourceWidth, height: segment.sourceHeight };
		}
	}
	return best;
}

export function buildRenderPlan(
	document: AxcutDocument,
	options: BuildRenderPlanOptions,
): RenderPlan {
	const fallbackWidth = options.fallbackSourceWidth ?? DEFAULT_FALLBACK_SOURCE_WIDTH;
	const fallbackHeight = options.fallbackSourceHeight ?? DEFAULT_FALLBACK_SOURCE_HEIGHT;
	const codec: ExportVideoCodec = options.codec ?? "h264";
	const frameRate = options.frameRate ?? DEFAULT_FRAME_RATE;

	const recordingDataByAssetId = options.cursor?.recordingDataByAssetId;
	const cursorScale = options.cursor?.scale ?? 0;

	// --- Segments ---
	const sortedClips = sortClipsByTimelineStart(document.timeline.clips);
	const segments: RenderSegment[] = [];
	for (const clip of sortedClips) {
		const asset = document.assets.find((a) => a.id === clip.assetId);
		if (!asset) continue; // orphan clip — can't render, skip silently (matches today).

		const sourceStartSec = clip.sourceStartSec;
		const sourceEndSec = clip.sourceEndSec ?? asset.durationSec ?? sourceStartSec;
		const sourceWidth = asset.video?.width || fallbackWidth || DEFAULT_FALLBACK_SOURCE_WIDTH;
		const sourceHeight = asset.video?.height || fallbackHeight || DEFAULT_FALLBACK_SOURCE_HEIGHT;
		const cameraTrack = asset.cameraTrack;
		const camera =
			cameraTrack && cameraTrack.visible && cameraTrack.sourcePath
				? { videoUrl: toFileUrl(cameraTrack.sourcePath), offsetMs: cameraTrack.offsetMs }
				: null;

		const segment: RenderSegment = {
			clipId: clip.id,
			assetId: asset.id,
			videoUrl: toFileUrl(asset.originalPath),
			sourceStartSec,
			sourceEndSec,
			timelineStartSec: clip.timelineStartSec,
			timelineEndSec: clip.timelineEndSec,
			intraTrims: buildIntraTrims(document, clip, sourceStartSec, sourceEndSec),
			cropRegion: clip.cropRegion ?? IDENTITY_CROP,
			sourceWidth,
			sourceHeight,
			camera,
			cursorRecordingData: recordingDataByAssetId?.get(asset.id) ?? null,
			cursorMotionRegions: [],
		};
		segment.cursorMotionRegions = cursorMotionRegionsForSegment(
			document.cursorMotionRegions ?? [],
			segment,
		);
		segments.push(segment);
	}

	// --- Output sizing ---
	const ref = pickReferenceDimensions(segments, fallbackWidth, fallbackHeight);
	const legacy = document.legacyEditor as Record<string, unknown> | null;
	const aspectRatio = extractLegacyField<AspectRatio>(legacy, "aspectRatio", "16:9");
	const aspectRatioValue =
		aspectRatio === "native"
			? getNativeAspectRatioValue(ref.width, ref.height)
			: getAspectRatioValue(aspectRatio);
	const settings = calculateMp4ExportSettings({
		quality: options.quality,
		sourceWidth: ref.width,
		sourceHeight: ref.height,
		aspectRatioValue,
	});

	// --- Effects (virtual time, pass-through, NO projection) ---
	const zoomRegions = document.zoomRanges as unknown as ZoomRegion[];
	const annotationRegions = document.annotations as unknown as AnnotationRegion[];
	const speedRegions = extractLegacyField<SpeedRegion[]>(legacy, "speedRegions", []);

	// --- Appearance ---
	const appearance: RenderPlanAppearance = {
		wallpaper: extractLegacyField(legacy, "wallpaper", ""),
		padding: extractLegacyField(legacy, "padding", 50),
		borderRadius: extractLegacyField(legacy, "borderRadius", 0),
		shadowIntensity: extractLegacyField(legacy, "shadowIntensity", 0),
		showBlur: extractLegacyField(legacy, "showBlur", false),
		motionBlurAmount: extractLegacyField(legacy, "motionBlurAmount", 0),
	};

	// --- Cursor (shared style; recording data is per segment) ---
	const cursor: RenderPlanCursor | null =
		cursorScale > 0 && segments.some((segment) => segment.cursorRecordingData)
			? {
					scale: cursorScale,
					smoothing: options.cursor?.smoothing,
					motionBlur: options.cursor?.motionBlur,
					clickBounce: options.cursor?.clickBounce,
					clipToBounds: options.cursor?.clipToBounds,
					theme: options.cursor?.theme,
				}
			: null;

	// --- Webcam (global layout/style, read from legacyEditor exactly as the
	// legacy exporter does; per-segment source lives on segment.camera) ---
	const webcam: RenderPlanWebcam = {
		layoutPreset: extractLegacyField<string>(
			legacy,
			"webcamLayoutPreset",
			"picture-in-picture",
		) as WebcamLayoutPreset,
		maskShape: extractLegacyField<string>(
			legacy,
			"webcamMaskShape",
			"rectangle",
		) as WebcamMaskShape,
		mirrored: extractLegacyField(legacy, "webcamMirrored", false),
		reactiveZoom: extractLegacyField(legacy, "webcamReactiveZoom", true),
		sizePreset: extractLegacyField(legacy, "webcamSizePreset", 25),
		position: extractLegacyField<{ cx: number; cy: number } | null>(legacy, "webcamPosition", null),
	};

	return {
		output: {
			width: settings.width,
			height: settings.height,
			frameRate,
			bitrate: settings.bitrate,
			codec: CODEC_STRINGS[codec],
		},
		aspectRatioValue,
		segments,
		zoomRegions,
		annotationRegions,
		speedRegions,
		appearance,
		cursor,
		webcam,
	};
}

function isIdentityCrop(region: CropRegion): boolean {
	return region.x === 0 && region.y === 0 && region.width === 1 && region.height === 1;
}

// ponytail: when the only segment needs no re-encode-worthy effects AND the
// output frame is the source frame (1:1, no aspect re-framing, no scaling),
// the renderer can take a stream-copy fast path (remux-only) instead of a
// full decode → composite → encode round trip.
export function isIdentityFastPathEligible(plan: RenderPlan): boolean {
	if (plan.segments.length !== 1) return false;
	const segment = plan.segments[0];
	if (segment.intraTrims.length !== 0) return false;
	if (!isIdentityCrop(segment.cropRegion)) return false;
	if (plan.zoomRegions.length !== 0) return false;
	if (plan.annotationRegions.length !== 0) return false;
	// An active cursor overlay composites pixels, including edited motion.
	if (plan.cursor && segment.cursorRecordingData?.samples.length) return false;
	if (plan.cursor && segment.cursorMotionRegions.some((region) => region.preset !== "recorded")) {
		return false;
	}

	for (const region of plan.speedRegions) {
		const duration = region.endMs - region.startMs;
		if (duration > 0.0001 && Math.abs(region.speed - 1) > 0.0001) {
			return false;
		}
	}

	if (plan.output.width !== segment.sourceWidth) return false;
	if (plan.output.height !== segment.sourceHeight) return false;

	return true;
}
