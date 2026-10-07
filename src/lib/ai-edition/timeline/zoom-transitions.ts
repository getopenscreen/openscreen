// Where a zoom's camera moves sit on the timeline (#1028). A zoom pill shows the HOLD: the
// zoom-in runs entirely before its start and the zoom-out entirely after its end, each
// lasting `zoomTransitionMs(scale)` of SCREEN time (`computeRegionStrength`, mirror of
// `zoom_region_strength` in crates/compositor/src/regions.rs). These helpers turn those
// windows into timeline ms, through the same speed-aware clock, and measure what a trim cuts
// off them: the render drops the trimmed frames, so the camera jumps at the cut instead of
// easing.
//
// Chained zooms (closer than 1.5 s, panned between) are measured as if apart. That is the
// right answer for trims: a trim between two zooms splits them into separate segments, which
// breaks the chain, and each then needs its own windows untrimmed.

import { zoomTransitionMs } from "../../zoomMath/constants";
import { type SpeedRegion, screenTimeMs, timelineTimeMs } from "./speed";
import { ZOOM_DEPTH_SCALES } from "./zoom-scale";

export interface Span {
	startMs: number;
	endMs: number;
}

export interface ZoomTransitions {
	/** Timeline ms where the zoom-in starts. It lands on the zoom's start. */
	inFromMs: number;
	/** Timeline ms where the zoom-out, which leaves from the zoom's end, is over. */
	outUntilMs: number;
	/** Screen ms each move lasts, whatever the speed regions do to the footage. */
	durationMs: number;
}

/** "0.72 s at 1.25×, …": every depth's move duration, for the agent's tool descriptions. */
export const ZOOM_TRANSITION_LEGEND = Object.values(ZOOM_DEPTH_SCALES)
	.sort((a, b) => a - b)
	.map((scale) => `${(zoomTransitionMs(scale) / 1000).toFixed(2)} s at ${scale.toFixed(2)}×`)
	.join(", ");

export function zoomTransitions(
	zoom: Span & { scale: number },
	speedRegions: readonly SpeedRegion[],
): ZoomTransitions {
	const durationMs = zoomTransitionMs(zoom.scale);
	return {
		inFromMs: Math.max(
			0,
			timelineTimeMs(speedRegions, screenTimeMs(speedRegions, zoom.startMs) - durationMs),
		),
		outUntilMs: timelineTimeMs(speedRegions, screenTimeMs(speedRegions, zoom.endMs) + durationMs),
		durationMs,
	};
}

/**
 * Timeline ms of each move the trims cut off (0 when untouched). The zoom-in only plays after
 * the last trimmed instant before the zoom, the zoom-out only until the first one after it.
 * A zoom entirely under a trim never plays and the compositor renders it without envelopes
 * (`under_trim`), so it has nothing to cut.
 */
export function transitionCutsMs(
	zoom: Span,
	transitions: ZoomTransitions,
	trims: readonly Span[],
): { inMs: number; outMs: number } {
	if (trims.some((t) => t.startMs <= zoom.startMs && t.endMs >= zoom.endMs)) {
		return { inMs: 0, outMs: 0 };
	}
	let resumesAt = transitions.inFromMs;
	let jumpsAt = transitions.outUntilMs;
	for (const t of trims) {
		if (t.startMs < zoom.startMs && t.endMs > transitions.inFromMs) {
			resumesAt = Math.max(resumesAt, Math.min(t.endMs, zoom.startMs));
		}
		if (t.endMs > zoom.endMs && t.startMs < transitions.outUntilMs) {
			jumpsAt = Math.min(jumpsAt, Math.max(t.startMs, zoom.endMs));
		}
	}
	return { inMs: resumesAt - transitions.inFromMs, outMs: transitions.outUntilMs - jumpsAt };
}
