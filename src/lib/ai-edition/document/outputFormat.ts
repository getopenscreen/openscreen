/**
 * The ONE place that decides the scene's output geometry from a document.
 *
 * Three call sites used to hand-roll "which asset is the reference, and what ratio does that
 * make" independently — `referenceAssetDims`/`pickOutputDims` (native/sceneDescription.ts, feeds
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
	type AspectRatio,
	getAspectRatioValue,
	getNativeAspectRatioValue,
	toAspectRatioToken,
} from "@/utils/aspectRatioUtils";
import type { AxcutDocument } from "../schema";

export interface Dims {
	width: number;
	height: number;
}

/** Output frame used when a document has no usable asset dimensions at all. */
const FALLBACK_OUTPUT_DIMS: Dims = { width: 1920, height: 1080 };

/** One distinct native shape present on the timeline — an entry in the "Original" section. */
export interface NativeFormat {
	/** Reduced `"W:H"` token. This is what gets persisted when the user picks this entry. */
	token: AspectRatio;
	/** `token`'s numeric value, so callers don't re-parse. */
	ratio: number;
	/** Largest pixel dims among the clips sharing this shape. Label only — the output size
	 *  still follows `referenceAssetDims` (see `pickOutputDims`). */
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
 * The asset whose pixel dimensions set the output's SIZE: largest pixel area among the assets
 * the timeline uses. This is a size policy only — the output SHAPE comes from the selected
 * aspect ratio and no longer moves with the clip list.
 *
 * Resolution still does, and since `rasterise at the output geometry` (compositor.rs
 * `render_size`) that now costs something real: `output` sets the size the compositor actually
 * rasterises at, not just a final rescale off a fixed 1080p target. Adding a 4K rush to a 1080p
 * project therefore makes every frame rasterise at 4K. Pinning resolution the way shape is now
 * pinned is a separate decision, deliberately not taken here.
 */
export function referenceAssetDims(
	document: AxcutDocument,
	probedAssetDims: Record<string, Dims> = {},
): Dims {
	return (
		pickExtremeDims(collectUsedAssetDims(document, probedAssetDims), "largest") ??
		FALLBACK_OUTPUT_DIMS
	);
}

/**
 * The distinct native shapes of the clips on the timeline, most-used first.
 *
 * Deduped by REDUCED ratio, so 1920x1080 and 3840x2160 are the same entry (`"16:9"`) — the user
 * is choosing an output shape, not a resolution. Uses each clip's raw asset dims, ignoring the
 * per-clip crop: "Original" means the recording's own format, which is a different question from
 * how a given clip happens to be framed.
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
		const asset = assetById.get(clip.assetId);
		if (!asset) continue;
		const width = asset.video?.width || probedAssetDims[asset.id]?.width || 0;
		const height = asset.video?.height || probedAssetDims[asset.id]?.height || 0;
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
 * Numeric ratio for a stored selection, with the document available to resolve the legacy
 * `"native"` value. Every consumer that frames or sizes the output must go through this rather
 * than bare `getAspectRatioValue`, which has no document and falls back to 16/9.
 */
export function resolveAspectRatioValue(
	document: AxcutDocument | null | undefined,
	aspectRatio: AspectRatio,
	probedAssetDims: Record<string, Dims> = {},
): number {
	if (aspectRatio !== "native") return getAspectRatioValue(aspectRatio);
	if (!document) return getAspectRatioValue("native");
	const reference = referenceAssetDims(document, probedAssetDims);
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
 * longest side is the base, the other side is derived from the chosen ratio.
 */
export function pickOutputDims(
	document: AxcutDocument,
	aspectRatio: AspectRatio,
	probedAssetDims: Record<string, Dims> = {},
): Dims {
	const reference = referenceAssetDims(document, probedAssetDims);
	const ratio = resolveAspectRatioValue(document, aspectRatio, probedAssetDims);
	const longSide = Math.max(reference.width, reference.height);
	if (ratio >= 1) {
		return { width: longSide, height: Math.round(longSide / ratio) };
	}
	return { width: Math.round(longSide * ratio), height: longSide };
}
