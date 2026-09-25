// Port of `findActiveSpeedRegion` from
// `src/components/video-editor/videoPlayback/videoEventHandlers.ts` — main
// applies speed by literally setting `<video>.playbackRate` every frame from
// whichever region contains the current time (first match wins on overlap),
// leaving the browser to do the actual time-warping. No virtual-timeline
// remap: a sped-up region still occupies its original span on the ruler,
// it's just played through faster — same behavior ported here.

export interface SpeedRegion {
	id: string;
	startMs: number;
	endMs: number;
	speed: number;
}

export function findActiveSpeedRegion(regions: SpeedRegion[], timeMs: number): SpeedRegion | null {
	return regions.find((region) => timeMs >= region.startMs && timeMs < region.endMs) ?? null;
}

/**
 * The time a viewer sees pass at `timeMs`: ∫ dt / speed, up to a constant. Zoom and Full
 * Camera transitions are timed on it, so a speed region speeds the footage up and not the
 * camera move (#683). Mirror of `ScreenClock` in `crates/compositor/src/regions.rs`, overlaps
 * included: the region that starts first keeps the shared span.
 */
export function screenTimeMs(regions: readonly SpeedRegion[], timeMs: number): number {
	let screen = timeMs;
	let coveredTo = Number.NEGATIVE_INFINITY;
	for (const region of [...regions].sort((a, b) => a.startMs - b.startMs)) {
		const start = Math.max(region.startMs, coveredTo);
		if (region.endMs <= start) continue;
		if (timeMs <= start) break;
		coveredTo = region.endMs;
		const speed = Number.isFinite(region.speed) && region.speed > 0 ? region.speed : 1;
		screen -= (Math.min(timeMs, region.endMs) - start) * (1 - 1 / speed);
	}
	return screen;
}
