// Cursor-telemetry-driven auto-zoom suggestions. Pure, no DOM/IPC.
//
// Ported from main's `src/components/video-editor/timeline/zoomSuggestionUtils.ts`
// (the legacy editor's "magic wand" auto-zoom) into the ai-edition timeline
// module. This is NOT an AI feature — it's a deterministic detector over
// recorded cursor movement: stretches where the cursor sits still become
// zoom-in candidates, focused on the average cursor position during the dwell,
// and so do recorded clicks, focused on the click itself (issue #699).

import type { CursorTelemetryPoint, ZoomFocus } from "@/components/video-editor/types";
import type { AxcutClip } from "../schema";

export const MIN_DWELL_DURATION_MS = 450;
export const MAX_DWELL_DURATION_MS = 2600;
export const DWELL_MOVE_THRESHOLD = 0.02;
/** Minimum spacing between two accepted suggestion centres. */
export const SUGGESTION_SPACING_MS = 1800;

export interface ZoomDwellCandidate {
	centerTimeMs: number;
	focus: ZoomFocus;
	strength: number;
}

function normalizeTelemetrySample(
	sample: CursorTelemetryPoint,
	totalMs: number,
): CursorTelemetryPoint {
	return {
		timeMs: Math.max(0, Math.min(sample.timeMs, totalMs)),
		cx: Math.max(0, Math.min(sample.cx, 1)),
		cy: Math.max(0, Math.min(sample.cy, 1)),
		interactionType: sample.interactionType,
	};
}

export function normalizeCursorTelemetry(
	telemetry: CursorTelemetryPoint[],
	totalMs: number,
): CursorTelemetryPoint[] {
	return [...telemetry]
		.filter(
			(sample) =>
				Number.isFinite(sample.timeMs) && Number.isFinite(sample.cx) && Number.isFinite(sample.cy),
		)
		.sort((a, b) => a.timeMs - b.timeMs)
		.map((sample) => normalizeTelemetrySample(sample, totalMs));
}

/**
 * `maxDwellDurationMs` exists for ONE caller and defaults to the magic wand's
 * own ceiling so that caller is untouched.
 *
 * ponytail: the ceiling REJECTS a run outright rather than splitting it, so a
 * cursor parked for eight seconds while the user reads the screen produces no
 * candidate at all. That is a defensible auto-zoom policy — a nine-second zoom
 * is not a zoom — and an indefensible reporting policy: the moments it drops are
 * precisely the ones a human would name first if asked "where did the pointer
 * sit?". The digest passes `Infinity`; nothing else does.
 */
export function detectZoomDwellCandidates(
	samples: CursorTelemetryPoint[],
	maxDwellDurationMs: number = MAX_DWELL_DURATION_MS,
): ZoomDwellCandidate[] {
	if (samples.length < 2) {
		return [];
	}

	const dwellCandidates: ZoomDwellCandidate[] = [];
	let runStart = 0;

	const pushRunIfDwell = (startIndex: number, endIndexExclusive: number) => {
		if (endIndexExclusive - startIndex < 2) {
			return;
		}

		const start = samples[startIndex];
		const end = samples[endIndexExclusive - 1];
		const runDuration = end.timeMs - start.timeMs;
		if (runDuration < MIN_DWELL_DURATION_MS || runDuration > maxDwellDurationMs) {
			return;
		}

		const runSamples = samples.slice(startIndex, endIndexExclusive);
		const avgCx = runSamples.reduce((sum, sample) => sum + sample.cx, 0) / runSamples.length;
		const avgCy = runSamples.reduce((sum, sample) => sum + sample.cy, 0) / runSamples.length;

		dwellCandidates.push({
			centerTimeMs: Math.round((start.timeMs + end.timeMs) / 2),
			focus: { cx: avgCx, cy: avgCy },
			strength: runDuration,
		});
	};

	for (let index = 1; index < samples.length; index += 1) {
		const prev = samples[index - 1];
		const curr = samples[index];
		const distance = Math.hypot(curr.cx - prev.cx, curr.cy - prev.cy);

		if (distance > DWELL_MOVE_THRESHOLD) {
			pushRunIfDwell(runStart, index);
			runStart = index;
		}
	}
	pushRunIfDwell(runStart, samples.length);

	return dwellCandidates;
}

