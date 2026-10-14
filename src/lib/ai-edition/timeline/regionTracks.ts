// Track geometry shared by the timeline and its automatic height adjustment.
export const REGION_ROW_HEIGHT_PX = 22;
export const REGION_ROW_GAP_PX = 5;
export const REGION_LANE_PAD_PX = 1;
export const REGION_ROW_STEP_PX = REGION_ROW_HEIGHT_PX + REGION_ROW_GAP_PX;

export interface TrackSpan {
	id: string;
	start: number;
	end: number;
	/** Higher annotation layers appear above lower ones, as in the compositor. */
	layer?: number;
	/** Stable compositing order for annotations that share a saved zIndex. */
	stackOrder?: number;
}

/** Pack overlaps into separate tracks. Distinct explicit layers never share a row.
 * Include compact pills' outside resize handles at the current timeline scale, so
 * even two very short, adjacent elements remain independently reachable. */
export function packRegionRows(spans: readonly TrackSpan[], pxPerSec = 0) {
	const rowOf = new Map<string, number>();
	const rows: Array<{ layer: number | undefined; spans: Array<{ start: number; end: number }> }> =
		[];
	const sorted = [...spans].sort(
		(a, b) =>
			(b.layer ?? 0) - (a.layer ?? 0) ||
			(b.stackOrder ?? 0) - (a.stackOrder ?? 0) ||
			a.start - b.start ||
			a.end - b.end,
	);
	for (const span of sorted) {
		const compact = pxPerSec > 0 && (span.end - span.start) * pxPerSec < 18;
		const padding = compact ? 10 / pxPerSec : 0;
		const start = span.start - padding;
		const end = Math.max(span.end, span.start + (pxPerSec > 0 ? 1 / pxPerSec : 0)) + padding;
		let row = rows.findIndex(
			(r) => r.layer === span.layer && r.spans.every((s) => s.end <= start || s.start >= end),
		);
		if (row < 0) {
			row = rows.length;
			rows.push({ layer: span.layer, spans: [{ start, end }] });
		} else {
			rows[row].spans.push({ start, end });
		}
		rowOf.set(span.id, row);
	}
	return { rowOf, rowCount: Math.max(1, rows.length), layers: rows.map((r) => r.layer) };
}

export function regionLaneHeight(rowCount: number) {
	return (
		rowCount * REGION_ROW_HEIGHT_PX + (rowCount - 1) * REGION_ROW_GAP_PX + REGION_LANE_PAD_PX * 2
	);
}
