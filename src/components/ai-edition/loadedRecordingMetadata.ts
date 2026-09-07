import { applyProbedDuration, replaceTimeline } from "@/lib/ai-edition/document/timeline";
import type { AxcutDocument } from "@/lib/ai-edition/schema";

const FALLBACK_CLIP_DURATION_SEC = 60;

export function isFiniteMediaDuration(durationSec: number): boolean {
	return Number.isFinite(durationSec) && durationSec > 0;
}

/** Drop a queued `loadedmetadata` that no longer belongs to the open project. */
export function isLoadedMetadataForDocument(
	document: AxcutDocument | null,
	originatingProjectId: string | undefined,
): document is AxcutDocument {
	return (
		document != null && originatingProjectId != null && document.project.id === originatingProjectId
	);
}

/**
 * Fold a `<video>` duration into the document the way the editor does on
 * `loadedmetadata`.
 *
 * A real length writes `asset.durationSec` and seeds or repairs the timeline.
 * MediaRecorder WebMs report NaN until the EBML fix lands — those still get a
 * 60s clip so `replaceTimeline` has something to clamp against, but the 60 is
 * not persisted as a probed duration. Auto-zoom waits for a later finite probe.
 */
export function documentAfterLoadedMetadata(
	document: AxcutDocument,
	durationSec: number,
	assetId: string,
): AxcutDocument {
	const finite = isFiniteMediaDuration(durationSec);
	const seedSec = finite ? durationSec : FALLBACK_CLIP_DURATION_SEC;

	if (document.timeline.clips.length === 0) {
		const primaryAssetId = document.project.primaryAssetId ?? document.assets[0]?.id;
		// The seed belongs to the primary asset: `replaceTimeline` pins the clip it
		// builds to `primaryAssetId ?? assets[0]`, and the length comes from THIS
		// event. So an event from any other asset would file one video's duration
		// under another video's id. The primary's own event does the seeding, and
		// Preview mounts the primary while the timeline is empty so that event is
		// the one that arrives.
		if (!primaryAssetId || primaryAssetId !== assetId) return document;
		const withSeedDuration: AxcutDocument = {
			...document,
			assets: document.assets.map((asset) =>
				asset.id === primaryAssetId ? { ...asset, durationSec: seedSec } : asset,
			),
		};
		const withClip = replaceTimeline(
			withSeedDuration,
			[{ startSec: 0, endSec: seedSec }],
			"Auto-created full-duration clip",
		);
		if (finite) return withClip;
		return {
			...withClip,
			assets: withClip.assets.map((asset) => {
				if (asset.id !== primaryAssetId) return asset;
				const { durationSec: _fallback, ...rest } = asset;
				return rest;
			}),
		};
	}

	if (!finite) return document;
	return applyProbedDuration(document, assetId, durationSec);
}
