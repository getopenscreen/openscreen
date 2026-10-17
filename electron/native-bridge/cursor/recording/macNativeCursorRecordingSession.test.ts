import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The cast on `actual` is written out in the factory rather than shared in a
 * helper: `vi.mock` calls are HOISTED above every top-level statement, so a
 * module-scope helper is still in its temporal dead zone when the factory runs.
 */
type WithDefault = { default?: Record<string, unknown> };

const mocks = vi.hoisted(() => ({
	cursor: { x: 0, y: 0 },
	nearestDisplay: {
		scaleFactor: 2,
		bounds: { x: 0, y: 0, width: 1920, height: 1080 },
	},
	isTrustedAccessibilityClient: vi.fn(() => true),
	accessSync: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const spawn = vi.fn();
	return { ...actual, spawn, default: { ...((actual as WithDefault).default ?? {}), spawn } };
});

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		accessSync: mocks.accessSync,
		default: { ...((actual as WithDefault).default ?? {}), accessSync: mocks.accessSync },
	};
});

vi.mock("electron", () => ({
	systemPreferences: { isTrustedAccessibilityClient: mocks.isTrustedAccessibilityClient },
	screen: {
		getCursorScreenPoint: () => mocks.cursor,
		getDisplayNearestPoint: () => mocks.nearestDisplay,
	},
}));

import { spawn } from "node:child_process";
import type { Rectangle } from "electron";
import { MacNativeCursorRecordingSession } from "./macNativeCursorRecordingSession";

/** Minimal stand-in for the cursor helper: stdio pipes plus kill bookkeeping. */
class FakeHelper extends EventEmitter {
	stdout = new PassThrough();
	stderr = new PassThrough();
	killed = false;

	kill() {
		this.killed = true;
		return true;
	}

	/** Feeds one NDJSON line, the way the real helper emits them. */
	emitEvent(event: Record<string, unknown>) {
		this.stdout.write(`${JSON.stringify(event)}\n`);
	}
}

const spawnMock = vi.mocked(spawn);
let helper: FakeHelper;

beforeEach(() => {
	helper = new FakeHelper();
	spawnMock.mockReset();
	spawnMock.mockReturnValue(helper as unknown as ReturnType<typeof spawn>);
	mocks.cursor = { x: 0, y: 0 };
	mocks.nearestDisplay = {
		scaleFactor: 2,
		bounds: { x: 0, y: 0, width: 1920, height: 1080 },
	};
	mocks.isTrustedAccessibilityClient.mockReset();
	mocks.isTrustedAccessibilityClient.mockReturnValue(true);
	mocks.accessSync.mockReset();
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
});

const WINDOW_BOUNDS: Rectangle = { x: 200, y: 100, width: 1000, height: 800 };

async function recordWithHelper(
	getDisplayBounds: () => Rectangle | null,
	sample: (emit: (event: Record<string, unknown>) => void) => void,
) {
	const session = new MacNativeCursorRecordingSession({
		getDisplayBounds,
		maxSamples: 20,
		sampleIntervalMs: 33,
		startTimeMs: 1_000,
	});
	const pending = session.start();
	await Promise.resolve();
	helper.emitEvent({ type: "ready", timestampMs: 1_000 });
	await pending;
	sample((event) => helper.emitEvent(event));
	return session.stop();
}

function click(timestampMs: number) {
	return { type: "sample", timestampMs, leftButtonPressed: true };
}

