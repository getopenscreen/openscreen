import { describe, expect, it } from "vitest";
import {
	buildCursorMotionTrajectory,
	type CursorMotionPath,
	type CursorMotionRegion,
	createDefaultCursorMotionControlPoint,
	findCursorMotionRegionAtTime,
	resolveCursorMotionClickAnchoredSpan,
	sampleCursorMotionPath,
	sampleCursorMotionRegion,
} from "./cursorMotion";

const start = { cx: 0.1, cy: 0.5 };
const end = { cx: 0.9, cy: 0.5 };

function region(overrides: Partial<CursorMotionRegion> = {}): CursorMotionRegion {
	return {
		id: "motion-1",
		startMs: 100,
		endMs: 1100,
		preset: "arc",
		controlPoint: { cx: 0.5, cy: 0.2 },
		cycles: 2,
		easing: "linear",
		...overrides,
	};
}

function linearPath(hiddenAt?: number): CursorMotionPath {
	return {
		sampleAt(timeMs) {
			if (timeMs === hiddenAt) return null;
			const progress = Math.max(0, Math.min(1, (timeMs - 100) / 1000));
			return {
				cx: start.cx + (end.cx - start.cx) * progress,
				cy: start.cy + (end.cy - start.cy) * progress,
			};
		},
	};
}

describe("cursor motion choreography", () => {
	it("keeps the recorded start and click anchors exact", () => {
		const motion = region({ preset: "wave", cycles: 3 });
		expect(sampleCursorMotionRegion(motion, start, end, motion.startMs)).toEqual(start);
		expect(sampleCursorMotionRegion(motion, start, end, motion.endMs)).toEqual(end);
	});

	it("uses persisted anchors instead of moving them when smoothing changes", () => {
		const anchored = region({
			startPoint: { cx: 0.2, cy: 0.3 },
			endPoint: { cx: 0.75, cy: 0.8 },
		});
		expect(sampleCursorMotionPath(linearPath(), [anchored], anchored.startMs)).toEqual(
			anchored.startPoint,
		);
		expect(sampleCursorMotionPath(linearPath(), [anchored], anchored.endMs)).toEqual(
			anchored.endPoint,
		);
	});

	it("creates an editable arc through the control-point side", () => {
		const above = sampleCursorMotionRegion(region(), start, end, 600);
		const below = sampleCursorMotionRegion(
			region({ controlPoint: { cx: 0.5, cy: 0.8 } }),
			start,
			end,
			600,
		);
		expect(above.cy).toBeCloseTo(0.2, 6);
		expect(below.cy).toBeCloseTo(0.8, 6);
	});

	it("generates a wave with multiple alternating bends", () => {
		const motion = region({ preset: "wave", cycles: 2 });
		const first = sampleCursorMotionRegion(motion, start, end, 225);
		const second = sampleCursorMotionRegion(motion, start, end, 475);
		expect(first.cy).toBeLessThan(0.5);
		expect(second.cy).toBeGreaterThan(0.5);
	});

	it("generates a loop and an overshoot while still landing on the click", () => {
		const loop = buildCursorMotionTrajectory(linearPath(), region({ preset: "loop" }), 40);
		const overshoot = buildCursorMotionTrajectory(
			linearPath(),
			region({ preset: "overshoot", controlPoint: { cx: 0.5, cy: 0.5 } }),
			80,
		);
		expect(loop.some((point) => Math.abs(point.cy - 0.5) > 0.03)).toBe(true);
		expect(overshoot.some((point) => point.cx > end.cx)).toBe(true);
		expect(overshoot.at(-1)).toEqual(end);
	});

	it("only replaces the active region and preserves hidden samples", () => {
		const path = linearPath(600);
		expect(sampleCursorMotionPath(path, [region()], 50)).toEqual(start);
		expect(sampleCursorMotionPath(path, [region()], 600)).toBeNull();
		expect(sampleCursorMotionPath(path, [region()], 1100)).toEqual(end);
	});

	it("uses the most recently added overlapping region", () => {
		const first = region({ id: "first", preset: "straight" });
		const second = region({ id: "second", preset: "arc" });
		expect(findCursorMotionRegionAtTime([first, second], 600)?.id).toBe("second");
	});

	it("places a safe default handle perpendicular to the recorded path", () => {
		const control = createDefaultCursorMotionControlPoint(start, end);
		expect(control.cx).toBeCloseTo(0.5, 6);
		expect(control.cy).toBeGreaterThanOrEqual(0);
		expect(control.cy).toBeLessThan(0.5);
	});

	it("locks a new motion to the first recorded click after the playhead", () => {
		expect(resolveCursorMotionClickAnchoredSpan(500.4, [1800, 500, 900])).toEqual({
			startMs: 500,
			endMs: 900,
		});
		expect(resolveCursorMotionClickAnchoredSpan(1800, [500, 900, 1800])).toBeNull();
	});
});
