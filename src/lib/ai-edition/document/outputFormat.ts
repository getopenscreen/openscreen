/**
 * The ONE place that decides the scene's output geometry from a document.
 *
 * Three call sites used to hand-roll "which asset is the reference, and what ratio does that
 * make" independently — `referenceClipDims`/`pickOutputDims` (native/sceneDescription.ts, feeds
 * the D3D compositor), `rawReferenceSource`/`EXPORT_ASPECT` (ExportDialog.tsx, feeds the size
 * shown next to each quality tier), and `PreviewCanvas.tsx`'s frame sizing (which didn't resolve
 * "native" at all and so framed old projects 16:9 while the compositor output portrait). They
 * have to agree by construction, not by comment, so they all route through here.
 *
 * `collectNativeFormats` is the other half: instead of silently resolving "Original" to whichever
 * clip happens to be biggest — which flips the whole project's shape when a clip is added or
 * removed — the picker enumerates the distinct shapes on the timeline and the user picks one,
 * which is then stored as a concrete `"W:H"` token and can no longer drift.
 */

import {
	autoFrameAspect,
	resolveWebcamLayoutPreset,
	restingCompositionAspect,
	type WebcamLayoutPreset,
} from "@/lib/compositeLayout";
import { calculateEffectiveSourceDimensions } from "@/lib/exporter/mp4ExportSettings";
import {
	type AspectRatio,
	getAspectRatioValue,
	getNativeAspectRatioValue,
	toAspectRatioToken,
} from "@/utils/aspectRatioUtils";
import type { AxcutAsset, AxcutClip, AxcutDocument } from "../schema";
import { getEditorSettings } from "../store/editorSettings";
import { assetCameraSource } from "../timeline/camera";

export interface Dims {
	width: number;
	height: number;
}

/** Output frame used when a document has no usable asset dimensions at all. */
const FALLBACK_OUTPUT_DIMS: Dims = { width: 1920, height: 1080 };

/**
 * Round to the nearest even pixel, never below 2. H.264's 4:2:0 chroma plane is half-resolution
 * on both axes, so an odd width or height has no valid subsampling — the encoder rejects it or
 * silently pads. `calculateSourceDimensions` (mp4ExportSettings.ts) enforces this for the legacy
 * export path; `output` feeds the native compositor's `render_size` and needs the same guarantee.
 *
 * This only started to matter once the picker could store a non-preset shape: every fixed preset
 * happens to divide a normal capture's long side evenly (3840 → 2160, 2880, 2400, …), so bare
 * rounding was safe by accident. An "Original" token taken from one clip and applied to a
 * differently-shaped reference is not — e.g. `"683:384"` (a 1366x768 capture) against a 4K
 * reference gives 3840/(683/384) = 2158.946, which bare rounding turns into an odd 3840x2159.
 */
const toEvenPx = (value: number): number => Math.max(2, Math.round(value / 2) * 2);

/** One distinct native shape present on the timeline — an entry in the "Original" section. */
export interface NativeFormat {
	/** Reduced `"W:H"` token. This is what gets persisted when the user picks this entry. */
	token: AspectRatio;
	/** `token`'s numeric value, so callers don't re-parse. */
	ratio: number;
	/** Largest EFFECTIVE (post-crop) pixel dims among the clips sharing this shape. Label only —
	 *  the output size still follows `referenceClipDims` (see `pickOutputDims`). */
	width: number;
	height: number;
	/** How many timeline clips have this native shape. Drives the menu order and the
	 *  "N clips" hint shown only when the timeline is actually mixed. */
	clipCount: number;
}

/** Single "pick the largest/smallest by pixel count" reducer, shared by every size comparison
 *  instead of each one hand-rolling its own reduce + fallback. */
export function pickExtremeDims(items: Dims[], direction: "largest" | "smallest"): Dims | null {
	let best: Dims | null = null;
	for (const d of items) {
		if (d.width <= 0 || d.height <= 0) continue;
		if (!best) {
			best = d;
			continue;
		}
		const area = d.width * d.height;
		const bestArea = best.width * best.height;
		if (direction === "largest" ? area > bestArea : area < bestArea) best = d;
	}
	return best;
}

