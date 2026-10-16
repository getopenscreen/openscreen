// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLEARED_AFTER_FRAMES, CountdownOverlay } from "./CountdownOverlay";

type ValueListener = (value: number | null, runId: number) => void;

describe("CountdownOverlay", () => {
	let pushValue: ValueListener = () => undefined;
	let frames: FrameRequestCallback[] = [];
	let textAtFrameRequest: string[] = [];
	let notifyCleared: ReturnType<typeof vi.fn>;
	let container: HTMLElement;

	beforeEach(() => {
		frames = [];
		textAtFrameRequest = [];
		notifyCleared = vi.fn();
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			textAtFrameRequest.push(container?.textContent ?? "");
			frames.push(callback);
			return frames.length;
		});
		window.electronAPI = {
			...window.electronAPI,
			onCountdownOverlayValue: (listener: ValueListener) => {
				pushValue = listener;
				return () => undefined;
			},
			notifyCountdownOverlayCleared: notifyCleared,
		} as typeof window.electronAPI;
		({ container } = render(<CountdownOverlay />));
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	/** Runs the display frame the renderer is waiting on. */
	const nextFrame = () => {
		const callback = frames.shift();
		if (!callback) {
			throw new Error("no animation frame was requested");
		}
		act(() => callback(performance.now()));
	};

	it("reports the clear only after the empty state has been painted for a few frames", () => {
		act(() => pushValue(1, 9));
		expect(container.textContent).toBe("1");

		act(() => pushValue(null, 9));

		// The digit is gone before the first frame is even requested, so every frame counted
		// is a frame without it — a batched update would have counted one that still had it.
		expect(textAtFrameRequest[0]).toBe("");
		for (let frame = 1; frame < CLEARED_AFTER_FRAMES; frame += 1) {
			nextFrame();
			expect(notifyCleared).not.toHaveBeenCalled();
		}
		nextFrame();
		expect(notifyCleared).toHaveBeenCalledExactlyOnceWith(9);
		expect(frames).toHaveLength(0);
	});

	it("reports nothing while it is showing a digit", () => {
		act(() => pushValue(3, 2));
		act(() => pushValue(2, 2));

		expect(frames).toHaveLength(0);
		expect(notifyCleared).not.toHaveBeenCalled();
	});
});
