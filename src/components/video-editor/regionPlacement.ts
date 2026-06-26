/**
 * Find the available gap at `startPos` in a list of regions.
 *
 * Looks at the span from `startPos` up to the start of the next region
 * (or up to `totalMs` if there is no later region) and reports its size,
 * along with whether placement at `startPos` is actually valid.
 *
 * Placement is valid as long as `startPos` does not fall inside an
 * existing region and there is some room before the next one. Landing
 * exactly on the start of an existing region is fine (adjacency is
 * allowed); landing strictly between a region's start and end, or
 * having zero space left before the next region, is not.
 */
export function findFreeGapAt(
	regions: ReadonlyArray<{ startMs: number; endMs: number }>,
	startPos: number,
	totalMs: number,
): { ok: boolean; gapMs: number } {
	const sorted = [...regions].sort((a, b) => a.startMs - b.startMs);
	const nextRegion = sorted.find((r) => r.startMs > startPos);
	const gapMs = nextRegion ? nextRegion.startMs - startPos : totalMs - startPos;
	const overlapping = sorted.some((r) => startPos >= r.startMs && startPos < r.endMs);
	return { ok: !overlapping && gapMs > 0, gapMs };
}
