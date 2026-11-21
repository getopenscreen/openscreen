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

// A webcam recorder that runs until stopped, so a leaked one is visible as still recording.
vi.mock("./recorderHandle", () => ({
	createRecorderHandle: vi.fn(() => {
		const recorder = {
			state: "recording" as RecordingState,
			stop: vi.fn(() => {
				recorder.state = "inactive";
			}),
		};
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
import type { RecordingStartOutcome } from "./useScreenRecorder";
import { useScreenRecorder } from "./useScreenRecorder";

type ElectronAPI = Window["electronAPI"];
type Handle = {
	recorder: { state: RecordingState; stop: ReturnType<typeof vi.fn> };
	discard: ReturnType<typeof vi.fn>;
};

const SOURCE = { id: "screen:0:0", name: "Screen 1", display_id: "1", thumbnail: "" };

let api: Record<string, ReturnType<typeof vi.fn>>;

function stubElectronAPI(platform: "linux" | "darwin") {
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
		getPlatform: vi.fn(() => platform),
		getSelectedSource: vi.fn(async () => (platform === "linux" ? null : SOURCE)),
		setRecordingState: vi.fn(async () => ({ success: true })),
		isNativeLinuxCaptureAvailable: vi.fn(async () => ({ success: true, available: true })),
		prepareNativeLinuxRecording: vi.fn(async () => ({ success: true, recordingId: 7 })),
		cancelNativeLinuxPrepare: vi.fn(async () => ({ success: true })),
		startNativeLinuxRecording: vi.fn(async () => ({ success: true, recordingId: 7 })),
		stopNativeLinuxRecording: vi.fn(async () => ({ success: true, discarded: true })),
		isNativeMacCaptureAvailable: vi.fn(async () => ({ success: true, available: true })),
		startNativeMacRecording: vi.fn(async () => ({ success: true, recordingId: 7 })),
		stopNativeMacRecording: vi.fn(async () => ({ success: true, discarded: true })),
		showCountdownOverlay: vi.fn(async () => true),
		setCountdownOverlayValue: vi.fn(async () => true),
		hideCountdownOverlay: vi.fn(async () => true),
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

async function pressRecord() {
	const view = renderHook(() => useScreenRecorder());
	await settle();
	await act(async () => {
		view.result.current.toggleRecording();
	});
	await settle(3_500);
	return view;
}

/** The webcam recorders the take created, each of which must end stopped and deleted. */
function webcamHandles(): Handle[] {
	return vi.mocked(createRecorderHandle).mock.results.map((result) => result.value as Handle);
}

function expectEveryWebcamRecorderDiscarded() {
	const handles = webcamHandles();
	expect(handles).toHaveLength(1);
	for (const handle of handles) {
		expect(handle.recorder.state).toBe("inactive");
		expect(handle.discard).toHaveBeenCalledOnce();
	}
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.mocked(createRecorderHandle).mockClear();
	vi.mocked(toast.error).mockClear();
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("a dismissed source picker cancels the start (rc.3 Linux pass)", () => {
	it("drops the start when the portal picker is dismissed before the countdown", async () => {
		stubElectronAPI("linux");
		api.prepareNativeLinuxRecording.mockResolvedValue({
			success: false,
			reason: "portal-cancelled",
		});

		const view = await pressRecord();

		expect(api.showCountdownOverlay).not.toHaveBeenCalled();
		expect(api.startNativeLinuxRecording).not.toHaveBeenCalled();
		expect(createRecorderHandle).not.toHaveBeenCalled();
		expect(toast.error).not.toHaveBeenCalled();
		expect(view.result.current.recording).toBe(false);
	});

	it("stops and deletes the webcam recording when the start's own picker is dismissed", async () => {
		stubElectronAPI("linux");
		// No prepare (X11, or a prepare that failed): the picker comes with the start.
		api.prepareNativeLinuxRecording.mockResolvedValue({ success: false });
		api.startNativeLinuxRecording.mockResolvedValue({ success: false, cancelled: true });

		const view = await pressRecord();

		expect(api.startNativeLinuxRecording).toHaveBeenCalledOnce();
		expectEveryWebcamRecorderDiscarded();
		expect(toast.error).not.toHaveBeenCalled();
		expect(view.result.current.recording).toBe(false);
	});
});

describe("a failed native start never leaves the webcam recording", () => {
	it("stops and deletes the webcam recording when the Linux start fails", async () => {
		stubElectronAPI("linux");
		api.startNativeLinuxRecording.mockResolvedValue({ success: false, error: "no PipeWire" });

		const view = await pressRecord();

		expectEveryWebcamRecorderDiscarded();
		expect(toast.error).toHaveBeenCalledWith("no PipeWire");
		expect(view.result.current.recording).toBe(false);
	});

	it("stops and deletes the webcam recording when the macOS start fails", async () => {
		stubElectronAPI("darwin");
		api.startNativeMacRecording.mockResolvedValue({
			success: false,
			error: "The user declined TCCs for application, window, display capture",
		});

		const view = await pressRecord();

		expect(api.startNativeMacRecording).toHaveBeenCalledOnce();
		expectEveryWebcamRecorderDiscarded();
		expect(view.result.current.recording).toBe(false);
	});

	it("keeps the webcam recording of a take that started", async () => {
		stubElectronAPI("linux");

		const view = await pressRecord();

		expect(view.result.current.recording).toBe(true);
		const [handle] = webcamHandles();
		expect(handle.recorder.state).toBe("recording");
		expect(handle.discard).not.toHaveBeenCalled();
	});
});

describe("the immediate start reports its outcome", () => {
	const METADATA_FAILURE =
		"The ScreenCast portal does not advertise METADATA cursor mode, so real cursor positions cannot be obtained on this session.";

	async function startImmediately() {
		const view = renderHook(() => useScreenRecorder());
		await settle();
		let outcome: RecordingStartOutcome | undefined;
		await act(async () => {
			outcome = await view.result.current.startRecordingImmediately();
		});
		await settle();
		return { view, outcome };
	}

	it("returns the recorder's own reason when the native start fails", async () => {
		stubElectronAPI("linux");
		api.startNativeLinuxRecording.mockResolvedValue({ success: false, error: METADATA_FAILURE });

		const { view, outcome } = await startImmediately();

		expect(outcome).toEqual({ kind: "failed", message: METADATA_FAILURE });
		expect(toast.error).toHaveBeenCalledWith(METADATA_FAILURE);
		expect(view.result.current.recording).toBe(false);
	});

	it("returns cancelled, without a toast, when the picker is dismissed", async () => {
		stubElectronAPI("linux");
		api.startNativeLinuxRecording.mockResolvedValue({ success: false, cancelled: true });

		const { view, outcome } = await startImmediately();

		expect(outcome).toEqual({ kind: "cancelled" });
		expect(toast.error).not.toHaveBeenCalled();
		expect(view.result.current.recording).toBe(false);
	});

	it("returns started when the take comes up", async () => {
		stubElectronAPI("linux");

		const { view, outcome } = await startImmediately();

		expect(outcome).toEqual({ kind: "started" });
		expect(view.result.current.recording).toBe(true);
	});
});
