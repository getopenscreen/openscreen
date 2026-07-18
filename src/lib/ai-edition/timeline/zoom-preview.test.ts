import { describe, expect, it } from "vitest";
import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import type { AxcutZoomRegion } from "@/lib/ai-edition/schema";
import { computeZoomPreviewTransform } from "./zoom-preview";

const telemetry: CursorTelemetryPoint[] = [
	{ timeMs: 5000, cx: 0.3, cy: 0.5 },
	{ timeMs: 6000, cx: 0.7, cy: 0.5 },
];

function region(focusMode: "manual" | "auto"): AxcutZoomRegion {
	return {
		id: `zoom-${focusMode}`,
		startMs: 10000,
		endMs: 13000,
		depth: 3,
		focus: { cx: 0.4, cy: 0.5 },
		focusMode,
	};
}

describe("computeZoomPreviewTransform", () => {
	it("keeps manual zoom unchanged when cursor telemetry and source time vary", () => {
		const manual = [region("manual")];
		const withoutTelemetry = computeZoomPreviewTransform(manual, 10500);
		const withTelemetry = computeZoomPreviewTransform(manual, 10500, telemetry, 1, 6000);

		expect(withTelemetry).toEqual(withoutTelemetry);
	});

	it("uses source cursor time while evaluating the zoom in virtual time", () => {
		const auto = [region("auto")];
		const atSourceStart = computeZoomPreviewTransform(auto, 10500, telemetry, 1, 5000);
		const atSourceEnd = computeZoomPreviewTransform(auto, 10500, telemetry, 1, 6000);

		expect(atSourceStart.scale).toBe(atSourceEnd.scale);
		expect(atSourceStart.translateXPercent).not.toBe(atSourceEnd.translateXPercent);
		expect(atSourceStart.translateXPercent).toBeGreaterThan(atSourceEnd.translateXPercent);
	});
});
