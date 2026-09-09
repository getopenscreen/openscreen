import { describe, expect, it } from "vitest";
import { computeVadSegments } from "./sileroVad";

describe("computeVadSegments", () => {
	it("returns an empty array when probabilities are below speech threshold", () => {
		const probs = new Float32Array([0.1, 0.2, 0.1, 0.05, 0.2]);
		const segments = computeVadSegments(probs, 0.032);
		expect(segments).toEqual([]);
	});

	it("detects a contiguous speech segment with padding", () => {
		const probs = new Float32Array([0.1, 0.8, 0.9, 0.85, 0.9, 0.1, 0.05, 0.1]);
		const segments = computeVadSegments(probs, 0.1, {
			speechThreshold: 0.5,
			minSilenceDurationSec: 0.2,
			paddingSec: 0.05,
		});

		expect(segments.length).toBe(1);
		expect(segments[0].startSec).toBeGreaterThanOrEqual(0);
		expect(segments[0].endSec).toBeGreaterThan(segments[0].startSec);
	});
});
