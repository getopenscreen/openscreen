// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFloatingCameraPreview } from "./useFloatingCameraPreview";

vi.mock("../utils/platformUtils", () => ({ getPlatform: () => platform }));
let platform = "darwin";
let hidden: (() => void) | undefined;
let availability: ((available: boolean) => void) | undefined;
const configure = vi.fn().mockResolvedValue(undefined);
const send = vi.fn().mockResolvedValue(undefined);
const unsubscribe = vi.fn();
const stop = vi.fn();
const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;

beforeEach(() => {
	vi.useFakeTimers();
	platform = "darwin";
	vi.clearAllMocks();
	Object.defineProperty(window, "electronAPI", {
		configurable: true,
		value: {
			configureCameraPreview: configure,
			sendCameraPreviewFrame: send,
			onCameraPreviewAvailability: (callback: (available: boolean) => void) => {
				availability = callback;
				return () => undefined;
			},
			onCameraPreviewHidden: (callback: () => void) => {
				hidden = callback;
				return unsubscribe;
			},
		},
	});
	vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
		drawImage: vi.fn(),
	} as unknown as CanvasRenderingContext2D);
	vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
		"data:image/jpeg;base64,frame",
	);
	vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(2);
	vi.spyOn(HTMLVideoElement.prototype, "videoWidth", "get").mockReturnValue(1280);
	vi.spyOn(HTMLVideoElement.prototype, "videoHeight", "get").mockReturnValue(720);
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("floating camera publisher", () => {
	it("shares frames without acquiring or stopping the recording camera", async () => {
		const { unmount } = renderHook(() => useFloatingCameraPreview(stream, true));
		expect(configure).toHaveBeenLastCalledWith(true, true);
		expect(send).toHaveBeenCalledOnce();
		expect(send).toHaveBeenCalledWith("data:image/jpeg;base64,frame", 1280 / 720);
		await act(() => vi.advanceTimersByTimeAsync(300));
		expect(send).toHaveBeenCalledTimes(4);
		unmount();
		await vi.advanceTimersByTimeAsync(500);
		expect(send).toHaveBeenCalledTimes(4);
		expect(stop).not.toHaveBeenCalled();
		expect(configure).toHaveBeenLastCalledWith(false, false);
		expect(unsubscribe).toHaveBeenCalledOnce();
	});

	it("hides without disabling the camera, then resumes from the HUD control", () => {
		const { result } = renderHook(() => useFloatingCameraPreview(stream, true));
		act(() => hidden?.());
		expect(configure).toHaveBeenLastCalledWith(true, false);
		expect(result.current.visible).toBe(false);
		act(() => result.current.toggle());
		expect(configure).toHaveBeenLastCalledWith(true, true);
		expect(stop).not.toHaveBeenCalled();
	});

	it("applies backpressure while a previous frame is still being delivered", async () => {
		let delivered: (() => void) | undefined;
		send.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					delivered = resolve;
				}),
		);
		renderHook(() => useFloatingCameraPreview(stream, true));
		await act(() => vi.advanceTimersByTimeAsync(1000));
		expect(send).toHaveBeenCalledOnce();
		await act(async () => {
			delivered?.();
		});
		await act(() => vi.advanceTimersByTimeAsync(100));
		expect(send).toHaveBeenCalledTimes(2);
	});

	it("waits for the recorder stream and ignores unsupported platforms", () => {
		const { rerender, unmount } = renderHook(
			({ enabled }) => useFloatingCameraPreview(null, enabled),
			{ initialProps: { enabled: true } },
		);
		expect(configure).toHaveBeenLastCalledWith(true, false);
		expect(send).not.toHaveBeenCalled();
		rerender({ enabled: false });
		expect(configure).toHaveBeenLastCalledWith(false, false);
		unmount();
		configure.mockClear();
		platform = "unknown";
		renderHook(() => useFloatingCameraPreview(stream, true));
		expect(configure).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
	});
	it.each(["darwin", "win32", "linux"])("publishes preview frames on %s", (value) => {
		platform = value;
		const { result } = renderHook(() => useFloatingCameraPreview(stream, true));
		expect(result.current.supported).toBe(true);
		expect(configure).toHaveBeenLastCalledWith(true, true);
		expect(send).toHaveBeenCalledOnce();
	});

	it("keeps the window visible after Windows hands the camera to the native recorder", () => {
		platform = "win32";
		const { rerender } = renderHook(
			({ camera, native }) => useFloatingCameraPreview(camera, true, native),
			{ initialProps: { camera: stream as MediaStream | null, native: false } },
		);
		rerender({ camera: null, native: true });
		expect(configure).toHaveBeenLastCalledWith(true, true);
		expect(stop).not.toHaveBeenCalled();
	});

	it("suspends publishing for Linux monitor capture and restores the visibility preference", async () => {
		platform = "linux";
		const { result } = renderHook(() => useFloatingCameraPreview(stream, true));
		act(() => availability?.(false));
		expect(result.current.available).toBe(false);
		expect(result.current.visible).toBe(true);
		await act(() => vi.advanceTimersByTimeAsync(500));
		expect(send).toHaveBeenCalledOnce();
		act(() => availability?.(true));
		expect(result.current.available).toBe(true);
		expect(send).toHaveBeenCalledTimes(2);
	});
});
