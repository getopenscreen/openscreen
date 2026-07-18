import { describe, expect, it } from "vitest";
import type { CursorTelemetryPoint, ZoomRegion } from "../types";
import { findDominantRegion } from "./zoomRegionUtils";

const telemetry: CursorTelemetryPoint[] = [
	{ timeMs: 0, cx: 0.3, cy: 0.4 },
	{ timeMs: 1000, cx: 0.7, cy: 0.6 },
];

function zoom(focusMode: "manual" | "auto"): ZoomRegion {
	return {
		id: `zoom-${focusMode}`,
		startMs: 1000,
		endMs: 4000,
		depth: 3,
		focus: { cx: 0.35, cy: 0.65 },
		focusMode,
	};
}

describe("findDominantRegion cursor time", () => {
	it("uses virtual time for region activity and source time for cursor interpolation", () => {
		const result = findDominantRegion([zoom("auto")], 1500, {
			cursorTelemetry: telemetry,
			cursorTimeMs: 250,
		});

		expect(result.strength).toBe(1);
		expect(result.region?.focus.cx).toBeCloseTo(0.4);
		expect(result.region?.focus.cy).toBeCloseTo(0.45);
	});

	it("includes cursor source time in the cache key", () => {
		const regions = [zoom("auto")];
		const atStart = findDominantRegion(regions, 1500, {
			cursorTelemetry: telemetry,
			cursorTimeMs: 0,
		});
		const atEnd = findDominantRegion(regions, 1500, {
			cursorTelemetry: telemetry,
			cursorTimeMs: 1000,
		});

		expect(atStart.region?.focus.cx).toBeCloseTo(0.3);
		expect(atEnd.region?.focus.cx).toBeCloseTo(0.7);
	});

	it("keeps manual zoom focus independent of cursor samples and source time", () => {
		const regions = [zoom("manual")];
		const first = findDominantRegion(regions, 1500, {
			cursorTelemetry: telemetry,
			cursorTimeMs: 0,
		});
		const second = findDominantRegion(regions, 1500, {
			cursorTelemetry: telemetry,
			cursorTimeMs: 1000,
		});

		expect(first.region?.focus).toEqual({ cx: 0.35, cy: 0.65 });
		expect(second.region?.focus).toEqual({ cx: 0.35, cy: 0.65 });
	});
});