describe("MacNativeCursorRecordingSession capture bounds", () => {
	it("places click hotspots on the top and bottom of a window with a non-zero origin", async () => {
		// 10px inside each edge. A display-sized frame, or any fixed y shift, misses both.
		mocks.cursor = { x: 400, y: 110 };
		const data = await recordWithHelper(
			() => WINDOW_BOUNDS,
			(emit) => {
				emit(click(1_100));
				mocks.cursor = { x: 400, y: 890 };
				emit(click(1_200));
			},
		);

		expect(data.samples[0]).toMatchObject({
			cx: 0.2,
			cy: 10 / 800,
			visible: true,
			interactionType: "click",
		});
		expect(data.samples[1]).toMatchObject({
			cx: 0.2,
			cy: 790 / 800,
			visible: true,
			interactionType: "click",
		});
	});

	it("replaces the source frame with later bounds and leaves a display frame unshifted", async () => {
		// The picker frame sits below the pixels. The helper's capture rect replaces it;
		// the next sample must not keep the old origin. A full display then maps as itself.
		let bounds: Rectangle = { x: 200, y: 180, width: 1000, height: 800 };
		mocks.cursor = { x: 700, y: 500 };
		const data = await recordWithHelper(
			() => bounds,
			(emit) => {
				emit(click(1_100));
				bounds = { x: 200, y: 120, width: 1000, height: 860 };
				emit(click(1_200));
				bounds = { x: 0, y: 0, width: 1920, height: 1080 };
				mocks.cursor = { x: 960, y: 540 };
				emit(click(1_300));
			},
		);

		expect(data.samples[0].cy).toBeCloseTo((500 - 180) / 800, 5);
		expect(data.samples[1].cx).toBeCloseTo((700 - 200) / 1000, 5);
		expect(data.samples[1].cy).toBeCloseTo((500 - 120) / 860, 5);
		expect(data.samples[2]).toMatchObject({ cx: 0.5, cy: 0.5 });
	});

	it("rebases samples collected before the authoritative bounds arrive", async () => {
		let bounds: Rectangle = { x: 0, y: 0, width: 1920, height: 1080 };
		mocks.cursor = { x: 400, y: 300 };
		const session = new MacNativeCursorRecordingSession({
			getDisplayBounds: () => bounds,
			maxSamples: 20,
			sampleIntervalMs: 33,
			startTimeMs: 1_000,
		});
		const pending = session.start();
		await Promise.resolve();
		helper.emitEvent({ type: "ready", timestampMs: 1_000 });
		await pending;
		helper.emitEvent(click(1_100));

		bounds = WINDOW_BOUNDS;
		session.updateCaptureBounds(bounds);

		const data = await session.stop();
		expect(data.samples[0]).toMatchObject({
			cx: 0.2,
			cy: 0.25,
			visible: true,
			interactionType: "click",
		});
	});

	it("falls back to the display under the pointer when no capture bounds exist", async () => {
		// No helper on disk: position-only sampling, and nothing has reported a capture rect.
		mocks.accessSync.mockImplementation(() => {
			throw new Error("ENOENT");
		});
		mocks.nearestDisplay = {
			scaleFactor: 2,
			bounds: { x: 0, y: 0, width: 1440, height: 900 },
		};
		mocks.cursor = { x: 720, y: 450 };
		const session = new MacNativeCursorRecordingSession({
			getDisplayBounds: () => null,
			maxSamples: 5,
			sampleIntervalMs: 60_000,
			startTimeMs: 1_000,
		});

		await session.start();
		const data = await session.stop();

		expect(spawnMock).not.toHaveBeenCalled();
		expect(data.provider).toBe("none");
		expect(data.samples[0]).toMatchObject({ cx: 0.5, cy: 0.5, visible: true });
	});

	it("clamps a brief exit and hides the pointer only after a sustained one", async () => {
		// Outside the window, above its top edge. The first two stay visible at the
		// clamp; the third crosses the hide threshold. One sample back inside clears it.
		mocks.cursor = { x: 1_400, y: 40 };
		const data = await recordWithHelper(
			() => WINDOW_BOUNDS,
			(emit) => {
				emit({ type: "sample", timestampMs: 1_100 });
				emit({ type: "sample", timestampMs: 1_133 });
				emit({ type: "sample", timestampMs: 1_166 });
				mocks.cursor = { x: 700, y: 500 };
				emit({ type: "sample", timestampMs: 1_200 });
			},
		);

		expect(data.samples.slice(0, 3).map((sample) => sample.visible)).toEqual([true, true, false]);
		expect(data.samples[0]).toMatchObject({ cx: 1, cy: 0 });
		expect(data.samples[2]).toMatchObject({ cx: 1, cy: 0, visible: false });
		expect(data.samples[3]).toMatchObject({ cx: 0.5, cy: 0.5, visible: true });
	});
});
