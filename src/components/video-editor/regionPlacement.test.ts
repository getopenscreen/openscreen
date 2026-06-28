import { describe, expect, it } from "vitest";
import { findFreeGapAt } from "./regionPlacement";

const totalMs = 10000;

describe("findFreeGapAt", () => {
	it("returns the gap to the end when there are no regions", () => {
		const { ok, gapMs } = findFreeGapAt([], 2000, totalMs);
		expect(ok).toBe(true);
		expect(gapMs).toBe(8000);
	});

	it("rejects a playhead that lands inside an existing region", () => {
		const regions = [{ startMs: 1000, endMs: 4000 }];
		const { ok } = findFreeGapAt(regions, 2000, totalMs);
		expect(ok).toBe(false);
	});

	it("clamps the gap to the next region's start", () => {
		const regions = [{ startMs: 5000, endMs: 7000 }];
		const { ok, gapMs } = findFreeGapAt(regions, 2000, totalMs);
		expect(ok).toBe(true);
		expect(gapMs).toBe(3000);
	});

	it("rejects placement with no room before the end", () => {
		const { ok, gapMs } = findFreeGapAt([], totalMs, totalMs);
		expect(ok).toBe(false);
		expect(gapMs).toBe(0);
	});

	it("rejects placement that lands exactly on a region's startMs", () => {
		const regions = [{ startMs: 5000, endMs: 7000 }];
		const { ok } = findFreeGapAt(regions, 5000, totalMs);
		expect(ok).toBe(false);
	});

	it("allows placement adjacent to (exactly at the end of) an existing region", () => {
		const regions = [{ startMs: 0, endMs: 2000 }];
		const { ok, gapMs } = findFreeGapAt(regions, 2000, totalMs);
		expect(ok).toBe(true);
		expect(gapMs).toBe(8000);
	});

	it("sorts unordered regions before computing the next gap", () => {
		const regions = [
			{ startMs: 8000, endMs: 9000 },
			{ startMs: 3000, endMs: 4000 },
		];
		const { ok, gapMs } = findFreeGapAt(regions, 1000, totalMs);
		expect(ok).toBe(true);
		expect(gapMs).toBe(2000);
	});
});
