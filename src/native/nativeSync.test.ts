import { describe, expect, it } from "vitest";
import {
	getNativePosition,
	IDLE_DRIFT_WATCH,
	NATIVE_DRIFT_PERSIST_MS,
	NATIVE_RESYNC_COOLDOWN_MS,
	nativeLeadSec,
	programmeTimeSec,
	publishNativePosition,
	watchDrift,
} from "./nativeSync";

/** Two segments of one recording around a cut: source 0-5 s, then 7-12 s from programme 5 s. */
const SEGMENTS = [
	{ timelineStartSec: 0, sourceStartSec: 0 },
	{ timelineStartSec: 5, sourceStartSec: 7 },
];

describe("programmeTimeSec", () => {
	it("places a source time on the trim-compressed timeline", () => {
		expect(programmeTimeSec(SEGMENTS, { clipIndex: 1, sourceTimeSec: 8 })).toBe(6);
	});

	it("has no answer for a clip the layout does not have", () => {
		expect(programmeTimeSec(SEGMENTS, { clipIndex: 4, sourceTimeSec: 8 })).toBeNull();
	});
});

describe("nativeLeadSec", () => {
	// Across a cut the source time jumps by the trimmed 2 s; on the programme it does not.
	it("sees no gap when the view and the playhead sit on either side of a cut", () => {
		const lead = nativeLeadSec(
			{ clipIndex: 0, sourceTimeSec: 4.99, receivedAtMs: 1000 },
			{ clipIndex: 1, sourceTimeSec: 7.02 },
			SEGMENTS,
			1000,
		);
		expect(lead).toBeCloseTo(-0.03, 5);
	});

	it("ages the view's last frame by the time since it arrived", () => {
		const lead = nativeLeadSec(
			{ clipIndex: 1, sourceTimeSec: 8, receivedAtMs: 1000 },
			{ clipIndex: 1, sourceTimeSec: 8.05 },
			SEGMENTS,
			1050,
		);
		expect(lead).toBeCloseTo(0, 5);
	});

	it("measures a view left behind by a stall", () => {
		const lead = nativeLeadSec(
			{ clipIndex: 0, sourceTimeSec: 2, receivedAtMs: 1000 },
			{ clipIndex: 0, sourceTimeSec: 2.4 },
			SEGMENTS,
			1000,
		);
		expect(lead).toBeCloseTo(-0.4, 5);
	});

	it("says nothing without a reported position", () => {
		expect(nativeLeadSec(null, { clipIndex: 0, sourceTimeSec: 1 }, SEGMENTS, 0)).toBeNull();
	});
});

describe("watchDrift", () => {
	it("leaves a view within tolerance alone", () => {
		const { resync, watch } = watchDrift(IDLE_DRIFT_WATCH, 0.1, 1000);
		expect(resync).toBe(false);
		expect(watch.outSinceMs).toBeNull();
	});

	// Right at a cut, or after an edit re-indexes the clips, the gap lasts a frame or two.
	it("re-anchors only a gap that holds", () => {
		let state = watchDrift(IDLE_DRIFT_WATCH, 0.5, 1000);
		expect(state.resync).toBe(false);
		state = watchDrift(state.watch, 0.5, 1000 + NATIVE_DRIFT_PERSIST_MS - 1);
		expect(state.resync).toBe(false);
		state = watchDrift(state.watch, 0.5, 1000 + NATIVE_DRIFT_PERSIST_MS);
		expect(state.resync).toBe(true);
	});

	it("forgets a gap that closed before it held", () => {
		let state = watchDrift(IDLE_DRIFT_WATCH, 0.5, 1000);
		state = watchDrift(state.watch, 0.01, 1050);
		state = watchDrift(state.watch, 0.5, 1100);
		expect(state.resync).toBe(false);
	});

	it("waits for a re-anchor to land before the next", () => {
		let state = watchDrift(IDLE_DRIFT_WATCH, 0.5, 0);
		state = watchDrift(state.watch, 0.5, NATIVE_DRIFT_PERSIST_MS);
		expect(state.resync).toBe(true);
		const at = NATIVE_DRIFT_PERSIST_MS;
		state = watchDrift(state.watch, 0.5, at + 10);
		state = watchDrift(state.watch, 0.5, at + NATIVE_RESYNC_COOLDOWN_MS - 1);
		expect(state.resync).toBe(false);
		state = watchDrift(state.watch, 0.5, at + NATIVE_RESYNC_COOLDOWN_MS);
		expect(state.resync).toBe(true);
	});
});

describe("publishNativePosition", () => {
	it("keeps the position a frame reports, with when it arrived", () => {
		publishNativePosition({ clipIndex: 2, sourceTimeSec: 3.5 }, 42);
		expect(getNativePosition()).toEqual({ clipIndex: 2, sourceTimeSec: 3.5, receivedAtMs: 42 });
	});

	// An addon that predates positions must not be steered on a stale one.
	it("forgets the position when a frame reports none", () => {
		publishNativePosition({ clipIndex: 2, sourceTimeSec: 3.5 }, 42);
		publishNativePosition({});
		expect(getNativePosition()).toBeNull();
	});
});