/**
 * One clip's EFFECTIVE (post-crop) pixel footprint, or null when its asset's dimensions aren't
 * known yet.
 *
 * Crop is stored on the CLIP (`clip.cropRegion`), never on the asset, so this question can only
 * be asked per clip: the same recording framed two ways contributes two different shapes to the
 * timeline. Everything that asks "what shape/size is this clip really?" resolves it here, so the
 * ratio picker cannot offer a shape the export would never produce — that split is exactly what
 * made a cropped 1920x1080 clip still advertise itself as "16:9" in the Original section while
 * the export dialog sized it off its true, much narrower footprint.
 *
 * Delegates the crop arithmetic to `calculateEffectiveSourceDimensions` (mp4ExportSettings) rather
 * than re-deriving it: that function also snaps to even pixels, which keeps the reduced `"W:H"`
 * token computed from these dims consistent with the size the encoder will actually be handed.
 */
function clipEffectiveDims(
	clip: AxcutClip,
	assetById: Map<string, AxcutAsset>,
	probedAssetDims: Record<string, Dims>,
): Dims | null {
	const asset = assetById.get(clip.assetId);
	if (!asset) return null;
	const rawWidth = asset.video?.width || probedAssetDims[asset.id]?.width || 0;
	const rawHeight = asset.video?.height || probedAssetDims[asset.id]?.height || 0;
	if (rawWidth <= 0 || rawHeight <= 0) return null;
	return calculateEffectiveSourceDimensions(rawWidth, rawHeight, clip.cropRegion);
}

/** Per-clip effective (post-crop) dims for the whole timeline — the true footprint each clip
 *  contributes. Falls back to `collectUsedAssetDims`'s raw dims while nothing has probed yet
 *  (crop can't be attributed without dimensions to apply it to), which is degraded but never
 *  blank. */
export function collectEffectiveClipDims(
	document: AxcutDocument,
	probedAssetDims: Record<string, Dims> = {},
): Dims[] {
	const assetById = new Map(document.assets.map((a) => [a.id, a]));
	const dims: Dims[] = [];
	for (const clip of document.timeline.clips) {
		const effective = clipEffectiveDims(clip, assetById, probedAssetDims);
		if (effective) dims.push(effective);
	}
	if (dims.length > 0) return dims;
	return collectUsedAssetDims(document, probedAssetDims);
}

/** Raw (uncropped) probed dims for every asset the timeline actually uses — falls back to ANY
 *  asset with known dims if none of the used ones have probed yet (still loading), so callers
 *  show *something* rather than blank. */
export function collectUsedAssetDims(
	document: AxcutDocument,
	probedAssetDims: Record<string, Dims> = {},
): Dims[] {
	const usedAssetIds = new Set(document.timeline.clips.map((c) => c.assetId));
	const dimsOf = (a: AxcutDocument["assets"][number]): Dims => ({
		width: a.video?.width || probedAssetDims[a.id]?.width || 0,
		height: a.video?.height || probedAssetDims[a.id]?.height || 0,
	});
	const used = document.assets.filter((a) => usedAssetIds.has(a.id)).map(dimsOf);
	if (used.some((d) => d.width > 0 && d.height > 0)) return used;
	return document.assets.map(dimsOf);
}

/**
 * The single clip footprint that sets the output's SIZE (and, for legacy "native", its SHAPE):
 * the largest EFFECTIVE (post-crop) footprint among the timeline's clips.
 *
 * Post-crop, not raw asset dims, because a crop is what a clip actually IS on the timeline — the
 * same thing the shape picker (`collectNativeFormats`) and the export dialog
 * (`collectEffectiveClipDims`) already measure. Sizing off raw dims here meant a 4K clip cropped
 * to half its width still rasterised at a 3840 long side while the export dialog already advertised
 * the smaller footprint: the same raw-vs-cropped split this module exists to close, just on size
 * instead of shape.
 *
 * The output SHAPE comes from the selected aspect ratio and no longer moves with the clip list.
 * Resolution still does, and since the compositor rasterises at the output geometry (compositor.rs
 * `render_size`) that costs something real: the largest cropped footprint on the timeline is the
 * size every frame is actually drawn at. Pinning resolution the way shape is now pinned is a
 * separate decision, deliberately not taken here.
 */
