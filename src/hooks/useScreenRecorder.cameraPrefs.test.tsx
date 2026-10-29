// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCameraHudSync } from "./useCameraHudSync";
import { useScreenRecorder } from "./useScreenRecorder";

vi.mock("@/contexts/I18nContext", () => {
	const translate = (key: string) => key;
	return { useScopedT: () => translate };
});
vi.mock("sonner", () => ({ toast: { error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));
vi.mock("./useCameraDevices", () => ({
	useCameraDevices: (_enabled: boolean, preferred?: string) => ({
		selectedDeviceId: preferred ?? "cam-1",
		selectedDevice: { label: preferred === "cam-2" ? "Camera 2" : "Camera 1" },
		isReady: true,
	}),
}));

type Prefs = Awaited<ReturnType<Window["electronAPI"]["getRecordingPrefs"]>>;
const initial: Prefs = {
	micEnabled: false,
	micDeviceId: null,
	micDeviceName: null,
	camEnabled: true,
	camDeviceId: null,
	camDeviceName: null,
	camQuality: "2160p",
	systemAudioEnabled: false,
	cursorCaptureMode: "editable-overlay",
	hideDesktopIcons: false,
	autoZoomEnabled: true,
};

afterEach(() => {
	cleanup();
	window.history.replaceState({}, "", "/");
	vi.restoreAllMocks();
});

function setup(platform = "darwin") {
	window.history.replaceState({}, "", "/?windowType=hud-overlay");
	let publish: ((prefs: Prefs) => void) | undefined;
	const stops: Array<ReturnType<typeof vi.fn>> = [];
	const getUserMedia = vi.fn(async () => {
		const stop = vi.fn();
		stops.push(stop);
		const track = { stop, onended: null };
		return { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
	});
	Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
	window.electronAPI = {
		getPlatform: () => platform,
		getRecordingPrefs: async () => initial,
		onRecordingPrefsChanged: (callback: (prefs: Prefs) => void) => {
			publish = callback;
			return () => undefined;
		},
		hideCountdownOverlay: vi.fn().mockResolvedValue(undefined),
	} as unknown as Window["electronAPI"];
	const view = renderHook(() => {
		const recorder = useScreenRecorder();
		useCameraHudSync(recorder);
		return recorder;
	});
	return { view, getUserMedia, stops, publish: (prefs: Prefs) => publish?.(prefs) };
}

describe("camera preview across recording preference broadcasts", () => {
	it.each([
		"darwin",
		"win32",
		"linux",
	])("keeps the resolved camera alive across audio preferences on %s", async (platform) => {
		const { view, getUserMedia, stops, publish } = setup(platform);
		await waitFor(() => expect(view.result.current.webcamPreviewStream).not.toBeNull());
		const stream = view.result.current.webcamPreviewStream;
		const calls = getUserMedia.mock.calls.length;
		const stop = stops.at(-1);
		await act(async () => {
			view.result.current.setSystemAudioEnabled(true);
			publish({ ...initial, systemAudioEnabled: true });
		});
		await act(async () => {
			view.result.current.setMicrophoneEnabled(true);
			publish({ ...initial, micEnabled: true, systemAudioEnabled: true });
		});
		expect(view.result.current.webcamPreviewStream).toBe(stream);
		expect(getUserMedia).toHaveBeenCalledTimes(calls);
		expect(stop).not.toHaveBeenCalled();
	});

	it("still applies a changed camera selection and an explicit reset to the default", async () => {
		const { view, publish } = setup();
		await waitFor(() => expect(view.result.current.webcamPreviewStream).not.toBeNull());
		const first = view.result.current.webcamPreviewStream;
		await act(async () => publish({ ...initial, camDeviceId: "cam-2", camDeviceName: "Camera 2" }));
		expect(view.result.current.webcamDeviceId).toBe("cam-2");
		expect(view.result.current.webcamPreviewStream).not.toBe(first);
		await act(async () => publish(initial));
		expect(view.result.current.webcamDeviceId).toBe("cam-1");
	});
});
