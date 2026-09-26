import { describe, expect, it } from "vitest";
import { type BreathWord, breatheCut, mergeCloseCuts } from "./cut-breath";

const w = (startSec: number, endSec: number, kept = true): BreathWord => ({
	startSec,
	endSec,
	kept,
});

// A 1.0-1.5, B 2.0-2.4, C 3.0-3.5: two 0.5-0.6 s silences around B.
const A = w(1, 1.5);
const B = w(2, 2.4);
const C = w(3, 3.5);

describe("breatheCut", () => {
	it("leaves 70 ms of air on each side of a cut silence", () => {
		const cut = breatheCut({ startSec: 1.5, endSec: 2 }, [A, B, C]);
		expect(cut.startSec).toBeCloseTo(1.57);
		expect(cut.endSec).toBeCloseTo(1.93);
	});

	it("word plus both silences: breath only at the kept edges, no sliver around the word", () => {
		const cut = breatheCut({ startSec: 1.5, endSec: 3 }, [A, B, C]);
		expect(cut.startSec).toBeCloseTo(1.57);
		expect(cut.endSec).toBeCloseTo(2.93);
		// B stays wholly inside the cut.
		expect(cut.startSec).toBeLessThan(B.startSec);
		expect(cut.endSec).toBeGreaterThan(B.endSec);
	});

	it("never goes past the middle of a short gap", () => {
		const cut = breatheCut({ startSec: 1.5, endSec: 1.6 }, [A, w(1.6, 2)]);
		expect(cut).toEqual({ startSec: 1.5, endSec: 1.6 });
		const wider = breatheCut({ startSec: 1.5, endSec: 1.62 }, [A, w(1.62, 2)]);
		expect(wider).toEqual({ startSec: 1.5, endSec: 1.62 });
	});

	it("breathes up to the middle when the gap has room for less than two breaths", () => {
		// Gaps of 100 ms on each side of the word removed with them (1.6-1.9).
		const cut = breatheCut({ startSec: 1.5, endSec: 2 }, [A, w(1.6, 1.9), w(2, 2.5)]);
		expect(cut.startSec).toBeCloseTo(1.55);
		expect(cut.endSec).toBeCloseTo(1.95);
	});

	it("does not breathe next to a word that is already cut", () => {
		const cut = breatheCut({ startSec: 1.5, endSec: 2 }, [w(1, 1.5, false), B, C]);
		expect(cut.startSec).toBe(1.5);
		expect(cut.endSec).toBeCloseTo(1.93);
	});

	it("leaves an edge inside a word alone", () => {
		expect(breatheCut({ startSec: 1.2, endSec: 2.2 }, [A, B, C])).toEqual({
			startSec: 1.2,
			endSec: 2.2,
		});
	});

	it("leaves a cut on exact word bounds alone", () => {
		expect(breatheCut({ startSec: 2, endSec: 2.4 }, [A, B, C])).toEqual({
			startSec: 2,
			endSec: 2.4,
		});
	});

	it("ignores words with no duration", () => {
		const cut = breatheCut({ startSec: 1.5, endSec: 2 }, [A, w(1.5, 1.5), w(2, 2), B]);
		expect(cut.startSec).toBeCloseTo(1.57);
		expect(cut.endSec).toBeCloseTo(1.93);
	});

	it("leaves a side alone when the cut is too short to give it back", () => {
		// A 40 ms nibble just after A: breathing would push the start past the end.
		expect(breatheCut({ startSec: 1.5, endSec: 1.54 }, [A, C])).toEqual({
			startSec: 1.5,
			endSec: 1.54,
		});
	});
});

describe("mergeCloseCuts", () => {
	const fps = 30;

	it("snaps onto a neighbour less than two frames away", () => {
		expect(
			mergeCloseCuts({ startSec: 2.05, endSec: 3 }, [{ startSec: 1, endSec: 2 }], fps),
		).toEqual({ startSec: 2, endSec: 3 });
		expect(
			mergeCloseCuts({ startSec: 1, endSec: 2 }, [{ startSec: 2.05, endSec: 3 }], fps),
		).toEqual({ startSec: 1, endSec: 2.05 });
	});

	it("keeps a gap of two frames or more", () => {
		const cut = { startSec: 2.07, endSec: 3 };
		expect(mergeCloseCuts(cut, [{ startSec: 1, endSec: 2 }], fps)).toEqual(cut);
	});

	it("uses the asset's frame rate, 30 fps when it has none", () => {
		const cut = { startSec: 2.05, endSec: 3 };
		const before = [{ startSec: 1, endSec: 2 }];
		expect(mergeCloseCuts(cut, before, 60)).toEqual(cut);
		expect(mergeCloseCuts(cut, before, 0)).toEqual({ startSec: 2, endSec: 3 });
	});

	it("ignores overlapping neighbours", () => {
		const cut = { startSec: 1.5, endSec: 3 };
		expect(mergeCloseCuts(cut, [{ startSec: 1, endSec: 2 }], fps)).toEqual(cut);
	});
});
