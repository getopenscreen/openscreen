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
		expect(segments[0].startSec).toBe(0.05);
		expect(segments[0].endSec).toBe(0.55);
	});

	it("prevents overlapping segments when paddingSec is larger than silence gap", () => {
		// 2 speech regions separated by 0.2s silence gap (with minSilenceDurationSec=0.1s, paddingSec=0.25s)
		// Without clamping, segment 2 speechStart (0.7 - 0.25 = 0.45) would overlap segment 1 endSec (0.5 + 0.25 = 0.75).
		const probs = new Float32Array([
			0.9,
			0.9,
			0.9,
			0.9,
			0.9, // Speech 0.0s - 0.5s
			0.1,
			0.1, // Silence 0.5s - 0.7s
			0.9,
			0.9,
			0.9,
			0.9,
			0.9, // Speech 0.7s - 1.2s
			0.1,
			0.1, // Silence 1.2s - 1.4s
		]);
		const segments = computeVadSegments(probs, 0.1, {
			speechThreshold: 0.5,
			minSilenceDurationSec: 0.1,
			paddingSec: 0.25,
		});

		expect(segments.length).toBe(2);
		expect(segments[0].startSec).toBe(0);
		expect(segments[0].endSec).toBe(0.75);
		expect(segments[1].startSec).toBeGreaterThanOrEqual(segments[0].endSec);
	});
});
