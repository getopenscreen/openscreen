import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordingPrefs } from "./handlers";
import { registerRecordingPrefsHandlers } from "./recordingPrefs";

const electron = vi.hoisted(() => ({ getPath: vi.fn(), handle: vi.fn() }));
vi.mock("electron", () => ({
	app: { getPath: electron.getPath },
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
	autoZoomEnabled: true,
};
let dir: string;
beforeEach(() => {
	dir = mkdtempSync(path.join(os.tmpdir(), "openscreen-recording-ipc-"));
	electron.getPath.mockReturnValue(dir);
	electron.handle.mockClear();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

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
	it("restores false on restart while device preferences reset", () => {
		const first = start();
		expect(first.get().autoZoomEnabled).toBe(true);
		expect(first.set({ autoZoomEnabled: false }).autoZoomEnabled).toBe(false);
		first.set({ micEnabled: true, micDeviceId: "temporary-device" });
		const disk = JSON.parse(readFileSync(path.join(dir, "recording-settings.json"), "utf8"));
		expect(disk).toEqual({ autoZoomEnabled: false });
		const restarted = start();
		expect(restarted.get()).toEqual({ ...defaults, autoZoomEnabled: false });
		restarted.set({ autoZoomEnabled: true });
		expect(start().get().autoZoomEnabled).toBe(true);
	});

	it("broadcasts the saved value and tolerates an absent or destroyed window", () => {
		const send = vi.fn();
		const isDestroyed = vi.fn(() => false);
		const window = { isDestroyed, webContents: { send } } as unknown as BrowserWindow;
		const session = start(() => window);
		const updated = session.set({ autoZoomEnabled: false });
		expect(send).toHaveBeenCalledWith("recording-prefs-changed", updated);
		isDestroyed.mockReturnValue(true);
		session.set({ micEnabled: true });
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("does not publish an invalid or failed preference write", () => {
		const session = start();
		expect(() =>
			session.set({ autoZoomEnabled: null } as unknown as Partial<RecordingPrefs>),
		).toThrow(TypeError);
		expect(session.get().autoZoomEnabled).toBe(true);
		session.set({ autoZoomEnabled: false });
		session.set({ autoZoomEnabled: undefined, camEnabled: true });
		expect(session.get().autoZoomEnabled).toBe(false);
		rmSync(dir, { recursive: true, force: true });
		expect(() => session.set({ autoZoomEnabled: true })).toThrow();
		expect(session.get().autoZoomEnabled).toBe(false);
	});
});
