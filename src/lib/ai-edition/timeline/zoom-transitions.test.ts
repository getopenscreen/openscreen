import { describe, expect, it } from "vitest";
import { zoomTransitionMs } from "../../zoomMath/constants";
import { type SpeedRegion, screenTimeMs, timelineTimeMs } from "./speed";
import { transitionCutsMs, zoomTransitions } from "./zoom-transitions";

const W = zoomTransitionMs(1.8); // ≈ 923 ms
const zoom = { startMs: 10_000, endMs: 12_000, scale: 1.8 };

describe("timelineTimeMs", () => {
	it("inverts screenTimeMs, overlapping regions included", () => {
		const regions: SpeedRegion[] = [
			{ id: "a", startMs: 2000, endMs: 6000, speed: 2 },
			{ id: "b", startMs: 4000, endMs: 9000, speed: 4 },
			{ id: "c", startMs: 12_000, endMs: 13_000, speed: 0.5 },
		];
		for (const t of [0, 1999, 2000, 3000, 6000, 7500, 9000, 12_500, 20_000]) {
			expect(timelineTimeMs(regions, screenTimeMs(regions, t))).toBeCloseTo(t, 6);
		}
	});
});

describe("zoomTransitions", () => {
	it("puts the moves just outside the pill, deeper zooms longer", () => {
		const t = zoomTransitions(zoom, []);
		expect(t.inFromMs).toBeCloseTo(10_000 - W, 6);
		expect(t.outUntilMs).toBeCloseTo(12_000 + W, 6);
		expect(zoomTransitions({ ...zoom, scale: 5 }, []).durationMs).toBeGreaterThan(t.durationMs);
	});

	it("stretches a move across the timeline inside a speed region (issue #1028 variant)", () => {
		const t = zoomTransitions(zoom, [{ id: "s", startMs: 12_000, endMs: 20_000, speed: 3 }]);
		expect(t.outUntilMs).toBeCloseTo(12_000 + 3 * W, 6);
		expect(t.inFromMs).toBeCloseTo(10_000 - W, 6);
	});

	it("never starts a zoom-in before the timeline", () => {
		expect(zoomTransitions({ startMs: 300, endMs: 2000, scale: 1.8 }, []).inFromMs).toBe(0);
	});
});

describe("transitionCutsMs", () => {
	const t = zoomTransitions(zoom, []);

	it("reports the whole zoom-out lost to a trim starting at the pill's end (issue #1028)", () => {
		const cut = transitionCutsMs(zoom, t, [{ startMs: 12_000, endMs: 14_000 }]);
		expect(cut.inMs).toBe(0);
		expect(cut.outMs).toBeCloseTo(W, 6);
	});

	it("measures a partial cut from the first trimmed instant", () => {
		expect(transitionCutsMs(zoom, t, [{ startMs: 12_500, endMs: 13_000 }]).outMs).toBeCloseTo(
			12_000 + W - 12_500,
			6,
		);
		expect(transitionCutsMs(zoom, t, [{ startMs: 9000, endMs: 9500 }]).inMs).toBeCloseTo(
			9500 - (10_000 - W),
			6,
		);
	});

	it("ignores trims clear of the windows, inside the pill, or swallowing the whole zoom", () => {
		const none = { inMs: 0, outMs: 0 };
		expect(transitionCutsMs(zoom, t, [{ startMs: 13_000, endMs: 14_000 }])).toEqual(none);
		expect(transitionCutsMs(zoom, t, [{ startMs: 10_500, endMs: 11_000 }])).toEqual(none);
		expect(transitionCutsMs(zoom, t, [{ startMs: 9000, endMs: 14_000 }])).toEqual(none);
	});
});