export function referenceClipDims(
	document: AxcutDocument,
	probedAssetDims: Record<string, Dims> = {},
): Dims {
	return (
		referenceClip(document, probedAssetDims)?.dims ??
		pickExtremeDims(collectUsedAssetDims(document, probedAssetDims), "largest") ??
		FALLBACK_OUTPUT_DIMS
	);
}

/** The clip behind `referenceClipDims`, for the questions its dims alone can't answer
 *  (does it carry a camera?). Same pick as `pickExtremeDims`: the first strictly largest. */
function referenceClip(
	document: AxcutDocument,
	probedAssetDims: Record<string, Dims>,
): { clip: AxcutClip; dims: Dims } | null {
	const assetById = new Map(document.assets.map((a) => [a.id, a]));
	let best: { clip: AxcutClip; dims: Dims } | null = null;
	for (const clip of document.timeline.clips) {
		const dims = clipEffectiveDims(clip, assetById, probedAssetDims);
		if (dims && (!best || dims.width * dims.height > best.dims.width * best.dims.height)) {
			best = { clip, dims };
		}
	}
	return best;
}

/**
 * The layout a clip actually gets: the project's preset, once the clip's own camera is
 * resolved. Same predicate as the scene (`clipHasCamera`), so Auto and the render agree on
 * which clips are laid out as a block.
 */
function clipLayoutPreset(
	clip: AxcutClip,
	assets: AxcutAsset[],
	layoutPreset: WebcamLayoutPreset,
): WebcamLayoutPreset {
	const asset = assets.find((a) => a.id === clip.assetId);
	return resolveWebcamLayoutPreset(layoutPreset, assetCameraSource(asset).path !== "");
}

/**
 * Whether Auto is offered: every clip on the timeline has the same ratio, crop included, and the
 * same layout once its own camera is resolved (picture-in-picture, a block layout, or no camera).
 * Anything else is a timeline no single frame suits, and which clip should win is the user's
 * call, made by picking a format, not a rule's.
 *
 * A clip without a camera counts as a different layout even under picture-in-picture, where the
 * frame's shape would not change: the bubble is part of the look, and Auto only frames a timeline
 * that looks the same throughout. Clips whose dimensions are not probed yet are skipped rather
 * than counted as different.
 */
export function isAutoFormatAvailable(
	document: AxcutDocument,
	probedAssetDims: Record<string, Dims> = {},
): boolean {
	const { webcamLayoutPreset } = getEditorSettings(document);
	const assetById = new Map(document.assets.map((a) => [a.id, a]));
	const compositions = new Set<string>();
	for (const clip of document.timeline.clips) {
		const dims = clipEffectiveDims(clip, assetById, probedAssetDims);
		if (!dims) continue;
		const layout = clipLayoutPreset(clip, document.assets, webcamLayoutPreset);
		compositions.add(`${toAspectRatioToken(dims.width, dims.height)}|${layout}`);
	}
	return compositions.size <= 1;
}

/**
 * What "Auto" resolves to: the frame shaped around the composition instead of the other way
 * round (`autoFrameAspect` over `restingCompositionAspect`).
 *
 * Auto is only offered while the timeline holds one composition (`isAutoFormatAvailable`), so
 * any clip describes it; `referenceClip`, the clip that sets the output size, is the one read.
 * A project saved on Auto can still become mixed later, when a clip of another shape is added:
 * the frame then stays on that same reference clip, so adding a smaller clip moves nothing, and
 * the menu shows Auto as unavailable until the user picks a format.
 *
 * Zoom, device frames, shadow and captions are left out on purpose: they happen inside the
 * frame, in every format alike, and would make the shape move with the playhead.
 */
function autoAspectRatioValue(document: AxcutDocument, probedAssetDims: Record<string, Dims>) {
	const settings = getEditorSettings(document);
	const reference = referenceClip(document, probedAssetDims);
	const preset = reference
		? clipLayoutPreset(reference.clip, document.assets, settings.webcamLayoutPreset)
		: "no-webcam";
	const screen = reference?.dims ?? referenceClipDims(document, probedAssetDims);
	return autoFrameAspect(restingCompositionAspect(screen, preset), settings.padding);
}

