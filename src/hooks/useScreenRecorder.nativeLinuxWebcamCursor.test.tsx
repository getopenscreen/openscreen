// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/contexts/I18nContext", () => {
	const translate = (key: string) => key;
	return { useScopedT: () => translate };
});

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/requestCameraAccess", () => ({
	requestCameraAccess: vi.fn(async () => ({ success: true, granted: true, status: "granted" })),
}));

// A webcam that "streamed to disk", so finalize hands back an asset without a real
// MediaRecorder behind it.
vi.mock("./recorderHandle", () => ({
	createRecorderHandle: vi.fn(() => ({
		recorder: { state: "inactive", stop: vi.fn() },
		recordedBlobPromise: Promise.resolve(new Blob()),
		isStreaming: () => true,
		discard: vi.fn(async () => undefined),
	})),
}));

import { useScreenRecorder } from "./useScreenRecorder";

type ElectronAPI = Window["electronAPI"];

let api: Record<string, ReturnType<typeof vi.fn>>;

function stubElectronAPI() {
	api = {
		getRecordingPrefs: vi.fn(async () => ({
			micEnabled: false,
			micDeviceId: null,
			micDeviceName: null,
			camEnabled: true,
			camDeviceId: null,
			camDeviceName: null,
			camQuality: "1080p",
			systemAudioEnabled: false,
			cursorCaptureMode: "system",
			hideDesktopIcons: false,
			autoZoomEnabled: true,
		})),
		setRecordingPrefs: vi.fn(async () => undefined),
		onRecordingPrefsChanged: vi.fn(() => () => undefined),
		getPlatform: vi.fn(() => "linux"),
		getSelectedSource: vi.fn(async () => null),
		isNativeLinuxCaptureAvailable: vi.fn(async () => ({ success: true, available: true })),
		prepareNativeLinuxRecording: vi.fn(async () => ({ success: true, recordingId: 7 })),
		cancelNativeLinuxPrepare: vi.fn(async () => ({ success: true })),
		startNativeLinuxRecording: vi.fn(async () => ({ success: true, recordingId: 7 })),
		stopNativeLinuxRecording: vi.fn(),
		attachNativeLinuxWebcamRecording: vi.fn(async () => ({ success: true, session: {} })),
		showCountdownOverlay: vi.fn(async () => true),
		setCountdownOverlayValue: vi.fn(async () => true),
		hideCountdownOverlay: vi.fn(async () => true),
		setCurrentRecordingSession: vi.fn(async () => undefined),
		setCurrentVideoPath: vi.fn(async () => undefined),
		switchToEditor: vi.fn(async () => undefined),
	};
	window.electronAPI = api as unknown as ElectronAPI;
	const track = { stop: vi.fn(), onended: null, getSettings: () => ({ width: 1280, height: 720 }) };
	const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
	Object.defineProperty(navigator, "mediaDevices", {
		configurable: true,
		value: {
			enumerateDevices: vi.fn(async () => [
				{ kind: "videoinput", deviceId: "cam-1", label: "Cam", groupId: "" },
			]),
			getUserMedia: vi.fn(async () => stream),
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		},
	});
	vi.stubGlobal("MediaRecorder", { isTypeSupported: () => true });
}

async function settle(ms = 0) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	stubElectronAPI();
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("useScreenRecorder native Linux webcam attachment", () => {
	// "system" asked for; main stores what the portal granted. "editable-overlay" is the
	// METADATA fallback of #1357, "system" a portal that did honour EMBEDDED.
	it.each([
		"editable-overlay",
		"system",
	] as const)("attaches the webcam with the stored cursor mode %s", async (stored) => {
		api.stopNativeLinuxRecording.mockResolvedValue({
			success: true,
			path: "/rec/a.mp4",
			session: { screenVideoPath: "/rec/a.mp4", createdAt: 7, cursorCaptureMode: stored },
		});
		const view = renderHook(() => useScreenRecorder());
		await settle();
		await act(async () => {
			view.result.current.toggleRecording();
		});
		await settle(3_500);
		expect(view.result.current.recording).toBe(true);

		await act(async () => {
			view.result.current.toggleRecording();
		});
		await settle();

		expect(api.attachNativeLinuxWebcamRecording).toHaveBeenCalledWith(
			expect.objectContaining({ cursorCaptureMode: stored }),
		);
	});
});

describe("useScreenRecorder native Linux prepare", () => {
	// #1340: a second press while the portal picker was up raised a second picker,
	// and the two prepares discarded each other's grant.
	it("ignores a press while the portal picker is up", async () => {
		let answerPicker: (value: { success: boolean; recordingId: number }) => void = () => undefined;
		api.prepareNativeLinuxRecording = vi.fn(
			() =>
				new Promise((resolve) => {
					answerPicker = resolve;
				}),
		);
		api.cancelNativeLinuxPrepare = vi.fn(async () => ({ success: true }));
		const view = renderHook(() => useScreenRecorder());
		await settle();

		await act(async () => {
			view.result.current.toggleRecording();
		});
		await settle();
		await act(async () => {
			view.result.current.toggleRecording();
		});
		await settle();
		expect(api.prepareNativeLinuxRecording).toHaveBeenCalledTimes(1);

		await act(async () => {
			answerPicker({ success: true, recordingId: 42 });
		});
		await settle(3_500);
		expect(api.startNativeLinuxRecording).toHaveBeenCalledTimes(1);
		expect(api.startNativeLinuxRecording).toHaveBeenCalledWith(
			expect.objectContaining({ recordingId: 42 }),
		);
		expect(view.result.current.recording).toBe(true);
	});
});
