import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppSettingsStore, DEFAULT_RECORDING_PREFERENCES } from "./app-settings";

const dirs: string[] = [];
const temp = () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "openscreen-app-settings-"));
	dirs.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("app settings store", () => {
	it("uses defaults for absent fields and preserves unknown keys", () => {
		const dir = temp();
		const file = path.join(dir, "recording-settings.json");
		writeFileSync(file, JSON.stringify({ future: { keep: true } }));
		const store = new AppSettingsStore(dir);
		expect(store.getSnapshot().recording).toEqual(DEFAULT_RECORDING_PREFERENCES);
		store.setRecordingPreferences({ micEnabled: true, camDeviceName: "Camera A" });
		expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
			future: { keep: true },
			micEnabled: true,
			camDeviceName: "Camera A",
		});
	});

	it("uses validated defaults for absent, corrupt, and invalid fields", () => {
		const dir = temp();
		const file = path.join(dir, "recording-settings.json");
		const store = new AppSettingsStore(dir);
		expect(store.getSnapshot().recording).toEqual(DEFAULT_RECORDING_PREFERENCES);
		for (const raw of ["{broken", "[]", JSON.stringify({ micEnabled: "yes" })]) {
			writeFileSync(file, raw);
			expect(store.getSnapshot().recording.micEnabled).toBe(false);
		}
	});

	it("stores the last source beside the recording preferences", () => {
		const dir = temp();
		const store = new AppSettingsStore(dir);
		const source = {
			platform: "win32",
			kind: "screen",
			id: "screen:1",
			name: "Display",
			displayId: "1",
		} as const;
		store.setRecordingPreferences({ micEnabled: true, micDeviceId: "mic" });
		expect(store.setLastSource(source).lastSource).toEqual(source);
		expect(
			JSON.parse(readFileSync(path.join(dir, "recording-settings.json"), "utf8")),
		).toMatchObject({ micEnabled: true, micDeviceId: "mic", lastSource: source });
		expect(store.setLastSource(null).lastSource).toBeNull();
		expect(store.getSnapshot().recording).toMatchObject({ micEnabled: true, micDeviceId: "mic" });
	});

	it("rejects invalid or failed writes without changing the published durable value", () => {
		const dir = temp();
		const store = new AppSettingsStore(dir);
		store.setRecordingPreferences({ micEnabled: true });
		expect(() => store.setRecordingPreferences({ micEnabled: "yes" as never })).toThrow(TypeError);
		expect(store.getSnapshot().recording.micEnabled).toBe(true);
		const missing = new AppSettingsStore(path.join(dir, "missing"));
		expect(() => missing.setRecordingPreferences({ micEnabled: true })).toThrow();
		expect(missing.getSnapshot().recording.micEnabled).toBe(false);
	});
});
