import { describe, expect, it, vi } from "vitest";
import { createNativeMacMidCaptureErrorWatch } from "./nativeMacMidCaptureErrorWatch";

describe("createNativeMacMidCaptureErrorWatch", () => {
	const error = { event: "error", code: "writer-failed-during-capture" };

	it("fires on an error raised after recording started", () => {
		const onError = vi.fn();
		const watch = createNativeMacMidCaptureErrorWatch(() => true, onError);

		watch({ event: "ready" });
		watch({ event: "recording-started" });
		watch(error);

		expect(onError).toHaveBeenCalledTimes(1);
	});

	it("leaves an error raised before recording started to the start wait", () => {
		const onError = vi.fn();
		const watch = createNativeMacMidCaptureErrorWatch(() => true, onError);

		watch(error);

		expect(onError).not.toHaveBeenCalled();
	});

	it("ignores events that are not errors", () => {
		const onError = vi.fn();
		const watch = createNativeMacMidCaptureErrorWatch(() => true, onError);

		watch({ event: "recording-started" });
		watch({ event: "warning", code: "stop-capture-failed" });
		watch({ event: "recording-stopped" });

		expect(onError).not.toHaveBeenCalled();
	});

	it("ignores a helper that is no longer the current process", () => {
		const onError = vi.fn();
		let current = true;
		const watch = createNativeMacMidCaptureErrorWatch(() => current, onError);

		watch({ event: "recording-started" });
		current = false;
		watch(error);

		expect(onError).not.toHaveBeenCalled();
	});

	/** Killed or crashed: no error line ever comes, only the process closing. */
	it("fires when the helper exits in the middle of a take", () => {
		const onTakeEnded = vi.fn();
		const watch = createNativeMacMidCaptureErrorWatch(() => true, onTakeEnded);

		watch({ event: "recording-started" });
		watch.exited();

		expect(onTakeEnded).toHaveBeenCalledTimes(1);
	});

	it("leaves an exit before recording started to the start wait", () => {
		const onTakeEnded = vi.fn();
		const watch = createNativeMacMidCaptureErrorWatch(() => true, onTakeEnded);

		watch.exited();

		expect(onTakeEnded).not.toHaveBeenCalled();
	});

	/** The exit a stop causes is the stop working, not the take ending under the user. */
	it("ignores the exit of a take that is already being stopped", () => {
		const onTakeEnded = vi.fn();
		let live = true;
		const watch = createNativeMacMidCaptureErrorWatch(() => live, onTakeEnded);

		watch({ event: "recording-started" });
		live = false;
		watch.exited();

		expect(onTakeEnded).not.toHaveBeenCalled();
	});
});
