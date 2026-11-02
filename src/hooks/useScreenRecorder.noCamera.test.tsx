// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => key,
}));

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/requestCameraAccess", () => ({
	requestCameraAccess: vi.fn(async () => ({ success: true, granted: true, status: "granted" })),
}));

import { toast } from "sonner";
import { useScreenRecorder } from "./useScreenRecorder";

type ElectronAPI = Window["electronAPI"];
type RecordingPrefs = Awaited<ReturnType<ElectronAPI["getRecordingPrefs"]>>;

const CAMERA = { kind: "videoinput", deviceId: "cam-1", label: "FaceTime HD Camera", groupId: "" };

function prefs(camEnabled: boolean): RecordingPrefs {
	return {
		micEnabled: false,
		micDeviceId: null,
		micDeviceName: null,
		camEnabled,
		camDeviceId: null,
		camDeviceName: null,
		camQuality: "2160p",
		systemAudioEnabled: false,
		cursorCaptureMode: "editable-overlay",
		hideDesktopIcons: false,
		autoZoomEnabled: true,
		cameraOnly: false,
	};
}

let setRecordingPrefs: ReturnType<typeof vi.fn>;
let enumerateDevices: ReturnType<typeof vi.fn>;
let getUserMedia: ReturnType<typeof vi.fn>;

function stub(stored: RecordingPrefs) {
	setRecordingPrefs = vi.fn(async (patch: Partial<RecordingPrefs>) => ({ ...stored, ...patch }));
	window.electronAPI = {
		getRecordingPrefs: vi.fn(async () => stored),
		setRecordingPrefs,
		onRecordingPrefsChanged: vi.fn(() => () => undefined),
		getPlatform: vi.fn(() => "darwin"),
		getSelectedSource: vi.fn(async () => null),
	} as unknown as ElectronAPI;
	Object.defineProperty(navigator, "mediaDevices", {
		configurable: true,
		value: { enumerateDevices, getUserMedia },
	});
}

