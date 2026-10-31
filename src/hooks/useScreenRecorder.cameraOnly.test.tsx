// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// One `t` for every render, as the real context gives: the camera is acquired in an effect
// that depends on it, and a new identity per render would re-open the camera each time.
vi.mock("@/contexts/I18nContext", () => {
	const t = (key: string) => key;
	return { useScopedT: () => t };
});

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/requestCameraAccess", () => ({
	requestCameraAccess: vi.fn(async () => ({ success: true, granted: true, status: "granted" })),
}));

// A recorder that "streamed to disk" and stops the way a real one does: by firing `stop`.
vi.mock("./recorderHandle", () => ({
	createRecorderHandle: vi.fn(() => {
		const recorder = Object.assign(new EventTarget(), {
			state: "recording",
			stop: vi.fn(() => {
				recorder.state = "inactive";
				recorder.dispatchEvent(new Event("stop"));
			}),
		});
		return {
			recorder,
			recordedBlobPromise: Promise.resolve(new Blob()),
			isStreaming: () => true,
			discard: vi.fn(async () => undefined),
		};
	}),
}));

import { toast } from "sonner";
import { createRecorderHandle } from "./recorderHandle";
import { useScreenRecorder } from "./useScreenRecorder";

type ElectronAPI = Window["electronAPI"];

let api: Record<string, ReturnType<typeof vi.fn>>;
let cameraTrack: { stop: ReturnType<typeof vi.fn>; clone: ReturnType<typeof vi.fn> };
let clonedTrack: { stop: ReturnType<typeof vi.fn>; getSettings: () => MediaTrackSettings };

class FakeMediaStream {
	private readonly tracks: unknown[];
	constructor(tracks: unknown[] = []) {
		this.tracks = [...tracks];
	}
	getTracks = () => this.tracks;
	getVideoTracks = () => this.tracks;
	getAudioTracks = () => [];
	addTrack = (track: unknown) => this.tracks.push(track);
}

function stubElectronAPI(camEnabled: boolean) {
	api = {
		getRecordingPrefs: vi.fn(async () => ({
			micEnabled: false,
			micDeviceId: null,
			micDeviceName: null,
			camEnabled,
			camDeviceId: null,
			camDeviceName: null,
			camQuality: "1080p",
			systemAudioEnabled: true,
			cursorCaptureMode: "editable-overlay",
			hideDesktopIcons: false,
			autoZoomEnabled: true,
			cameraOnly: true,
		})),
		setRecordingPrefs: vi.fn(async () => undefined),
		onRecordingPrefsChanged: vi.fn(() => () => undefined),
		// Windows, with no source picked: a screen take would go native, or refuse.
		getPlatform: vi.fn(() => "win32"),
		getSelectedSource: vi.fn(async () => null),
		isNativeWindowsCaptureAvailable: vi.fn(async () => ({ success: true, available: true })),
		startNativeWindowsRecording: vi.fn(),
		showCountdownOverlay: vi.fn(async () => true),
		setCountdownOverlayValue: vi.fn(async () => true),
		hideCountdownOverlay: vi.fn(async () => true),
		setRecordingState: vi.fn(async () => undefined),
		storeRecordedSession: vi.fn(async () => ({
			success: true,
			session: { screenVideoPath: "/rec/recording-1.webm", createdAt: 1 },
		})),
		discardCursorTelemetry: vi.fn(),
		setCurrentRecordingSession: vi.fn(async () => undefined),
		setCurrentVideoPath: vi.fn(async () => undefined),
		switchToEditor: vi.fn(async () => undefined),
	};
	window.electronAPI = api as unknown as ElectronAPI;

	clonedTrack = { stop: vi.fn(), getSettings: () => ({ width: 1920, height: 1080 }) };
	cameraTrack = { stop: vi.fn(), clone: vi.fn(() => clonedTrack) };
	const cameraStream = { getTracks: () => [cameraTrack], getVideoTracks: () => [cameraTrack] };
	Object.defineProperty(navigator, "mediaDevices", {
		configurable: true,
		value: {
			enumerateDevices: vi.fn(async () => [
				{ kind: "videoinput", deviceId: "cam-1", label: "Cam", groupId: "" },
			]),
			getUserMedia: vi.fn(async () => cameraStream),
			getDisplayMedia: vi.fn(),
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		},
	});
	vi.stubGlobal("MediaRecorder", { isTypeSupported: () => true });
	vi.stubGlobal("MediaStream", FakeMediaStream);
}

async function settle(ms = 0) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.mocked(toast.error).mockClear();
	vi.mocked(createRecorderHandle).mockClear();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("useScreenRecorder camera only (#1276)", () => {
	it("records the camera as the take's main video, with no source and no screen capture", async () => {
		stubElectronAPI(true);
		const view = renderHook(() => useScreenRecorder());
		await settle();
		expect(view.result.current.cameraOnly).toBe(true);

		await act(async () => {
			view.result.current.toggleRecording();
		});
		await settle(3_500);

		expect(view.result.current.recording).toBe(true);
		expect(api.isNativeWindowsCaptureAvailable).not.toHaveBeenCalled();
		expect(api.startNativeWindowsRecording).not.toHaveBeenCalled();
		expect(navigator.mediaDevices.getDisplayMedia).not.toHaveBeenCalled();
		// One recorder, fed a clone of the camera's track and named as a screen take.
		expect(createRecorderHandle).toHaveBeenCalledTimes(1);
		const [recordedStream, , fileName] = vi.mocked(createRecorderHandle).mock.calls[0];
		expect(recordedStream.getVideoTracks()).toEqual([clonedTrack]);
		expect(fileName).toMatch(/^recording-\d+\.webm$/);
		// No cursor telemetry: a camera take has nothing for a cursor to point at.
		expect(api.setRecordingState).toHaveBeenCalledWith(true, expect.any(Number), "system");

		await act(async () => {
			view.result.current.toggleRecording();
		});
		await settle();

		expect(api.storeRecordedSession).toHaveBeenCalledTimes(1);
		expect(api.storeRecordedSession).toHaveBeenCalledWith(
			expect.objectContaining({
				screen: expect.objectContaining({ fileName }),
				webcam: undefined,
				cursorCaptureMode: "system",
			}),
		);
		expect(api.switchToEditor).toHaveBeenCalled();
		// The take stopped its own track; the camera preview's track is left running, so
		// its `onended` never reports the camera as disconnected.
		expect(clonedTrack.stop).toHaveBeenCalled();
		expect(cameraTrack.stop).not.toHaveBeenCalled();
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("says a camera is needed instead of recording nothing", async () => {
		stubElectronAPI(true);
		// The camera opens but hands over no video track.
		vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue({
			getTracks: () => [],
			getVideoTracks: () => [],
		} as unknown as MediaStream);
		const view = renderHook(() => useScreenRecorder());
		await settle();

		await act(async () => {
			view.result.current.toggleRecording();
		});
		await settle(3_500);

		expect(view.result.current.recording).toBe(false);
		expect(createRecorderHandle).not.toHaveBeenCalled();
		expect(toast.error).toHaveBeenCalledWith("recording.cameraOnlyNeedsCamera");
	});
});
