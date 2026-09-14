import type { BrowserWindow } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordingPrefs } from "./handlers";
import { registerRecordingPrefsHandlers } from "./recordingPrefs";

const electron = vi.hoisted(() => ({ handle: vi.fn() }));
vi.mock("electron", () => ({
	ipcMain: { handle: electron.handle },
}));

const defaults: RecordingPrefs = {
	micEnabled: false,
	micDeviceId: null,
	micDeviceName: null,
	camEnabled: false,
	camDeviceId: null,
	systemAudioEnabled: false,
	cursorCaptureMode: "editable-overlay",
};

beforeEach(() => {
	electron.handle.mockClear();
});

function start(getWindow: () => BrowserWindow | null = () => null) {
	electron.handle.mockClear();
	registerRecordingPrefsHandlers(defaults, getWindow);
	const get = electron.handle.mock.calls.find(
		([name]) => name === "get-recording-prefs",
	)?.[1] as () => RecordingPrefs;
	const set = electron.handle.mock.calls.find(([name]) => name === "set-recording-prefs")?.[1] as (
		_event: unknown,
		prefs: Partial<RecordingPrefs>,
	) => RecordingPrefs;
	return { get, set: (prefs: Partial<RecordingPrefs>) => set(undefined, prefs) };
}

describe("recording preferences IPC", () => {
	it("returns defaults and updates session preferences", () => {
		const session = start();
		expect(session.get()).toEqual(defaults);
		const updated = session.set({ micEnabled: true, micDeviceId: "test-mic" });
		expect(updated.micEnabled).toBe(true);
		expect(updated.micDeviceId).toBe("test-mic");
		expect(session.get().micEnabled).toBe(true);
	});

	it("broadcasts changes to main window and tolerates an absent or destroyed window", () => {
		const send = vi.fn();
		const isDestroyed = vi.fn(() => false);
		const window = { isDestroyed, webContents: { send } } as unknown as BrowserWindow;
		const session = start(() => window);
		const updated = session.set({ camEnabled: true });
		expect(send).toHaveBeenCalledWith("recording-prefs-changed", updated);
		isDestroyed.mockReturnValue(true);
		session.set({ micEnabled: true });
		expect(send).toHaveBeenCalledTimes(1);
	});
});
