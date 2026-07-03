// Aggregated transcript view for the right pane — joins the per-asset
// transcripts into a single flowing read of every clip on the timeline,
// in timeline order, with removed words + trim durations inline.
//
// ponytail: pure functions, no React. The pane renders the result.

import type { AxcutAsset, AxcutClip, AxcutTranscript, AxcutWord } from "../schema";

/** A contiguous run of removed words inside one clip's source range. */
export interface TrimRange {
	/** Index of the first removed word in `clipWords`. */
	startWordIndex: number;
	/** Inclusive index of the last removed word in `clipWords`. */
	endWordIndex: number;
	/** Wall-clock seconds from the first removed word's start to the last removed word's end. */
	durationSec: number;
}

/** One word in the clip's source range, tagged kept / removed + filler. */
export interface ClipWord {
	word: AxcutWord;
	/** Whether the word is in `clip.wordRefs` (kept on the timeline). */
	kept: boolean;
	/** Heuristic filler — "okay", "um", etc. — rendered as a soft-red pill. */
	filler: boolean;
}

/** One clip's contribution to the aggregated flow. */
export interface ClipSection {
	clip: AxcutClip;
	asset: AxcutAsset | null;
	transcript: AxcutTranscript | null;
	words: ClipWord[];
	trims: TrimRange[];
}

// ponytail: hard-coded English filler list. Multi-lingual filler detection is
// out of scope; if the user transcribes in another language the chip styling
// degrades to "no fillers flagged" which is fine. Keep the list small —
// false positives on the chip look worse than missing a real filler.
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

/** Words of `transcript` whose center falls inside `[startSec, endSec]`. */
function wordsInRange(transcript: AxcutTranscript, startSec: number, endSec: number): AxcutWord[] {
	return transcript.words.filter((w) => w.endSec > startSec && w.startSec < endSec);
}

/**
 * Build one clip section: every transcript word inside the clip's source
 * range, tagged kept/removed, plus the contiguous removed ranges that turn
 * into `<span class="hl">…</span><span class="tc-pill">Xs</span>` blocks.
 *
 * ponytail: clips created via split/insert in `useTimeline.ts` start with
 * an empty `wordRefs` (the operators don't recompute the list). Without
 * a default that'd render every word as trimmed. Empty wordRefs → every
 * word in the clip's source range is kept, which matches Axcut's model
 * where a fresh clip is by-default untrimmed.
 */
export function buildClipSection(
	clip: AxcutClip,
	transcript: AxcutTranscript | null,
	asset: AxcutAsset | null,
): ClipSection {
	const words = transcript
		? wordsInRange(transcript, clip.sourceStartSec, clip.sourceEndSec ?? Infinity)
		: [];
	// ponytail: empty wordRefs means "no explicit cuts yet" — keep every word.
	// Non-empty wordRefs is the authoritative keep-list (from `replaceTimeline`).
	const kept = clip.wordRefs.length === 0 ? null : new Set(clip.wordRefs);
	const tagged: ClipWord[] = words.map((word) => ({
		word,
		kept: kept === null ? true : kept.has(word.id),
		filler: isFiller(word.text),
	}));

	const trims: TrimRange[] = [];
	let runStart = -1;
	let runEnd = -1;
	let runMinStart = 0;
	let runMaxEnd = 0;
	const flush = () => {
		if (runStart >= 0) {
			trims.push({
				startWordIndex: runStart,
				endWordIndex: runEnd,
				durationSec: Math.max(0, runMaxEnd - runMinStart),
			});
		}
		runStart = -1;
		runEnd = -1;
		runMinStart = 0;
		runMaxEnd = 0;
	};
	tagged.forEach((cw, i) => {
		if (cw.kept) {
			flush();
			return;
		}
		if (runStart < 0) {
			runStart = i;
			runMinStart = cw.word.startSec;
		}
		runEnd = i;
		runMaxEnd = cw.word.endSec;
	});
	flush();

	return { clip, asset, transcript, words: tagged, trims };
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
): ClipSection[] {
	const byId = new Map(transcripts.map((t) => [t.assetId, t]));
	const assetById = new Map(assets.map((a) => [a.id, a]));
	return clips.map((clip) =>
		buildClipSection(clip, byId.get(clip.assetId) ?? null, assetById.get(clip.assetId) ?? null),
	);
}
