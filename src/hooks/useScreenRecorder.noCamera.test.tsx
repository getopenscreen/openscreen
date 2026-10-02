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
			expect(setRecordingPrefs).toHaveBeenCalledWith({ camEnabled: false });
		});
		expect(view.result.current.webcamEnabled).toBe(false);
		expect(toast.error).toHaveBeenCalledWith("recording.cameraNotFound");
	});
});
