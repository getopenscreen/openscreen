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

vi.mock("./recorderHandle", () => ({
	createRecorderHandle: vi.fn(() => ({
		recorder: { state: "inactive", stop: vi.fn(), addEventListener: vi.fn() },
		recordedBlobPromise: Promise.resolve(new Blob()),
		isStreaming: () => false,
		discard: vi.fn(async () => undefined),
	})),
}));

import { useScreenRecorder } from "./useScreenRecorder";

type ElectronAPI = Window["electronAPI"];
type RecordingPrefs = Awaited<ReturnType<ElectronAPI["getRecordingPrefs"]>>;

const SOURCE = { id: "screen:0:0", name: "Screen 1", display_id: "1", thumbnail: "" };

function prefsWithGains(micGainDb: number, systemAudioGainDb: number): RecordingPrefs {
	return {
		micEnabled: false,
		micDeviceId: null,
		micDeviceName: null,
		camEnabled: false,
		camDeviceId: null,
		camDeviceName: null,
		camQuality: "1080p",
		systemAudioEnabled: false,
		micGainDb,
		systemAudioGainDb,
		cursorCaptureMode: "editable-overlay",
		hideDesktopIcons: false,
		autoZoomEnabled: true,
	};
}

let onChange: ((next: RecordingPrefs) => void) | undefined;
let releaseCountdown!: () => void;
let api: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
	vi.useFakeTimers();
	let countdownGate!: Promise<boolean>;
	releaseCountdown = () => undefined;
	api = {
		getRecordingPrefs: vi.fn(async () => prefsWithGains(0, 0)),
		onRecordingPrefsChanged: vi.fn((callback: (next: RecordingPrefs) => void) => {
			onChange = callback;
			return () => {
				onChange = undefined;
			};
		}),
		getPlatform: vi.fn(() => "darwin"),
		getSelectedSource: vi.fn(async () => SOURCE),
		setRecordingState: vi.fn(async () => ({ success: true })),
		isNativeMacCaptureAvailable: vi.fn(async () => ({ success: true, available: false })),
		startNativeMacRecording: vi.fn(async () => ({ success: false, error: "no capture" })),
		stopNativeMacRecording: vi.fn(async () => ({ success: true, discarded: true })),
		showCountdownOverlay: vi.fn(() => {
			countdownGate = new Promise<boolean>((resolve) => {
				releaseCountdown = () => resolve(true);
			});
			return countdownGate;
		}),
		setCountdownOverlayValue: vi.fn(async () => true),
		hideCountdownOverlay: vi.fn(async () => true),
	};
	window.electronAPI = api as unknown as ElectronAPI;
	const track = { stop: vi.fn(), onended: null, getSettings: () => ({ width: 1280, height: 720 }) };
	const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
	Object.defineProperty(navigator, "mediaDevices", {
		configurable: true,
		value: {
			enumerateDevices: vi.fn(async () => []),
			getUserMedia: vi.fn(async () => stream),
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		},
	});
	vi.stubGlobal("MediaRecorder", { isTypeSupported: () => true });
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	onChange = undefined;
});

describe("countdown startup lock and gain preference snapshots", () => {
	it("keeps the captured gains on screen while the countdown holds the lock, then applies later snapshots", async () => {
		const view = renderHook(() => useScreenRecorder());
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(view.result.current.startingCountdown).toBe(false);

		// Start a countdown and hold its overlay show pending so the lock stays held.
		await act(async () => {
			view.result.current.toggleRecording();
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(view.result.current.startingCountdown).toBe(true);

		// Another window saves new gain levels mid-countdown. The take already
		// captured 0/0, so the sliders must not move to -12/-6.
		act(() => {
			onChange?.(prefsWithGains(-12, -6));
		});
		expect(view.result.current.micGainDb).toBe(0);
		expect(view.result.current.systemAudioGainDb).toBe(0);

		// Release the countdown; once the lock clears, a later snapshot applies.
		await act(async () => {
			releaseCountdown();
			await vi.advanceTimersByTimeAsync(3_500);
		});
		expect(view.result.current.startingCountdown).toBe(false);
		act(() => {
			onChange?.(prefsWithGains(6, 3));
		});
		expect(view.result.current.micGainDb).toBe(6);
		expect(view.result.current.systemAudioGainDb).toBe(3);
	});
});
