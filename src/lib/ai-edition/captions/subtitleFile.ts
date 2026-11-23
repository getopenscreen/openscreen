// The captions as a subtitle file (.srt or .vtt), timed on the exported programme.
//
// The cues are the ones the burn-in draws (`deriveCaptionCues`), so the file and the burnt-in
// captions say the same words at the same moments. They come off the ruler, so each edge goes
// through the exporter's own projection (`projectRawTimelineSecToPlayback`): a trim is a hole
// the export skips, a speed region plays faster. A cue the cuts remove entirely leaves no entry.

import { projectRawTimelineSecToPlayback, readSpeedRegions } from "../document/timeline";
import type { AxcutDocument } from "../schema";
import { removedRawSpans, subtractRemoved } from "../timeline/programme-time";
import { deriveCaptionCues } from "./cues";
import { getCaptionSettings } from "./settings";
import { getCaptionTranslations } from "./translations";

export const SUBTITLE_FILE_FORMATS = ["srt", "vtt"] as const;
export type SubtitleFileFormat = (typeof SUBTITLE_FILE_FORMATS)[number];

export function isSubtitleFileFormat(value: string): value is SubtitleFileFormat {
	return (SUBTITLE_FILE_FORMATS as readonly string[]).includes(value);
}

/** One subtitle entry, in seconds of the exported video. */
export interface SubtitleCue {
	startSec: number;
	endSec: number;
	text: string;
}

/**
 * The captions' cues on the export's clock. `language` picks what they read: omitted, the
 * language the captions show; `null`, the transcript's own words; a code, that translation
 * layer. Written whether or not the captions are burnt in: the file does not depend on it.
 */
export function subtitleCuesForExport(
	document: AxcutDocument,
	language?: string | null,
): SubtitleCue[] {
	const settings = getCaptionSettings(document);
	const cues = deriveCaptionCues(
		document,
		{ ...settings, enabled: true, ...(language === undefined ? {} : { language }) },
		getCaptionTranslations(document),
	);
	const speed = readSpeedRegions(document);
	const { clips, trimRanges } = document.timeline;
	const removed = removedRawSpans(clips, trimRanges);
	const toExport = (sec: number) => projectRawTimelineSecToPlayback(clips, trimRanges, sec, speed);
	return cues
		.flatMap((cue) => {
			// Only what the export plays: a cut tail of the last clip projects past the film's end,
			// so a cue on it would outlast the video. A cue the cuts take whole leaves no entry.
			const kept = subtractRemoved(cue.startMs / 1000, cue.endMs / 1000, removed);
			if (kept.length === 0) return [];
			return [
				{
					startSec: toExport(kept[0].startSec),
					endSec: toExport(kept[kept.length - 1].endSec),
					// A blank line ends an entry in both formats.
					text: cue.text.replace(/\n\s*\n/g, "\n").trim(),
				},
			];
		})
		.filter((cue) => cue.endSec - cue.startSec >= 0.001 && cue.text.length > 0);
}

/** `HH:MM:SS,mmm` for SRT, `HH:MM:SS.mmm` for WebVTT. */
function timestamp(sec: number, format: SubtitleFileFormat): string {
	const ms = Math.max(0, Math.round(sec * 1000));
	const pad = (n: number, width = 2) => String(n).padStart(width, "0");
	const hh = pad(Math.floor(ms / 3_600_000));
	const mm = pad(Math.floor(ms / 60_000) % 60);
	const ss = pad(Math.floor(ms / 1000) % 60);
	return `${hh}:${mm}:${ss}${format === "srt" ? "," : "."}${pad(ms % 1000, 3)}`;
}

/** WebVTT reads `<` as the start of a tag and `&` as the start of an entity: a caption that
 *  says "R&D" or "a < b" is written with entities, or a player drops what follows. SRT has no
 *  such rule. */
function vttText(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The file's text: numbered entries for SRT, a `WEBVTT` header then entries for WebVTT. */
export function formatSubtitleFile(cues: SubtitleCue[], format: SubtitleFileFormat): string {
	const entries = cues.map((cue, index) => {
		const timing = `${timestamp(cue.startSec, format)} --> ${timestamp(cue.endSec, format)}`;
		return format === "srt"
			? `${index + 1}\n${timing}\n${cue.text}`
			: `${timing}\n${vttText(cue.text)}`;
	});
	const blocks = format === "vtt" ? ["WEBVTT", ...entries] : entries;
	return `${blocks.join("\n\n")}\n`;
}
