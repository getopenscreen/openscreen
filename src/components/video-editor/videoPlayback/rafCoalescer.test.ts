import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRafCoalescer } from "./rafCoalescer";

describe("createRafCoalescer", () => {
	let rafCallbacks: FrameRequestCallback[];
	let nextRafId: number;

	beforeEach(() => {
		rafCallbacks = [];
		nextRafId = 1;
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
			rafCallbacks.push(cb);
			return nextRafId++;
		});
		vi.stubGlobal("cancelAnimationFrame", (id: number) => {
			// Mark the callback as a no-op instead of removing it, to mirror the
			// browser's index-stable semantics.
			const index = id - 1;
			if (rafCallbacks[index]) {
				rafCallbacks[index] = () => {
					// Cancelled: no-op.
				};
			}
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function flushOneFrame(timeMs = 0) {
		const callbacks = rafCallbacks;
		rafCallbacks = [];
		for (const cb of callbacks) cb(timeMs);
	}

	it("does not call flush until an animation frame runs", () => {
		const flush = vi.fn();
		const coalescer = createRafCoalescer<number>(flush);

		coalescer.schedule(1);

		expect(flush).not.toHaveBeenCalled();
	});

	it("collapses multiple schedule calls within the same frame into a single flush", () => {
		const flush = vi.fn();
		const coalescer = createRafCoalescer<number>(flush);

		coalescer.schedule(1);
		coalescer.schedule(2);
		coalescer.schedule(3);

		flushOneFrame();

		expect(flush).toHaveBeenCalledTimes(1);
		expect(flush).toHaveBeenCalledWith(3);
	});

	it("schedules a fresh frame for values reported after the previous frame flushed", () => {
		const flush = vi.fn();
		const coalescer = createRafCoalescer<number>(flush);

		coalescer.schedule(1);
		flushOneFrame();
		coalescer.schedule(2);
		flushOneFrame();

		expect(flush).toHaveBeenCalledTimes(2);
		expect(flush).toHaveBeenNthCalledWith(1, 1);
		expect(flush).toHaveBeenNthCalledWith(2, 2);
	});

	it("cancel() prevents a pending flush from firing", () => {
		const flush = vi.fn();
		const coalescer = createRafCoalescer<number>(flush);

		coalescer.schedule(1);
		coalescer.cancel();
		flushOneFrame();

		expect(flush).not.toHaveBeenCalled();
	});

	it("a schedule() call after cancel() still flushes on the next frame", () => {
		const flush = vi.fn();
		const coalescer = createRafCoalescer<number>(flush);

		coalescer.schedule(1);
		coalescer.cancel();
		coalescer.schedule(2);
		flushOneFrame();

		expect(flush).toHaveBeenCalledTimes(1);
		expect(flush).toHaveBeenCalledWith(2);
	});
});
