// One walk over a voice-over take (issues #560 and #1195).
//
// Imported voiceovers keep their source clock running under a cut: they were recorded against
// the raw timeline, so words after the cut keep their original source positions. Live-recorded
// takes use the playback map captured at recording time, because the recorder never captured the
// skipped intervals. Current cuts still mute either kind of take.
//
// An insertion inside the take used to add time here. It does not any more: an
// insertion IS a track of its own (`document/insertionTrack.ts`), so each resulting pill plays
// an uninterrupted stretch of its file. Imported takes consume raw time; recorded takes consume
// output time on kept stretches. Neither walk needs a second pass for insertions.
//
// It runs on the PILL, never on a stored fragment. The document stores one fragment per clip
// a take covers, and the mixer sums with `+=` at an absolute offset — so a fragment-wise walk
// ships a take playing on top of itself. `anchorAudioTrackFragments` is untouched and stays
// correct for the music and loop paths that still read it.

import type { AxcutAudioTrack } from "../schema";
import { outputDurationOfRawSpan } from "./playback-time";
import type { RemovedRawSpan } from "./programme-time";

/** One stretch of a take, in playback order. */
export interface TakePiece {
	/**
	 * `play` — the file is heard. `removed` — the film lost this stretch, so the take is
	 * silent through it. Recorded takes hold their source clock; imported takes keep theirs moving.
	 */
	kind: "play" | "removed";
	/** Stored RAW ruler seconds. */
	rawStartSec: number;
	rawEndSec: number;
	/** The take's own file. */
	sourceStartSec: number;
	sourceEndSec: number;
}

const EPSILON_SEC = 1e-9;

/** The take, stretch by stretch, in playback order: what is heard, and what a cut mutes. */
export function takeProgramme(
	pill: Pick<AxcutAudioTrack, "startMs" | "endMs" | "offsetMs" | "recordingPlaybackMap">,
	removed: readonly RemovedRawSpan[],
): TakePiece[] {
	const rawStart = pill.startMs / 1000;
	const rawEnd = Math.max(rawStart, pill.endMs / 1000);
	const sourceStart = Math.max(0, pill.offsetMs / 1000);

	const cuts = [...removed]
		.filter((span) => span.endSec > rawStart && span.startSec < rawEnd)
		.sort((a, b) => a.startSec - b.startSec);

	if (pill.recordingPlaybackMap) {
		const recordingCuts = pill.recordingPlaybackMap.removedRawSpans.filter(
			(span) => span.endSec > rawStart && span.startSec < rawEnd,
		);
		const boundaries = new Set<number>([rawStart, rawEnd]);
		for (const span of [...cuts, ...recordingCuts]) {
			if (span.startSec > rawStart && span.startSec < rawEnd) boundaries.add(span.startSec);
			if (span.endSec > rawStart && span.endSec < rawEnd) boundaries.add(span.endSec);
		}
		for (const region of pill.recordingPlaybackMap.speedRegions) {
			for (const edge of [region.startMs / 1000, region.endMs / 1000]) {
				if (edge > rawStart && edge < rawEnd) boundaries.add(edge);
			}
		}
		const edges = [...boundaries].sort((a, b) => a - b);
		const pieces: TakePiece[] = [];
		let source = sourceStart;
		for (let i = 0; i < edges.length - 1; i++) {
			const raw = edges[i];
			const to = edges[i + 1];
			if (to - raw <= EPSILON_SEC) continue;
			const mid = (raw + to) / 2;
			const sourceRemoved = recordingCuts.some((span) => mid >= span.startSec && mid < span.endSec);
			const currentRemoved = cuts.some((span) => mid >= span.startSec && mid < span.endSec);
			const sourceEnd = sourceRemoved
				? source
				: source + outputDurationOfRawSpan(raw, to, pill.recordingPlaybackMap.speedRegions);
			pieces.push({
				kind: sourceRemoved || currentRemoved ? "removed" : "play",
				rawStartSec: raw,
				rawEndSec: to,
				sourceStartSec: source,
				sourceEndSec: sourceEnd,
			});
			source = sourceEnd;
		}
		return pieces;
	}

	const pieces: TakePiece[] = [];
	let raw = rawStart;
	// The source clock never parks, so it is a plain shift of the raw one.
	const push = (kind: TakePiece["kind"], to: number) => {
		if (to - raw <= EPSILON_SEC) return;
		pieces.push({
			kind,
			rawStartSec: raw,
			rawEndSec: to,
			sourceStartSec: sourceStart + (raw - rawStart),
			sourceEndSec: sourceStart + (to - rawStart),
		});
		raw = to;
	};

	for (const cut of cuts) {
		// `max(_, raw)` because sorted cuts can still overlap; the second one then starts
		// behind the cursor and contributes only whatever it reaches past it.
		push("play", Math.min(Math.max(cut.startSec, raw), rawEnd));
		push("removed", Math.min(cut.endSec, rawEnd));
	}
	push("play", rawEnd);

	return pieces;
}

/** The take's stretch of raw ruler, or null when it has none. */
export function takeRulerExtent(pieces: readonly TakePiece[]): {
	startSec: number;
	endSec: number;
} | null {
	if (pieces.length === 0) return null;
	return { startSec: pieces[0].rawStartSec, endSec: pieces[pieces.length - 1].rawEndSec };
}

/**
 * Seconds of the take's FILE the walk consumes.
 *
 * Deliberately not called `spanSec`: that name already means the trim-projected OUTPUT span
 * at the preview's call site, and the fades are measured against the consumed source.
 */
export function consumedSourceSec(pieces: readonly TakePiece[]): number {
	return pieces.reduce((sum, piece) => sum + (piece.sourceEndSec - piece.sourceStartSec), 0);
}

/** Where the voice is, and whether it is heard, at a raw moment. */
export function takePlaybackAt(
	pieces: readonly TakePiece[],
	rawSec: number,
): { targetTimeSec: number; shouldPlay: boolean } | null {
	for (const piece of pieces) {
		if (rawSec < piece.rawStartSec) break;
		if (rawSec >= piece.rawEndSec) continue;

		const rawSpan = piece.rawEndSec - piece.rawStartSec;
		const sourceSpan = piece.sourceEndSec - piece.sourceStartSec;
		const target = piece.sourceStartSec + ((rawSec - piece.rawStartSec) / rawSpan) * sourceSpan;
		return { targetTimeSec: target, shouldPlay: piece.kind === "play" };
	}
	return null;
}
