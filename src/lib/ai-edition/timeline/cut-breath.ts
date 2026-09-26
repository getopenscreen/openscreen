// Silence cuts that breathe.
//
// A cut that swallows the whole gap between two words glues the last syllable to the
// next word. Speech needs a little air on each side, so the edge of a cut that sits in a
// gap next to KEPT speech is pulled back by `CUT_BREATH_SEC`, never past the middle of
// that gap. An edge that touches removed material, or sits inside a word, is left where
// it is: breathing there would only leave a sliver of kept media between two cuts.
//
// Only cuts authored from speech go through this (the transcript pane, the agent). A cut
// drawn on the timeline by hand is the user's and is never reshaped.

import type { Interval } from "./intervals";

/** Air kept between a cut and the speech it touches, per side (~140 ms across a cut). */
export const CUT_BREATH_SEC = 0.07;

/** Frame rate {@link mergeCloseCuts} assumes when the asset reports none (audio, unprobed). */
const FALLBACK_FPS = 30;

export interface BreathWord extends Interval {
	/** Whether this word is still in the film, BEFORE the cut being shaped is applied. */
	kept: boolean;
}

const EPS = 1e-6;

/**
 * `cut` with each edge that sits in a gap next to a kept word pulled back to leave
 * `breathSec` of that gap, capped at the gap's middle. All times on one source clock.
 * Words with no duration carry no audio and are ignored. A side the cut is too short to
 * give back is left alone.
 */
export function breatheCut(
	cut: Interval,
	words: readonly BreathWord[],
	breathSec = CUT_BREATH_SEC,
): Interval {
	const spoken = words.filter((w) => w.endSec > w.startSec);
	let startSec = cut.startSec;
	let endSec = cut.endSec;

	// Start edge: the word that ends last at or before it, and the gap that follows it.
	const before = spoken
		.filter((w) => w.endSec <= cut.startSec + EPS)
		.reduce<BreathWord | null>((a, w) => (!a || w.endSec > a.endSec ? w : a), null);
	if (before?.kept) {
		const nextStarts = spoken.filter((w) => w.startSec >= before.endSec - EPS && w !== before);
		const gapEnd = Math.min(...nextStarts.map((w) => w.startSec));
		// gapEnd below the edge means the edge is inside a word, not in the gap.
		if (gapEnd >= cut.startSec - EPS) {
			const target = Math.min(before.endSec + breathSec, (before.endSec + gapEnd) / 2);
			if (target > startSec && target < cut.endSec) startSec = target;
		}
	}

	// End edge, mirrored: the word that starts first at or after it, and the gap before it.
	const after = spoken
		.filter((w) => w.startSec >= cut.endSec - EPS)
		.reduce<BreathWord | null>((a, w) => (!a || w.startSec < a.startSec ? w : a), null);
	if (after?.kept) {
		const prevEnds = spoken.filter((w) => w.endSec <= after.startSec + EPS && w !== after);
		const gapStart = Math.max(...prevEnds.map((w) => w.endSec));
		if (gapStart <= cut.endSec + EPS) {
			const target = Math.max(after.startSec - breathSec, (gapStart + after.startSec) / 2);
			if (target < endSec && target > cut.startSec) endSec = target;
		}
	}

	return endSec > startSec ? { startSec, endSec } : cut;
}

/**
 * `cut` with an edge snapped onto a neighbouring cut of the SAME clip when the media
 * left between them would be shorter than two frames — a one-frame flash of picture
 * between two cuts reads as a glitch, never as content. `neighbours` are that clip's
 * existing cuts, on the same clock as `cut`; `fps` is the asset's, 0 when unknown.
 */
export function mergeCloseCuts(cut: Interval, neighbours: readonly Interval[], fps = 0): Interval {
	const maxGap = 2 / (fps > 0 ? fps : FALLBACK_FPS);
	let { startSec, endSec } = cut;
	for (const n of neighbours) {
		const gapBefore = cut.startSec - n.endSec;
		if (gapBefore > 0 && gapBefore < maxGap) startSec = Math.min(startSec, n.endSec);
		const gapAfter = n.startSec - cut.endSec;
		if (gapAfter > 0 && gapAfter < maxGap) endSec = Math.max(endSec, n.startSec);
	}
	return { startSec, endSec };
}
