export interface PlaybackSpeedRegion {
	startMs: number;
	endMs: number;
	speed: number;
}

/**
 * Output seconds a raw interval occupies after speed regions apply: a 2x stretch of raw time
 * takes half as long to play. Integrates 1 / speed piecewise at every region boundary.
 */
export function outputDurationOfRawSpan(
	fromSec: number,
	toSec: number,
	speedRegions: readonly PlaybackSpeedRegion[],
): number {
	if (toSec <= fromSec) return 0;
	if (speedRegions.length === 0) return toSec - fromSec;
	const boundaries = new Set<number>([fromSec, toSec]);
	for (const region of speedRegions) {
		for (const edge of [region.startMs / 1000, region.endMs / 1000]) {
			if (edge > fromSec && edge < toSec) boundaries.add(edge);
		}
	}
	const edges = [...boundaries].sort((a, b) => a - b);
	let duration = 0;
	for (let i = 0; i < edges.length - 1; i++) {
		const start = edges[i];
		const end = edges[i + 1];
		const mid = (start + end) / 2;
		const region = speedRegions.find(
			(candidate) =>
				mid >= candidate.startMs / 1000 &&
				mid < candidate.endMs / 1000 &&
				Number.isFinite(candidate.speed) &&
				candidate.speed > 0,
		);
		duration += (end - start) / (region?.speed ?? 1);
	}
	return duration;
}
