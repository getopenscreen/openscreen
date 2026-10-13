import {
	type CaptionCue,
	deriveCaptionCues,
	getCaptionSettings,
	getCaptionTranslations,
} from "../captions";
import type { AxcutDocument } from "../schema";
import { getEditorSettings } from "../store/editorSettings";
import { keptRawSpans } from "../timeline/programme-time";
import { resolveAspectRatioValue } from "./outputFormat";
import { projectRawTimelineSecToPlayback, readSpeedRegions } from "./timeline";

/** Subtitle sidecar cues in the exported film's clock, with the same caption
 * language/lane/grouping as the preview. A sidecar is useful even when burn-in is
 * disabled, so only the display toggle is overridden, without editing the project. */
export function deriveTimelineSrtCues(document: AxcutDocument | null): CaptionCue[] {
	if (!document) return [];
	const aspect = resolveAspectRatioValue(document, getEditorSettings(document).aspectRatio);
	const settings = { ...getCaptionSettings(document, aspect), enabled: true };
	const rawCues = deriveCaptionCues(document, settings, getCaptionTranslations(document));
	const { clips, trimRanges } = document.timeline;
	const kept = keptRawSpans(clips, trimRanges);
	// The native speed resolver gives the earliest-starting region precedence.
	const speeds = [...readSpeedRegions(document)].sort((a, b) => a.startMs - b.startMs);
	const result: CaptionCue[] = [];
	for (const cue of rawCues) {
		for (const span of kept) {
			const start = Math.max(cue.startMs / 1000, span.startSec);
			const end = Math.min(cue.endMs / 1000, span.endSec);
			if (end <= start) continue;
			const startMs = Math.round(
				projectRawTimelineSecToPlayback(clips, trimRanges, start, speeds) * 1000,
			);
			const endMs = Math.round(
				projectRawTimelineSecToPlayback(clips, trimRanges, end, speeds) * 1000,
			);
			if (endMs <= startMs) continue;
			result.push({ ...cue, id: `${cue.id}-${result.length}`, startMs, endMs });
		}
	}
	return result.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}
