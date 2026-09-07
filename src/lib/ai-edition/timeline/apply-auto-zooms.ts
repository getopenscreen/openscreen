// Shared auto-zoom apply path: the HUD toggle / fresh-recording import and the
// timeline wand both end here. Suggestion math stays in zoom-suggestions.ts;
// this file only collects per-asset telemetry and appends the resulting regions.

import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import { createId } from "../document/ids";
import type { AxcutDocument } from "../schema";
import { anchorRegionsWithDerivedMs } from "./timelineMap";
import { type AutoZoomSuggestion, buildAutoZoomSuggestionsForClips } from "./zoom-suggestions";

export const AUTO_ZOOM_DEFAULT_DURATION_MS = 2000;

export async function collectAutoZoomSuggestionsForDocument(
	document: AxcutDocument,
	getTelemetry: (videoPath: string) => Promise<CursorTelemetryPoint[] | null | undefined>,
): Promise<AutoZoomSuggestion[]> {
	const existingRegions = document.zoomRanges.map((region) => ({
		startMs: region.startMs,
		endMs: region.endMs,
	}));
	const assetsWithClips = document.assets.filter(
		(asset) =>
			asset.kind === "video" &&
			asset.originalPath &&
			document.timeline.clips.some((clip) => clip.assetId === asset.id),
	);
	const perSource = await Promise.all(
		assetsWithClips.map(async (asset) => {
			const telemetry = (await getTelemetry(asset.originalPath)) ?? [];
			return buildAutoZoomSuggestionsForClips({
				cursorTelemetry: telemetry,
				assetId: asset.id,
				clips: document.timeline.clips,
				existingRegions,
				defaultDurationMs: AUTO_ZOOM_DEFAULT_DURATION_MS,
			});
		}),
	);
	return perSource.flat();
}

export function appendAutoZoomSuggestions(
	document: AxcutDocument,
	suggestions: AutoZoomSuggestion[],
	makeId: (prefix: string) => string = createId,
): AxcutDocument {
	if (suggestions.length === 0) return document;
	const anchored = suggestions.flatMap((suggestion) =>
		anchorRegionsWithDerivedMs(
			[
				{
					id: makeId("zoom"),
					startMs: Math.round(suggestion.span.start),
					endMs: Math.round(suggestion.span.end),
					depth: 3 as const,
					focus: { cx: suggestion.focus.cx, cy: suggestion.focus.cy },
					focusMode: "auto" as const,
				},
			],
			document.timeline.clips,
			() => makeId("zoom"),
		),
	);
	return {
		...document,
		zoomRanges: [...document.zoomRanges, ...anchored] as AxcutDocument["zoomRanges"],
	};
}
