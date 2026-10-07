// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => key,
}));

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { toast } from "sonner";
import { useScreenRecorder } from "./useScreenRecorder";

type ElectronAPI = Window["electronAPI"];

const SOURCE = { id: "screen:0:0", name: "Screen 1", display_id: "1", thumbnail: "" };

let api: Record<string, ReturnType<typeof vi.fn>>;
let emitSystemAudioUnavailable: (() => void) | undefined;
let openAccessibilitySettings: ReturnType<typeof vi.fn>;

function stubElectronAPI(systemAudioEnabled = false) {
	emitSystemAudioUnavailable = undefined;
	openAccessibilitySettings = vi.fn(async () => undefined);
	api = {
		getRecordingPrefs: vi.fn(async () => ({
			micEnabled: true,
			micDeviceId: "chromium-device-id",
			micDeviceName: "USB Microphone",
			camEnabled: false,
			camDeviceId: null,
			systemAudioEnabled,
			cursorCaptureMode: "system",
		})),
		getPlatform: vi.fn(() => "darwin"),
		// ScreenCaptureKit captures the microphone from macOS 15.
		getSystemVersion: vi.fn(() => "15.5"),
		getSelectedSource: vi.fn(async () => SOURCE),
		isNativeMacCaptureAvailable: vi.fn(async () => ({ success: true, available: true })),
		startNativeMacRecording: vi.fn(async () => ({
			success: true,
			recordingId: 7,
			microphoneDefaulted: true,
		})),
		onNativeMacSystemAudioUnavailable: vi.fn((callback: () => void) => {
			emitSystemAudioUnavailable = callback;
			return vi.fn();
		}),
		stopNativeMacRecording: vi.fn(async () => ({ success: true, discarded: true })),
		showCountdownOverlay: vi.fn(async () => true),
		setCountdownOverlayValue: vi.fn(async () => true),
		hideCountdownOverlay: vi.fn(async () => true),
	};
	window.electronAPI = api as unknown as ElectronAPI;
	Object.defineProperty(window.electronAPI, "permissions", {
		value: { openSettings: openAccessibilitySettings },
	});
}

