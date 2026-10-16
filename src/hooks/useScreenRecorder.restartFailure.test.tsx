// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => key,
}));

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

// The browser pipeline's MediaRecorder, cut down to what Restart touches: a stop that
// fires "stop", and a take already streamed to disk.
vi.mock("./recorderHandle", () => ({
	createRecorderHandle: () => {
		const recorder = Object.assign(new EventTarget(), {
			state: "recording" as RecordingState,
			stop: () => undefined,
		});
		recorder.stop = () => {
			recorder.state = "inactive";
			recorder.dispatchEvent(new Event("stop"));
		};
		return {
			recorder,
			recordedBlobPromise: Promise.resolve(new Blob()),
			isStreaming: () => true,
			discard: async () => undefined,
		};
	},
}));

import { toast } from "sonner";
import { useScreenRecorder } from "./useScreenRecorder";

type ElectronAPI = Window["electronAPI"];
type RecorderView = { result: { current: ReturnType<typeof useScreenRecorder> } };

const SOURCE = { id: "screen:0:0", name: "Screen 1", display_id: "1", thumbnail: "" };

let api: Record<string, ReturnType<typeof vi.fn>>;

/** The platform is pinned through `getPlatform`, which is what the hook branches on. */
function stubElectronAPI(platform: "win32" | "linux") {
	api = {
		getRecordingPrefs: vi.fn(async () => null),
		getPlatform: vi.fn(() => platform),
		getSelectedSource: vi.fn(async () => SOURCE),
		showCountdownOverlay: vi.fn(async () => true),
		setCountdownOverlayValue: vi.fn(async () => true),
		hideCountdownOverlay: vi.fn(async () => true),
		setRecordingState: vi.fn(),
		discardCursorTelemetry: vi.fn(),
		isNativeWindowsCaptureAvailable: vi.fn(async () => ({ success: true, available: true })),
		startNativeWindowsRecording: vi.fn(async () => ({ success: true, recordingId: 7 })),
		stopNativeWindowsRecording: vi.fn(async () => ({ success: true, discarded: true })),
		isNativeLinuxCaptureAvailable: vi.fn(async () => ({ success: true, available: true })),
		prepareNativeLinuxRecording: vi.fn(async () => ({ success: false })),
		cancelNativeLinuxPrepare: vi.fn(async () => ({ success: true })),
		startNativeLinuxRecording: vi.fn(async () => ({ success: true, recordingId: 7 })),
		stopNativeLinuxRecording: vi.fn(async () => ({ success: true, discarded: true })),
	};
	window.electronAPI = api as unknown as ElectronAPI;
}

/** A Linux machine without the PipeWire helper: the browser pipeline records. */
function stubBrowserCapture() {
	stubElectronAPI("linux");
	api.isNativeLinuxCaptureAvailable.mockResolvedValue({
		success: true,
		available: false,
		reason: "missing-helper",
	});
	const videoTrack = {
		stop: vi.fn(),
		applyConstraints: vi.fn(async () => undefined),
		getSettings: () => ({ width: 1920, height: 1080, frameRate: 60 }),
	};
	const getUserMedia = vi.fn(async () => ({
		getTracks: () => [videoTrack],
		getVideoTracks: () => [videoTrack],
		getAudioTracks: () => [],
	}));
	Object.defineProperty(navigator, "mediaDevices", {
		configurable: true,
		value: { getUserMedia },
	});
	vi.stubGlobal(
		"MediaStream",
		class {
			private tracks: unknown[] = [];
			addTrack(track: unknown) {
				this.tracks.push(track);
			}
			getTracks() {
				return this.tracks;
			}
			getAudioTracks() {
				return [];
			}
		},
	);
	vi.stubGlobal("MediaRecorder", { isTypeSupported: () => true });
	return getUserMedia;
}

/** Runs every pending timer and microtask; `waitFor` would poll the faked timers. */
async function settle(ms = 0) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

/** Through the 3 s countdown into a running take. */
async function startTake(view: RecorderView) {
	await settle();
	await act(async () => {
		view.result.current.toggleRecording();
	});
	await settle(3_500);
	expect(view.result.current.recording).toBe(true);
}

async function restart(view: RecorderView) {
	await act(async () => {
		await view.result.current.restartRecording();
	});
	await settle();
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.mocked(toast.error).mockClear();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	Reflect.deleteProperty(navigator, "mediaDevices");
});

// Restart discards the take before the next one is asked for. When that one does not
// start, the take is gone and the user has to be told (#995).
describe("useScreenRecorder Restart that does not start a new take", () => {
	it("says the take was discarded on native Windows", async () => {
		stubElectronAPI("win32");
		const view = renderHook(() => useScreenRecorder());
		await startTake(view);

		api.startNativeWindowsRecording.mockResolvedValue({
			success: false,
			error: "Timed out waiting for native Windows capture to start",
		});
		await restart(view);

		expect(api.stopNativeWindowsRecording).toHaveBeenCalledWith(true);
		expect(api.startNativeWindowsRecording).toHaveBeenCalledTimes(2);
		expect(view.result.current.recording).toBe(false);
		expect(toast.error).toHaveBeenCalledWith("recording.restartFailed");
	});

	it("says nothing more on native Windows when the new take starts", async () => {
		stubElectronAPI("win32");
		const view = renderHook(() => useScreenRecorder());
		await startTake(view);

		await restart(view);

		expect(view.result.current.recording).toBe(true);
		expect(toast.error).not.toHaveBeenCalledWith("recording.restartFailed");
	});

	it("says the take was discarded on native Linux when the portal picker is dismissed", async () => {
		stubElectronAPI("linux");
		const view = renderHook(() => useScreenRecorder());
		await startTake(view);

		api.startNativeLinuxRecording.mockResolvedValue({
			success: false,
			error: "Error: the screen share was cancelled",
		});
		await restart(view);

		expect(api.stopNativeLinuxRecording).toHaveBeenCalledWith(true);
		expect(api.startNativeLinuxRecording).toHaveBeenCalledTimes(2);
		expect(view.result.current.recording).toBe(false);
		expect(toast.error).toHaveBeenCalledWith("recording.restartFailed");
	});

	it("says nothing more on native Linux when the new take starts", async () => {
		stubElectronAPI("linux");
		const view = renderHook(() => useScreenRecorder());
		await startTake(view);

		await restart(view);

		expect(view.result.current.recording).toBe(true);
		expect(toast.error).not.toHaveBeenCalledWith("recording.restartFailed");
	});

	it("says the take was discarded on the browser pipeline when capture fails", async () => {
		const getUserMedia = stubBrowserCapture();
		const view = renderHook(() => useScreenRecorder());
		await startTake(view);

		getUserMedia.mockRejectedValue(new Error("Could not start video source"));
		await restart(view);

		expect(api.discardCursorTelemetry).toHaveBeenCalled();
		expect(getUserMedia).toHaveBeenCalledTimes(2);
		expect(view.result.current.recording).toBe(false);
		expect(toast.error).toHaveBeenCalledWith("recording.restartFailed");
	});

	it("says nothing more on the browser pipeline when the new take starts", async () => {
		const getUserMedia = stubBrowserCapture();
		const view = renderHook(() => useScreenRecorder());
		await startTake(view);

		await restart(view);

		expect(getUserMedia).toHaveBeenCalledTimes(2);
		expect(view.result.current.recording).toBe(true);
		expect(toast.error).not.toHaveBeenCalledWith("recording.restartFailed");
	});
});
