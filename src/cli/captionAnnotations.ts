// CLI-only: the v4 editor renders captions natively, but `openscreen captions`
// still writes caption *annotations* into .openscreen projects. Only the
// annotation conversion lives here — the segment grouping/dedupe helpers come
// from the live captioning module so the CLI can't drift from the editor.

import type { AnnotationRegion, AnnotationTextStyle } from "@/components/video-editor/types";
import {
	captionBackgroundCss,
	captionSafeColumn,
	DEFAULT_CAPTION_SETTINGS,
	defaultCaptionInsetY,
} from "@/lib/ai-edition/captions/settings";
import {
	type CaptionSegmentLayoutOptions,
	dedupeAdjacentCaptionRepeats,
	finalizeCaptionSegmentsForPlayback,
	groupPhraseCaptionSegmentsIntoLines,
	groupTimedCaptionWordsIntoLines,
} from "@/lib/captioning/annotationsFromCaptions";
import type { CaptionSegment } from "@/lib/captioning/transcribe";

// The look and place of the editor's own captions (`DEFAULT_CAPTION_SETTINGS`): bold 48 px
// white on a 55% black plate, in the landscape safe column, just off the bottom edge. The CLI
// used to write 24 px regular text on no plate, which read as faint over any bright frame.
// `.openscreen` projects carry no transcript, so the CLI cannot write the editor's transcript-
// driven captions; matching their appearance is what keeps the two from looking different.
const LANDSCAPE = 16 / 9;
const CAPTION_HEIGHT = 12;
const CAPTION_COLUMN = captionSafeColumn(LANDSCAPE);

const CAPTION_POSITION = {
	x: CAPTION_COLUMN.x,
	y: 100 - CAPTION_HEIGHT - defaultCaptionInsetY(LANDSCAPE),
};

const CAPTION_SIZE = { width: CAPTION_COLUMN.width, height: CAPTION_HEIGHT };

const CAPTION_STYLE: AnnotationTextStyle = {
	color: DEFAULT_CAPTION_SETTINGS.color,
	backgroundColor: captionBackgroundCss(DEFAULT_CAPTION_SETTINGS),
	fontSize: DEFAULT_CAPTION_SETTINGS.fontSize,
	fontFamily: DEFAULT_CAPTION_SETTINGS.fontFamily,
	fontWeight: DEFAULT_CAPTION_SETTINGS.fontWeight,
	fontStyle: "normal",
	textDecoration: "none",
	textAlign: "center",
};

export function captionSegmentsToAnnotationRegions(
	segments: CaptionSegment[],
	startNumericId: number,
	startZIndex: number,
	layout?: CaptionSegmentLayoutOptions,
): AnnotationRegion[] {
	// Don't echo-collapse raw word tokens before grouping: repeated words ("I … I") share a
	// normalized key and would merge spans while keeping only the first token's text.
	const minW = layout?.minWordsPerCaption ?? DEFAULT_CAPTION_SETTINGS.minWordsPerLine;
	const maxW = layout?.maxWordsPerCaption ?? DEFAULT_CAPTION_SETTINGS.maxWordsPerLine;
	const granularity = layout?.timestampGranularity ?? "word";

	const grouped =
		granularity === "phrase"
			? groupPhraseCaptionSegmentsIntoLines(segments, minW, maxW)
			: groupTimedCaptionWordsIntoLines(segments, minW, maxW);

	const finalized = finalizeCaptionSegmentsForPlayback(dedupeAdjacentCaptionRepeats(grouped));

	let nid = startNumericId;
	let z = startZIndex;
	return finalized.map((seg) => {
		const startMs = Math.round(seg.startSec * 1000);
		const endMs = Math.max(Math.round(seg.endSec * 1000), startMs + 1);
		return {
			id: `annotation-${nid++}`,
			startMs,
			endMs,
			type: "text",
			content: seg.text,
			annotationSource: "auto-caption",
			position: { ...CAPTION_POSITION },
			size: { ...CAPTION_SIZE },
			style: { ...CAPTION_STYLE },
			zIndex: z++,
		};
	});
}
