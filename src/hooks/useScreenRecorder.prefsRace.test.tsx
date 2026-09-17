// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => key,
}));

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { useScreenRecorder } from "./useScreenRecorder";

type ElectronAPI = Window["electronAPI"];
type RecordingPrefs = Awaited<ReturnType<ElectronAPI["getRecordingPrefs"]>>;

const SOURCE = { id: "screen:0:0", name: "Screen 1", display_id: "1", thumbnail: "" };

function prefs(micEnabled: boolean): RecordingPrefs {
	return {
		micEnabled,
		micDeviceId: null,
		micDeviceName: null,
		camEnabled: false,
		camDeviceId: null,
		camDeviceName: null,
		systemAudioEnabled: false,
		cursorCaptureMode: "editable-overlay",
	};
}

describe("useScreenRecorder prefs snapshot/event race", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("does not let the initial read overwrite a newer live snapshot", async () => {
		let resolveInitial!: (value: RecordingPrefs) => void;
		const initial = new Promise<RecordingPrefs>((resolve) => {
			resolveInitial = resolve;
		});
		let onChange: ((next: RecordingPrefs) => void) | undefined;
		window.electronAPI = {
			getRecordingPrefs: vi.fn(() => initial),
			onRecordingPrefsChanged: vi.fn((callback: (next: RecordingPrefs) => void) => {
				onChange = callback;
				return () => {
					onChange = undefined;
				};
			}),
			getPlatform: vi.fn(() => "win32"),
			getSelectedSource: vi.fn(async () => SOURCE),
		} as unknown as ElectronAPI;

		const view = renderHook(() => useScreenRecorder());
		expect(onChange).toBeTypeOf("function");
		act(() => {
			onChange?.(prefs(true));
		});
		expect(view.result.current.microphoneEnabled).toBe(true);
		await act(async () => {
			resolveInitial(prefs(false));
			await initial;
		});
		expect(view.result.current.microphoneEnabled).toBe(true);
	});
});
