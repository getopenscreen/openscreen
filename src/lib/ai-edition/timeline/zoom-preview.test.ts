import { describe, expect, it } from "vitest";
import type { AxcutZoomRegion } from "../schema";
import { screenTimeMs } from "./speed";
import { computeZoomPreviewTransform } from "./zoom-preview";
import { ZOOM_DEPTH_SCALES } from "./zoom-scale";

function zoom(startMs: number, endMs: number): AxcutZoomRegion {
	return { id: `z${startMs}`, startMs, endMs, depth: 4, focus: { cx: 0.8, cy: 0.3 } };
}

describe("screenTimeMs", () => {
	it("runs slower than the timeline inside a speed region, once per overlapping span", () => {
		const regions = [{ id: "s", startMs: 2000, endMs: 6000, speed: 4 }];
		expect(screenTimeMs(regions, 1000)).toBe(1000);
		expect(screenTimeMs(regions, 4000)).toBe(2500);
		expect(screenTimeMs(regions, 8000)).toBe(5000);
		// The first region keeps [4000, 6000); the second only counts on [6000, 8000).
		const overlapping = [...regions, { id: "t", startMs: 4000, endMs: 8000, speed: 2 }];
		expect(screenTimeMs(overlapping, 8000)).toBe(4000);
	});
});

describe("computeZoomPreviewTransform pace", () => {
	// Mirror of `a_zoom_moves_at_a_comfortable_pace_at_every_level` (compositor): perceived speed
	// is |d ln(scale)/dt|, and the old fixed window reached 16/s at 5× (#683).
	it("stays under 3 e-folds/s at every level and lands exactly on the region start", () => {
		for (const depth of [1, 2, 3, 4, 5, 6] as const) {
			const region = { ...zoom(2000, 8000), depth };
			const lnScale = (t: number) => Math.log(computeZoomPreviewTransform([region], t).scale);
			let peak = 0;
			for (let t = 0; t < 2000; t += 5) {
				peak = Math.max(peak, Math.abs(lnScale(t + 5) - lnScale(t)) / 0.005);
			}
			expect(peak).toBeLessThan(3);
			expect(computeZoomPreviewTransform([region], 2000).scale).toBe(ZOOM_DEPTH_SCALES[depth]);
		}
	});

	it("moves the focus point to the centre linearly on screen, like the compositor", () => {
		// 0.7 stays inside the frame at 2.2×, so the focus clamp leaves it alone.
		const region = { ...zoom(2000, 8000), focus: { cx: 0.7, cy: 0.5 } };
		const target = ZOOM_DEPTH_SCALES[4];
		for (let t = 800; t <= 2000; t += 50) {
			const { scale, translateXPercent } = computeZoomPreviewTransform([region], t);
			const progress = Math.log(scale) / Math.log(target);
			const focusOnScreen = translateXPercent / 100 + 0.7 * scale;
			expect(focusOnScreen).toBeCloseTo(0.7 + (0.5 - 0.7) * progress, 6);
		}
	});
});

describe("computeZoomPreviewTransform under a speed region", () => {
	// A uniform 4× is a pure time scale for the footage: the camera must move exactly like a
	// region four times shorter played at 1× (mirror of the compositor's own test).
	it("scales the footage, not the camera move", () => {
		const speedRegions = [{ id: "s", startMs: 0, endMs: 1_000_000, speed: 4 }];
		for (let t = 0; t <= 60_000; t += 100) {
			const sped = computeZoomPreviewTransform([zoom(20_000, 40_000)], t, undefined, speedRegions);
			const plain = computeZoomPreviewTransform([zoom(5_000, 10_000)], t / 4);
			expect(sped.scale).toBeCloseTo(plain.scale, 6);
			expect(sped.translateXPercent).toBeCloseTo(plain.translateXPercent, 4);
		}
	});
});