/** The recorded interactions that count as a click; `move` and `mouseup` do not. */
const CLICK_INTERACTION_TYPES: ReadonlySet<NonNullable<CursorTelemetryPoint["interactionType"]>> =
	new Set(["click", "double-click", "right-click", "middle-click"]);

/**
 * Clicks are zoom candidates in their own right (issue #699): a click made while the
 * pointer is still moving forms no dwell, yet it is exactly the moment a viewer wants
 * magnified. The candidate is the click sample itself — its time, its position — and
 * `strength` is 0 because a click has no duration to rank by; that only ever breaks
 * ties between two clicks, where the stable sort keeps the earlier one.
 */
function detectZoomClickCandidates(samples: CursorTelemetryPoint[]): ZoomDwellCandidate[] {
	return samples
		.filter(
			(sample) =>
				sample.interactionType !== undefined && CLICK_INTERACTION_TYPES.has(sample.interactionType),
		)
		.map((sample) => ({
			centerTimeMs: sample.timeMs,
			focus: { cx: sample.cx, cy: sample.cy },
			strength: 0,
		}));
}

export interface AutoZoomSuggestion {
	span: { start: number; end: number };
	focus: ZoomFocus;
}

/**
 * Build non-overlapping zoom suggestions from cursor telemetry: detect dwell moments
 * and recorded clicks, space by SUGGESTION_SPACING_MS, drop any overlapping an
 * existing region. Clicks are honoured FIRST, so only an ACCEPTED click folds the
 * dwells within suggestion spacing of it — the acceptance loop rejects those dwells
 * against the accepted click's centre — while a click that spacing or an existing
 * region rejects leaves its nearby dwells standing as the fallback. One recorded
 * click still yields ONE zoom anchored on the click's own time and position
 * (issue #699). Pure, shared by the magic-wand toggle and the on-load auto-suggest pass.
 */
export function buildAutoZoomSuggestions(options: {
	cursorTelemetry: CursorTelemetryPoint[];
	totalMs: number;
	existingRegions: { startMs: number; endMs: number }[];
	defaultDurationMs: number;
}): AutoZoomSuggestion[] {
	const { cursorTelemetry, totalMs, existingRegions, defaultDurationMs } = options;
	if (totalMs <= 0 || cursorTelemetry.length === 0) {
		return [];
	}

	const defaultDuration = Math.min(defaultDurationMs, totalMs);
	if (defaultDuration <= 0) {
		return [];
	}

	const normalizedSamples = normalizeCursorTelemetry(cursorTelemetry, totalMs);
	if (normalizedSamples.length === 0) {
		return [];
	}

	const dwellCandidates = detectZoomDwellCandidates(normalizedSamples);
	const clickCandidates = detectZoomClickCandidates(normalizedSamples);
	if (dwellCandidates.length === 0 && clickCandidates.length === 0) {
		return [];
	}

	// Clicks are honoured FIRST so that only an accepted click folds its nearby dwells:
	// the acceptance loop below rejects any dwell within SUGGESTION_SPACING_MS of an
	// accepted click's centre, while a click that spacing or an existing region rejects
	// leaves the dwells around it standing. Telemetry without click metadata runs the
	// unchanged dwell-only ranking. Within each kind the order is the old one — clicks
	// chronological, dwells by duration.
	const dwellByDuration = [...dwellCandidates].sort((a, b) => b.strength - a.strength);
	const sortedCandidates = [...clickCandidates, ...dwellByDuration];

	const reservedSpans = existingRegions
		.map((region) => ({ start: region.startMs, end: region.endMs }))
		.sort((a, b) => a.start - b.start);

	const acceptedCenters: number[] = [];
	const suggestions: AutoZoomSuggestion[] = [];

	for (const candidate of sortedCandidates) {
		const tooCloseToAccepted = acceptedCenters.some(
			(center) => Math.abs(center - candidate.centerTimeMs) < SUGGESTION_SPACING_MS,
		);
		if (tooCloseToAccepted) {
			continue;
		}

		const centeredStart = Math.round(candidate.centerTimeMs - defaultDuration / 2);
		const candidateStart = Math.max(0, Math.min(centeredStart, totalMs - defaultDuration));
		const candidateEnd = candidateStart + defaultDuration;
		const hasOverlap = reservedSpans.some(
			(span) => candidateEnd > span.start && candidateStart < span.end,
		);
		if (hasOverlap) {
			continue;
		}

		reservedSpans.push({ start: candidateStart, end: candidateEnd });
		acceptedCenters.push(candidate.centerTimeMs);
		suggestions.push({
			span: { start: candidateStart, end: candidateEnd },
			focus: candidate.focus,
		});
	}

	return suggestions;
}

