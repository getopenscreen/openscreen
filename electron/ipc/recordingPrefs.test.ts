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
	camDeviceName: null,
	systemAudioEnabled: false,
	cursorCaptureMode: "editable-overlay",
};
let dir: string;
beforeEach(() => {
	dir = mkdtempSync(path.join(os.tmpdir(), "openscreen-recording-ipc-"));
	electron.getPath.mockReturnValue(dir);
	electron.handle.mockClear();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function start(
	getWindow: () => BrowserWindow | null = () => null,
	getAppWindows?: () => BrowserWindow[],
	onChanged?: (previous: RecordingPrefs, next: RecordingPrefs) => void,
) {
	electron.handle.mockClear();
	registerRecordingPrefsHandlers(defaults, getWindow, getAppWindows, onChanged);
	const get = electron.handle.mock.calls.find(
		([name]) => name === "get-recording-prefs",
	)?.[1] as () => RecordingPrefs;
	const set = electron.handle.mock.calls.find(([name]) => name === "set-recording-prefs")?.[1] as (
		_event: unknown,
		prefs: Partial<RecordingPrefs>,
	) => RecordingPrefs;
	return {
		get,
		set: (prefs: Partial<RecordingPrefs>) => set(undefined, prefs),
	};
}

describe("recording preferences IPC", () => {
	it("reports each persisted change with the snapshot it replaced", () => {
		const onChanged = vi.fn();
		const prefs = start(undefined, undefined, onChanged);

		prefs.set({ systemAudioEnabled: true });

		expect(onChanged).toHaveBeenCalledTimes(1);
		const [previous, next] = onChanged.mock.calls[0] ?? [];
		expect(previous?.systemAudioEnabled).toBe(false);
		expect(next?.systemAudioEnabled).toBe(true);
	});

	it("restores toggles and device preferences on restart", () => {
		const first = start();
		expect(first.get().micEnabled).toBe(false);
		expect(first.get().camDeviceName).toBeNull();
		expect(first.set({ camDeviceName: "Camera A" }).camDeviceName).toBe("Camera A");
		first.set({ micEnabled: true, micDeviceId: "temporary-device" });
		const disk = JSON.parse(readFileSync(path.join(dir, "recording-settings.json"), "utf8"));
		expect(disk).toMatchObject({
			camDeviceName: "Camera A",
			micEnabled: true,
			micDeviceId: "temporary-device",
		});
		const restarted = start();
		expect(restarted.get()).toEqual({
			...defaults,
			camDeviceName: "Camera A",
			micEnabled: true,
			micDeviceId: "temporary-device",
		});
		restarted.set({ camDeviceName: "Camera B" });
		expect(start().get().camDeviceName).toBe("Camera B");
	});

	it("broadcasts saved values to every live application window", () => {
		const firstSend = vi.fn();
		const secondSend = vi.fn();
		const destroyedSend = vi.fn();
		const first = {
			isDestroyed: () => false,
			webContents: { send: firstSend },
		} as unknown as BrowserWindow;
		const second = {
			isDestroyed: () => false,
			webContents: { send: secondSend },
		} as unknown as BrowserWindow;
		const destroyed = {
			isDestroyed: () => true,
			webContents: { send: destroyedSend },
		} as unknown as BrowserWindow;
		const session = start(
			() => first,
			() => [first, second, first, destroyed],
		);
		const updated = session.set({ micEnabled: true });
		expect(firstSend).toHaveBeenCalledWith("recording-prefs-changed", updated);
		expect(secondSend).toHaveBeenCalledWith("recording-prefs-changed", updated);
		expect(firstSend).toHaveBeenCalledTimes(1);
		expect(destroyedSend).not.toHaveBeenCalled();
	});

	it("does not publish an invalid or failed preference write", () => {
		const session = start();
		expect(() => session.set({ micEnabled: null } as unknown as Partial<RecordingPrefs>)).toThrow(
			TypeError,
		);
		expect(session.get().micEnabled).toBe(false);
		session.set({ micEnabled: true });
		session.set({ micEnabled: undefined, camEnabled: true });
		expect(session.get().micEnabled).toBe(true);
		rmSync(dir, { recursive: true, force: true });
		expect(() => session.set({ micEnabled: false })).toThrow();
		expect(session.get().micEnabled).toBe(true);
	});
});
