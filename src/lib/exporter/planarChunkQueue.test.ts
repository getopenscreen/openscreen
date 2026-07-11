import { describe, expect, it } from "vitest";
import { PlanarChunkQueue } from "./planarChunkQueue";

function ramp(from: number, count: number): Float32Array {
	const a = new Float32Array(count);
	for (let i = 0; i < count; i++) a[i] = from + i;
	return a;
}

describe("PlanarChunkQueue", () => {
	it("tracks buffered length across pushes and takes", () => {
		const q = new PlanarChunkQueue(1);
		expect(q.length).toBe(0);
		q.push([ramp(0, 10)], 10);
		q.push([ramp(10, 5)], 5);
		expect(q.length).toBe(15);
		q.take(6);
		expect(q.length).toBe(9);
	});

	it("drains samples in FIFO order across chunk boundaries (mono)", () => {
		const q = new PlanarChunkQueue(1);
		q.push([ramp(0, 4)], 4); // 0..3
		q.push([ramp(4, 4)], 4); // 4..7
		q.push([ramp(8, 4)], 4); // 8..11
		// A take that spans multiple chunks and stops mid-chunk.
		expect(Array.from(q.take(5))).toEqual([0, 1, 2, 3, 4]);
		expect(Array.from(q.take(5))).toEqual([5, 6, 7, 8, 9]);
		expect(Array.from(q.take(2))).toEqual([10, 11]);
		expect(q.length).toBe(0);
	});

	it("keeps channels separate and lays them out planar [ch0…, ch1…]", () => {
		const q = new PlanarChunkQueue(2);
		q.push([ramp(0, 3), ramp(100, 3)], 3); // L:0,1,2  R:100,101,102
		q.push([ramp(3, 3), ramp(103, 3)], 3); // L:3,4,5  R:103,104,105
		const out = q.take(4);
		// First 4 = left, next 4 = right.
		expect(Array.from(out.subarray(0, 4))).toEqual([0, 1, 2, 3]);
		expect(Array.from(out.subarray(4, 8))).toEqual([100, 101, 102, 103]);
		expect(q.length).toBe(2);
		const rest = q.take(2);
		expect(Array.from(rest.subarray(0, 2))).toEqual([4, 5]);
		expect(Array.from(rest.subarray(2, 4))).toEqual([104, 105]);
	});

	it("honors a partial chunk consumed by an earlier take before dropping it", () => {
		const q = new PlanarChunkQueue(1);
		q.push([ramp(0, 10)], 10);
		expect(Array.from(q.take(3))).toEqual([0, 1, 2]); // leaves headOffset=3 in chunk 0
		q.push([ramp(10, 3)], 3);
		expect(Array.from(q.take(9))).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11]);
		expect(q.length).toBe(1);
		expect(Array.from(q.take(1))).toEqual([12]);
	});

	it("ignores non-positive pushes/takes", () => {
		const q = new PlanarChunkQueue(1);
		q.push([ramp(0, 5)], 0);
		expect(q.length).toBe(0);
		expect(Array.from(q.take(0))).toEqual([]);
	});

	it("reconstructs a long stream fed in odd-sized chunks and drained in fixed slices", () => {
		const q = new PlanarChunkQueue(1);
		const total = 5000;
		let produced = 0;
		const collected: number[] = [];
		// Feed odd chunk sizes, drain 512 whenever enough is buffered.
		for (let chunk = 1; produced < total; chunk++) {
			const n = Math.min(chunk, total - produced);
			q.push([ramp(produced, n)], n);
			produced += n;
			while (q.length >= 512) collected.push(...q.take(512));
		}
		while (q.length > 0) collected.push(...q.take(Math.min(512, q.length)));
		expect(collected.length).toBe(total);
		expect(collected[0]).toBe(0);
		expect(collected[total - 1]).toBe(total - 1);
		// Strictly increasing ⇒ no reorder/drop/dupe.
		expect(collected.every((v, i) => v === i)).toBe(true);
	});
});
