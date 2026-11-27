// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCameraLook } from "./useCameraLook";

type Prefs = { camShape: "square" | null; camRoundness: number | null };

let saved: Prefs;
const setRecordingPrefs = vi.fn();
const getRecordingPrefs = vi.fn(async () => saved);

beforeEach(() => {
	saved = { camShape: null, camRoundness: null };
	setRecordingPrefs.mockReset();
	getRecordingPrefs.mockClear();
	window.electronAPI = {
		getRecordingPrefs,
		setRecordingPrefs,
		onRecordingPrefsChanged: () => () => undefined,
	} as unknown as Window["electronAPI"];
});

afterEach(() => vi.restoreAllMocks());

describe("useCameraLook", () => {
	it("starts on Default at the editor's square rounding, and shows a pick at once", async () => {
		setRecordingPrefs.mockResolvedValue(undefined);
		const { result } = renderHook(() => useCameraLook());
		await waitFor(() => expect(getRecordingPrefs).toHaveBeenCalled());
		expect(result.current).toMatchObject({ shape: "default", roundness: 0.7 });

		act(() => result.current.setShape("square"));

		expect(result.current.shape).toBe("square");
		expect(setRecordingPrefs).toHaveBeenCalledWith({ camShape: "square" });
	});

	it("goes back to the saved look when a write fails", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		setRecordingPrefs.mockRejectedValue(new Error("disk full"));
		const { result } = renderHook(() => useCameraLook());
		await waitFor(() => expect(getRecordingPrefs).toHaveBeenCalled());

		act(() => result.current.setShape("square"));
		expect(result.current.shape).toBe("square");

		await waitFor(() => expect(result.current.shape).toBe("default"));
	});

	it("keeps a newer pick when an older write fails late", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		let failFirst: ((error: Error) => void) | undefined;
		setRecordingPrefs
			.mockImplementationOnce(
				() =>
					new Promise((_, reject) => {
						failFirst = reject;
					}),
			)
			.mockResolvedValue(undefined);
		const { result } = renderHook(() => useCameraLook());
		await waitFor(() => expect(getRecordingPrefs).toHaveBeenCalled());

		act(() => result.current.setShape("square"));
		act(() => result.current.setRoundness(0.25));
		saved = { camShape: null, camRoundness: 0.25 };
		await act(async () => {
			failFirst?.(new Error("disk full"));
		});

		expect(result.current).toMatchObject({ shape: "square", roundness: 0.25 });
	});
});