/**
 * The distinct native shapes of the clips on the timeline, most-used first.
 *
 * Deduped by REDUCED ratio, so 1920x1080 and 3840x2160 are the same entry (`"16:9"`) — the user
 * is choosing an output shape, not a resolution.
 *
 * Shapes come from each clip's EFFECTIVE (post-crop) footprint, not its asset's raw dimensions.
 * A crop changes what the clip IS on the timeline — it is the framing the preview shows and the
 * export encodes — so a 16:9 recording cropped to a vertical strip is no longer a 16:9 entry, and
 * two clips off the same asset cropped differently are two entries. Reading raw asset dims here
 * made the menu describe the recording rather than the clip, and so disagreed with the export
 * dialog, which has always sized off the crop (`collectEffectiveClipDims`).
 *
 * Returns `[]` for a document with no usable dimensions; a single entry is the common case and
 * should be presented as a plain "Original" row with no extra chrome.
 */
export function collectNativeFormats(
	document: AxcutDocument,
	probedAssetDims: Record<string, Dims> = {},
): NativeFormat[] {
	const assetById = new Map(document.assets.map((a) => [a.id, a]));
	const byToken = new Map<string, NativeFormat>();

	for (const clip of document.timeline.clips) {
		const effective = clipEffectiveDims(clip, assetById, probedAssetDims);
		if (!effective) continue;
		const { width, height } = effective;
		const token = toAspectRatioToken(width, height);
		if (!token) continue;

		const existing = byToken.get(token);
		if (!existing) {
			byToken.set(token, {
				token,
				ratio: width / height,
				width,
				height,
				clipCount: 1,
			});
			continue;
		}
		existing.clipCount += 1;
		// Keep the biggest representative so the label shows the best available resolution.
		if (width * height > existing.width * existing.height) {
			existing.width = width;
			existing.height = height;
		}
	}

	return [...byToken.values()].sort(
		(a, b) =>
			b.clipCount - a.clipCount ||
			b.width * b.height - a.width * a.height ||
			a.token.localeCompare(b.token),
	);
}

/**
 * Numeric ratio for a stored selection, with the document available to resolve `"auto"` and the
 * legacy `"native"` value. Every consumer that frames or sizes the output must go through this
 * rather than bare `getAspectRatioValue`, which has no document and falls back to 16/9.
 */
export function resolveAspectRatioValue(
	document: AxcutDocument | null | undefined,
	aspectRatio: AspectRatio,
	probedAssetDims: Record<string, Dims> = {},
): number {
	if (aspectRatio !== "native" && aspectRatio !== "auto") return getAspectRatioValue(aspectRatio);
	if (!document) return getAspectRatioValue(aspectRatio);
	if (aspectRatio === "auto") return autoAspectRatioValue(document, probedAssetDims);
	const reference = referenceClipDims(document, probedAssetDims);
	return getNativeAspectRatioValue(reference.width, reference.height);
}

/**
 * The output frame's dimensions, honoring the timeline's chosen aspect ratio.
 *
 * `SceneDescription.output` is the compositor's rasterisation geometry: it sizes `render_size`
 * (compositor.rs), which is the denominator of every normalised↔px conversion on the native side
 * and the resolution frames are actually drawn at. It is no longer a target that a fixed 16:9
 * canvas gets stretched onto — that canvas, and the per-layer undistort corrections it needed,
 * are gone. So this function is choosing real pixels, not a correction factor.
 *
 * Convention aligned on `calculateSourceDimensions` (mp4ExportSettings.ts): the reference asset's
 * longest side is the base, the other side is derived from the chosen ratio — and both axes are
 * snapped to even pixels (see `toEvenPx`), which is the part of that convention that actually
 * makes the result encodable. Snapping can move the realised ratio by well under a pixel's worth
 * of shape; being encodable at all takes precedence.
 */
export function pickOutputDims(
	document: AxcutDocument,
	aspectRatio: AspectRatio,
	probedAssetDims: Record<string, Dims> = {},
): Dims {
	const reference = referenceClipDims(document, probedAssetDims);
	const ratio = resolveAspectRatioValue(document, aspectRatio, probedAssetDims);
	const longSide = toEvenPx(Math.max(reference.width, reference.height));
	if (ratio >= 1) {
		return { width: longSide, height: toEvenPx(longSide / ratio) };
	}
	return { width: toEvenPx(longSide * ratio), height: longSide };
}