/**
 * The same detector, run over a TIMELINE instead of over a bare media file — and the
 * only entry point a caller holding an `AxcutDocument` should use.
 *
 * Cursor telemetry is recorded against the ORIGINAL media file, so `timeMs` is the
 * asset's SOURCE time (the same axis `cursor-track.ts` maps through
 * `locateSourcePosition`, and the same one trims are stored in). Zoom regions are
 * authored in RAW TIMELINE ms — that is what `anchorRegionsWithDerivedMs` ventilates
 * across the clips. The two axes coincide for exactly one layout: a single clip,
 * starting at 0, covering the whole recording. Any other timeline made the detector's
 * output land wherever `[0, assetDuration]` happens to fall on the ruler, which is the
 * first clip's span — hence "auto-zoom only decorates the first clip". Two clips over
 * ONE recording make it plainer still: the second clip replays source time the first
 * already used, so no amount of arithmetic on a single asset-wide span can say which of
 * them a dwell belongs to. It belongs to BOTH, and gets one zoom on each.
 *
 * So the projection is per clip, and it is a plain shift: a raw clip is identity between
 * its source time and its raw-virtual time (see timeline/timelineMap.ts), so a dwell or
 * click at source `t` on a clip covering `[sourceStartSec, sourceEndSec]` sits at
 * `timelineStartSec + (t - sourceStartSec)`. Each clip is handed only the samples inside
 * its own source window, so a dwell that a cut split across two clips is no longer one
 * dwell — which is right: the cursor did not sit still across the cut on the timeline the
 * user is watching. `existingRegions` is in RAW TIMELINE ms (what the store holds), so it
 * reserves the right stretch of ruler on every clip instead of only on the first.
 *
 * Clips of other assets are skipped, as are clips with no probed source window.
 * `buildAutoZoomSuggestions` is reused verbatim per clip — spacing, ranking and the
 * reserve rule keep their single definition.
 */
export function buildAutoZoomSuggestionsForClips(options: {
	/** Samples in the asset's own SOURCE time. */
	cursorTelemetry: CursorTelemetryPoint[];
	assetId: string;
	clips: AxcutClip[];
	/** Already-placed zoom spans, in RAW TIMELINE ms. */
	existingRegions: { startMs: number; endMs: number }[];
	defaultDurationMs: number;
}): AutoZoomSuggestion[] {
	const { cursorTelemetry, assetId, clips, existingRegions, defaultDurationMs } = options;
	const suggestions: AutoZoomSuggestion[] = [];
	for (const clip of clips) {
		if (clip.assetId !== assetId) continue;
		const sourceEndSec = clip.sourceEndSec ?? clip.sourceStartSec;
		const windowMs = (sourceEndSec - clip.sourceStartSec) * 1000;
		if (windowMs <= 0) continue;
		const sourceOffsetMs = clip.sourceStartSec * 1000;
		const timelineOffsetMs = clip.timelineStartSec * 1000;
		const clipTelemetry = cursorTelemetry
			.filter(
				(sample) => sample.timeMs >= sourceOffsetMs && sample.timeMs <= sourceOffsetMs + windowMs,
			)
			.map((sample) => ({ ...sample, timeMs: sample.timeMs - sourceOffsetMs }));
		const clipSuggestions = buildAutoZoomSuggestions({
			cursorTelemetry: clipTelemetry,
			totalMs: windowMs,
			existingRegions: existingRegions.map((region) => ({
				startMs: region.startMs - timelineOffsetMs,
				endMs: region.endMs - timelineOffsetMs,
			})),
			defaultDurationMs,
		});
		suggestions.push(
			...clipSuggestions.map((suggestion) => ({
				focus: suggestion.focus,
				span: {
					start: suggestion.span.start + timelineOffsetMs,
					end: suggestion.span.end + timelineOffsetMs,
				},
			})),
		);
	}
	return suggestions;
}
