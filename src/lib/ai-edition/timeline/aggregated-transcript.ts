// Aggregated transcript view for the right pane — joins the per-asset
// transcripts into a single flowing read of every clip on the timeline.
//
// ponytail: pure functions, no React. Mirrors axcut's
// apps/web/src/components/CurrentTranscriptView.tsx#buildClipTranscriptProjections
// + buildTranscriptRuns. Word kept/removed is decided by whether the word
// falls inside one of the document's `timeline.skipRanges` for the same
// asset — not by `clip.wordRefs` (which is now only used by the timeline
// retime math, not by the right pane).

import type { AxcutAsset, AxcutClip, AxcutSkipRange, AxcutTranscript, AxcutWord } from "../schema";

/** A contiguous run of removed words inside one clip's source range. */
export interface SkipRun {
	/** Id of the skip range this run came from (used by the bin-icon restore). */
	skipId: string;
	/** Index of the first removed word in `words`. */
	startWordIndex: number;
	/** Inclusive index of the last removed word in `words`. */
	endWordIndex: number;
	/** Asset id the skip belongs to. */
	assetId: string;
	/** Wall-clock seconds from the first removed word's start to the last removed word's end. */
	durationSec: number;
}

/** One word in the clip's source range, tagged kept / removed + filler. */
export interface ClipWord {
	word: AxcutWord;
	/** Whether the word is inside a skipRange for this clip's asset. */
	kept: boolean;
	/** Id of the skip range that removed this word, if any. */
	skipId: string | null;
	/** Heuristic filler — "okay", "um", etc. — rendered as a soft-red pill. */
	filler: boolean;
}

/** One clip's contribution to the aggregated flow. */
export interface ClipSection {
	clip: AxcutClip;
	asset: AxcutAsset | null;
	transcript: AxcutTranscript | null;
	words: ClipWord[];
	skipRuns: SkipRun[];
}

const FILLER_WORDS = new Set([
	"um",
	"uh",
	"er",
	"ah",
	"hm",
	"hmm",
	"okay",
	"ok",
	"so",
	"well",
	"like",
	"right",
	"yeah",
	"yep",
	"kinda",
]);

function isFiller(text: string): boolean {
	const cleaned = text.toLowerCase().replace(/[.,!?;:'"]/g, "");
	return FILLER_WORDS.has(cleaned);
}

function wordsInRange(transcript: AxcutTranscript, startSec: number, endSec: number): AxcutWord[] {
	return transcript.words.filter((w) => w.endSec > startSec && w.startSec < endSec);
}

/** Find the skip range covering this word's center (returns the deepest match). */
function findCoveringSkip(word: AxcutWord, skipRanges: AxcutSkipRange[]): AxcutSkipRange | null {
	const center = (word.startSec + word.endSec) / 2;
	for (const skip of skipRanges) {
		if (center >= skip.startSec && center <= skip.endSec) return skip;
	}
	return null;
}

/**
 * Build one clip section. Words inside the clip's source range that fall
 * inside any skip range for the same asset are marked removed; the rest
 * are kept. Contiguous removed words from the same skip range group into
 * one `SkipRun` (for the trim-duration pill + bin-icon restore).
 */
export function buildClipSection(
	clip: AxcutClip,
	transcript: AxcutTranscript | null,
	asset: AxcutAsset | null,
	skipRanges: AxcutSkipRange[],
): ClipSection {
	const clipSkips = skipRanges.filter(
		(skip) =>
			skip.assetId === clip.assetId &&
			skip.endSec > clip.sourceStartSec &&
			skip.startSec < (clip.sourceEndSec ?? Infinity),
	);

	const words = transcript
		? wordsInRange(transcript, clip.sourceStartSec, clip.sourceEndSec ?? Infinity)
		: [];
	const tagged: ClipWord[] = words.map((word) => {
		const covering = findCoveringSkip(word, clipSkips);
		return {
			word,
			kept: covering === null,
			skipId: covering?.id ?? null,
			filler: isFiller(word.text),
		};
	});

	const skipRuns: SkipRun[] = [];
	let runStart = -1;
	let runEnd = -1;
	let runSkipId = "";
	let runMinStart = 0;
	let runMaxEnd = 0;
	const flush = () => {
		if (runStart >= 0) {
			skipRuns.push({
				skipId: runSkipId,
				assetId: clip.assetId,
				startWordIndex: runStart,
				endWordIndex: runEnd,
				durationSec: Math.max(0, runMaxEnd - runMinStart),
			});
		}
		runStart = -1;
		runEnd = -1;
		runSkipId = "";
		runMinStart = 0;
		runMaxEnd = 0;
	};
	tagged.forEach((cw, i) => {
		if (cw.kept) {
			flush();
			return;
		}
		// Split the run if the skip range id changes (overlapping skips).
		if (runStart >= 0 && cw.skipId !== runSkipId) {
			flush();
		}
		if (runStart < 0) {
			runStart = i;
			runMinStart = cw.word.startSec;
			runSkipId = cw.skipId ?? "";
		}
		runEnd = i;
		runMaxEnd = Math.max(runMaxEnd, cw.word.endSec);
	});
	flush();

	return { clip, asset, transcript, words: tagged, skipRuns };
}

/**
 * Build every clip section in timeline order. Clips without a matching
 * transcript still render (asset label + an empty flow) so the user sees
 * the clip exists but no transcript is available for it yet.
 */
export function buildAggregatedSections(
	clips: AxcutClip[],
	transcripts: AxcutTranscript[],
	assets: AxcutAsset[],
	skipRanges: AxcutSkipRange[],
): ClipSection[] {
	const transcriptById = new Map(transcripts.map((t) => [t.assetId, t]));
	const assetById = new Map(assets.map((a) => [a.id, a]));
	return clips.map((clip) =>
		buildClipSection(
			clip,
			transcriptById.get(clip.assetId) ?? null,
			assetById.get(clip.assetId) ?? null,
			skipRanges,
		),
	);
}