async function settle(ms = 0) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	stubElectronAPI();
	vi.mocked(toast.error).mockClear();
	vi.mocked(toast.warning).mockClear();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("useScreenRecorder native macOS start warnings", () => {
	it("warns but keeps recording when the selected microphone defaults", async () => {
		const view = renderHook(() => useScreenRecorder());
		await settle();

		await act(async () => {
			view.result.current.toggleRecording();
		});
		await settle(3_500);

		expect(api.startNativeMacRecording).toHaveBeenCalledWith(
			expect.objectContaining({
				audio: {
					system: { enabled: false },
					microphone: expect.objectContaining({
						enabled: true,
						deviceId: "chromium-device-id",
						deviceName: "USB Microphone",
					}),
				},
			}),
		);
		expect(view.result.current.recording).toBe(true);
		expect(toast.error).toHaveBeenCalledWith("recording.microphoneDefaulted");
	});

	it("says so when the helper records without the microphone", async () => {
		api.startNativeMacRecording.mockResolvedValue({
			success: true,
			recordingId: 7,
			microphoneUnavailable: true,
		});
		const view = renderHook(() => useScreenRecorder());
		await settle();

		await act(async () => {
			view.result.current.toggleRecording();
		});
		await settle(3_500);

		expect(view.result.current.recording).toBe(true);
		expect(toast.error).toHaveBeenCalledWith("recording.microphoneUnavailable");
	});

	it("warns about unavailable system audio while keeping the screen recording active", async () => {
		stubElectronAPI(true);
		const view = renderHook(() => useScreenRecorder());
		await settle();

		await act(async () => {
			view.result.current.toggleRecording();
		});
		await settle(3_500);
		expect(view.result.current.recording).toBe(true);

		await act(async () => {
			emitSystemAudioUnavailable?.();
		});

		expect(toast.warning).toHaveBeenCalledWith("recording.systemAudioUnavailable");
		expect(view.result.current.recording).toBe(true);
	});

	// A Mac with no audio input recorded the first take with the microphone "on", and the
	// take after a Restart never started (#995). A stored "on" must not reach the helper.
	it("never asks the helper for a microphone the OS does not list, on Restart either", async () => {
		api.setRecordingPrefs = vi.fn(async () => undefined);
		Object.defineProperty(navigator, "mediaDevices", {
			configurable: true,
			value: { enumerateDevices: vi.fn(async () => []) },
		});
		try {
			const view = renderHook(() => useScreenRecorder());
			await settle();

			await act(async () => {
				view.result.current.toggleRecording();
			});
			await settle(3_500);
			expect(view.result.current.recording).toBe(true);

			await act(async () => {
				await view.result.current.restartRecording();
			});
			await settle();

			expect(api.startNativeMacRecording).toHaveBeenCalledTimes(2);
			for (const [request] of api.startNativeMacRecording.mock.calls) {
				expect(request.audio.microphone.enabled).toBe(false);
			}
			expect(api.setRecordingPrefs).toHaveBeenCalledWith({ micEnabled: false });
		} finally {
			Reflect.deleteProperty(navigator, "mediaDevices");
		}
	});

	// macOS 13 and 14 have no `captureMicrophone`: a saved "mic on" would ask for the
	// microphone and record a take without it (#700).
	it("does not apply a saved microphone on macOS 14", async () => {
		api.getSystemVersion.mockReturnValue("14.6.1");
		const view = renderHook(() => useScreenRecorder());
		await settle();
		expect(view.result.current.microphoneEnabled).toBe(false);

		await act(async () => {
			view.result.current.toggleRecording();
		});
		await settle(3_500);

		expect(api.startNativeMacRecording).toHaveBeenCalledWith(
			expect.objectContaining({
				audio: expect.objectContaining({
					microphone: expect.objectContaining({ enabled: false }),
				}),
			}),
		);
	});

	it("continues recording with limited cursor effects when Accessibility is pending", async () => {
		api.getRecordingPrefs.mockResolvedValue({
			micEnabled: false,
			micDeviceId: null,
			micDeviceName: null,
			camEnabled: false,
			camDeviceId: null,
			camDeviceName: null,
			systemAudioEnabled: false,
			cursorCaptureMode: "editable-overlay",
			hideDesktopIcons: false,
			autoZoomEnabled: true,
		});
		api.requestNativeMacCursorAccess = vi.fn(async () => ({
			success: true,
			granted: false,
			status: "not-determined",
			accessibilityTrusted: false,
		}));
		const view = renderHook(() => useScreenRecorder());
		await settle();

		await act(async () => {
			view.result.current.toggleRecording();
		});
		await settle(3_500);

		expect(api.requestNativeMacCursorAccess).toHaveBeenCalledOnce();
		expect(api.startNativeMacRecording).toHaveBeenCalledOnce();
		expect(view.result.current.recording).toBe(true);
		expect(toast.warning).toHaveBeenCalledWith(
			"recording.cursorAccessibilityUnavailable",
			expect.objectContaining({
				action: expect.objectContaining({ label: "permissions.actions.openSettings" }),
			}),
		);
		const warningOptions = vi.mocked(toast.warning).mock.calls.at(-1)?.[1] as
			| { action?: { onClick?: () => void } }
			| undefined;

		await act(async () => {
			warningOptions?.action?.onClick?.();
		});

		expect(openAccessibilitySettings).toHaveBeenCalledWith("accessibility");
	});

	it("shows the Accessibility warning once across repeated recording attempts", async () => {
		api.getRecordingPrefs.mockResolvedValue({
			micEnabled: false,
			micDeviceId: null,
			micDeviceName: null,
			camEnabled: false,
			camDeviceId: null,
			camDeviceName: null,
			systemAudioEnabled: false,
			cursorCaptureMode: "editable-overlay",
			hideDesktopIcons: false,
			autoZoomEnabled: true,
		});
		api.requestNativeMacCursorAccess = vi.fn(async () => ({
			success: true,
			granted: false,
			status: "not-determined",
			accessibilityTrusted: false,
		}));
		const view = renderHook(() => useScreenRecorder());
		await settle();

		await act(async () => {
			view.result.current.toggleRecording();
		});
		await settle(1);
		expect(api.requestNativeMacCursorAccess).toHaveBeenCalledOnce();
		expect(api.startNativeMacRecording).not.toHaveBeenCalled();

		await act(async () => {
			view.result.current.toggleRecording();
		});
		await settle();

		await act(async () => {
			view.result.current.toggleRecording();
		});
		await settle(3_500);

		expect(api.requestNativeMacCursorAccess).toHaveBeenCalledTimes(2);
		expect(api.startNativeMacRecording).toHaveBeenCalledOnce();
		expect(toast.warning).toHaveBeenCalledOnce();
		expect(view.result.current.recording).toBe(true);
	});

	// The file starts at the helper's first frame, however late the start reply lands (#901).
	it("counts the HUD timer from the helper's first frame, not from the start reply", async () => {
		api.startNativeMacRecording.mockImplementation(async () => ({
			success: true,
			recordingId: 9,
			startedAtMs: Date.now() - 20_000,
		}));
		const view = renderHook(() => useScreenRecorder());
		await settle();

		await act(async () => {
			view.result.current.toggleRecording();
		});
		await settle(3_500);

		expect(view.result.current.recording).toBe(true);
		expect(view.result.current.elapsedSeconds).toBe(20);
	});

	it("does not warn after the recording start is cancelled", async () => {
		let resolveStart:
			| ((result: Awaited<ReturnType<ElectronAPI["startNativeMacRecording"]>>) => void)
			| null = null;
		api.startNativeMacRecording.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveStart = resolve;
				}),
		);
		const view = renderHook(() => useScreenRecorder());
		await settle();

		await act(async () => {
			view.result.current.toggleRecording();
		});
		await settle(3_500);
		expect(api.startNativeMacRecording).toHaveBeenCalledOnce();

		view.unmount();
		await act(async () => {
			resolveStart?.({ success: true, recordingId: 8, microphoneDefaulted: true });
			await Promise.resolve();
		});

		expect(api.stopNativeMacRecording).toHaveBeenCalledWith(true);
		expect(toast.error).not.toHaveBeenCalled();
	});
});
