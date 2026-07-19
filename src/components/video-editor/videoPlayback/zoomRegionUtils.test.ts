import { describe, expect, it } from "vitest";
import type { CursorTelemetryPoint, ZoomRegion } from "../types";
import { DEFAULT_ZOOM_DEPTH, ZOOM_DEPTH_SCALES } from "../types";
import { findDominantRegion } from "./zoomRegionUtils";

/**
 * Regression coverage for issue #72: an auto-placed zoom region must pan to follow
 * the cursor for its whole span, not freeze at the focus point captured when the
 * region was created/suggested.
 */
describe("findDominantRegion — auto-zoom cursor following", () => {
	const baseRegion: ZoomRegion = {
		id: "zoom-1",
		startMs: 0,
		endMs: 4000,
		depth: DEFAULT_ZOOM_DEPTH,
		customScale: ZOOM_DEPTH_SCALES[DEFAULT_ZOOM_DEPTH],
		// The static focus captured at suggestion time (e.g. the dwell centroid) — should
		// be ignored in favor of the live cursor position once focusMode is "auto". Kept
		// within the depth-3 focus bounds (~0.28-0.72) so clamping doesn't distort assertions.
		focus: { cx: 0.35, cy: 0.5 },
		focusMode: "auto",
		source: "auto",
	};

	// Cursor sweeps steadily from the left edge to the right edge across the region.
	const movingTelemetry: CursorTelemetryPoint[] = [
		{ timeMs: 0, cx: 0.1, cy: 0.5 },
		{ timeMs: 2000, cx: 0.5, cy: 0.5 },
		{ timeMs: 4000, cx: 0.9, cy: 0.5 },
	];

	it("tracks the cursor across the region instead of freezing at the initial focus", () => {
		const early = findDominantRegion([baseRegion], 200, { cursorTelemetry: movingTelemetry });
		const mid = findDominantRegion([baseRegion], 2000, { cursorTelemetry: movingTelemetry });
		const late = findDominantRegion([baseRegion], 3800, { cursorTelemetry: movingTelemetry });

		expect(early.region).not.toBeNull();
		expect(mid.region).not.toBeNull();
		expect(late.region).not.toBeNull();

		// The focus must move meaningfully between samples (cursor-following), not stay pinned.
		expect(mid.region?.focus.cx).toBeGreaterThan(early.region?.focus.cx ?? 0);
		expect(late.region?.focus.cx).toBeGreaterThan(mid.region?.focus.cx ?? 0);

		// And it must not equal the static creation-time focus baked into the region.
		expect(mid.region?.focus.cx).not.toBeCloseTo(baseRegion.focus.cx, 2);
	});

	it("stays frozen at the static focus when focusMode is not auto (manual regions unaffected)", () => {
		const manualRegion: ZoomRegion = { ...baseRegion, focusMode: "manual", source: "manual" };

		const early = findDominantRegion([manualRegion], 200, { cursorTelemetry: movingTelemetry });
		const late = findDominantRegion([manualRegion], 3800, { cursorTelemetry: movingTelemetry });

		expect(early.region?.focus.cx).toBeCloseTo(manualRegion.focus.cx, 5);
		expect(late.region?.focus.cx).toBeCloseTo(manualRegion.focus.cx, 5);
	});
});