describe("useScreenRecorder on a machine without a camera (#967)", () => {
	beforeEach(() => {
		vi.mocked(toast.error).mockClear();
		enumerateDevices = vi.fn(async () => []);
		getUserMedia = vi.fn(async () => {
			throw new DOMException("Requested device not found", "NotFoundError");
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("refuses to turn the camera on when the OS lists none", async () => {
		stub(prefs(false));
		const view = renderHook(() => useScreenRecorder());
		await waitFor(() => expect(view.result.current.recordingPrefsLoaded).toBe(true));

		let ok: boolean | undefined;
		await act(async () => {
			ok = await view.result.current.setWebcamEnabled(true);
		});

		expect(ok).toBe(false);
		expect(view.result.current.webcamEnabled).toBe(false);
		expect(toast.error).toHaveBeenCalledWith("recording.cameraNotFound");
		expect(getUserMedia).not.toHaveBeenCalled();
		expect(setRecordingPrefs).toHaveBeenCalledWith({ camEnabled: false, cameraOnly: false });
	});

	it("still turns a listed camera on", async () => {
		enumerateDevices = vi.fn(async () => [CAMERA]);
		getUserMedia = vi.fn(async () => ({ getVideoTracks: () => [], getTracks: () => [] }));
		stub(prefs(false));
		const view = renderHook(() => useScreenRecorder());
		await waitFor(() => expect(view.result.current.recordingPrefsLoaded).toBe(true));

		let ok: boolean | undefined;
		await act(async () => {
			ok = await view.result.current.setWebcamEnabled(true);
		});

		expect(ok).toBe(true);
		expect(view.result.current.webcamEnabled).toBe(true);
		await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
		expect(setRecordingPrefs).not.toHaveBeenCalled();
	});

	it("stores the camera as off when a stored 'on' cannot open it", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		stub(prefs(true));
		const view = renderHook(() => useScreenRecorder());

		await waitFor(() => {
			expect(setRecordingPrefs).toHaveBeenCalledWith({ camEnabled: false, cameraOnly: false });
		});
		expect(view.result.current.webcamEnabled).toBe(false);
		expect(toast.error).toHaveBeenCalledWith("recording.cameraNotFound");
	});

	// getopenscreen/openscreen#1398 review: a stored camera only must not outlive the camera.
	it("clears camera only with the camera when a stored camera-only take cannot open it", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		stub({ ...prefs(true), cameraOnly: true });
		const view = renderHook(() => useScreenRecorder());

		await waitFor(() => {
			expect(setRecordingPrefs).toHaveBeenCalledWith({ camEnabled: false, cameraOnly: false });
		});
		expect(view.result.current.webcamEnabled).toBe(false);
		expect(view.result.current.cameraOnly).toBe(false);
	});

	// getopenscreen/openscreen#1398 review: a take set up elsewhere cancels a turn-on still
	// waiting on the camera check, and that check answering late must not switch the camera on.
	it("leaves the camera off when a pending turn-on is cancelled", async () => {
		let listDevices!: (devices: unknown[]) => void;
		enumerateDevices = vi.fn(
			() =>
				new Promise((resolve) => {
					listDevices = resolve;
				}),
		);
		stub(prefs(false));
		const view = renderHook(() => useScreenRecorder());
		await waitFor(() => expect(view.result.current.recordingPrefsLoaded).toBe(true));

		let turnedOn!: Promise<boolean>;
		act(() => {
			turnedOn = view.result.current.setWebcamEnabled(true);
		});
		await waitFor(() => expect(enumerateDevices).toHaveBeenCalled());
		act(() => view.result.current.cancelPendingWebcamEnable());
		await act(async () => listDevices([CAMERA]));

		expect(await turnedOn).toBe(false);
		expect(view.result.current.webcamEnabled).toBe(false);
		expect(getUserMedia).not.toHaveBeenCalled();
	});

	it("stores camera only and the camera as off when the camera disconnects", async () => {
		enumerateDevices = vi.fn(async () => [CAMERA]);
		const track: { stop: () => void; onended: (() => void) | null } = {
			stop: vi.fn(),
			onended: null,
		};
		getUserMedia = vi.fn(async () => ({ getVideoTracks: () => [track], getTracks: () => [track] }));
		stub({ ...prefs(true), cameraOnly: true });
		const view = renderHook(() => useScreenRecorder());
		await waitFor(() => expect(track.onended).toBeTypeOf("function"));
		expect(view.result.current.cameraOnly).toBe(true);

		act(() => track.onended?.());

		expect(setRecordingPrefs).toHaveBeenCalledWith({ camEnabled: false, cameraOnly: false });
		expect(view.result.current.webcamEnabled).toBe(false);
		expect(view.result.current.cameraOnly).toBe(false);
		expect(toast.error).toHaveBeenCalledWith("recording.cameraDisconnected");
	});

	it("does not restore camera only from a stored pair whose camera is off", async () => {
		stub({ ...prefs(false), cameraOnly: true });
		const view = renderHook(() => useScreenRecorder());
		await waitFor(() => expect(view.result.current.recordingPrefsLoaded).toBe(true));
		expect(view.result.current.cameraOnly).toBe(false);
	});

	// A saved camera name makes NotFoundError a "wait for the identity" case. In the
	// HUD, useCameraHudSync clears the identity once the list comes back empty, and
	// the acquire that follows takes the failure path.
	it("stores the camera as off once a restored camera identity is cleared", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		stub({ ...prefs(true), camDeviceId: "cam-1", camDeviceName: "FaceTime HD Camera" });
		const view = renderHook(() => useScreenRecorder());
		await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
		expect(view.result.current.webcamEnabled).toBe(true);
		expect(setRecordingPrefs).not.toHaveBeenCalled();

		act(() => {
			view.result.current.setWebcamDeviceId(undefined);
			view.result.current.setWebcamDeviceName(undefined);
		});

		await waitFor(() => {
			expect(setRecordingPrefs).toHaveBeenCalledWith({ camEnabled: false, cameraOnly: false });
		});
		expect(view.result.current.webcamEnabled).toBe(false);
	});
});
