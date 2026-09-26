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

	// getopenscreen/openscreen#723 — the auto-zoom choice has to survive a restart, and a
	// file written before the preference existed must read as on rather than as off.
	it("persists the auto-zoom choice and reads a missing key as on", () => {
		const dir = temp();
		const file = path.join(dir, "recording-settings.json");
		const store = new AppSettingsStore(dir);
		expect(store.getSnapshot().recording.autoZoomEnabled).toBe(true);
		expect(
			store.setRecordingPreferences({ autoZoomEnabled: false }).recording.autoZoomEnabled,
		).toBe(false);
		expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ autoZoomEnabled: false });
		expect(new AppSettingsStore(dir).getSnapshot().recording.autoZoomEnabled).toBe(false);

		writeFileSync(file, JSON.stringify({ micEnabled: true }), "utf8");
		expect(store.getSnapshot().recording.autoZoomEnabled).toBe(true);
		writeFileSync(file, JSON.stringify({ autoZoomEnabled: "false" }), "utf8");
		expect(store.getSnapshot().recording.autoZoomEnabled).toBe(true);
		expect(() => store.setRecordingPreferences({ autoZoomEnabled: "no" as never })).toThrow(
			TypeError,
		);
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

	it("counts exports until the user answers, then stops counting for good", () => {
		const dir = temp();
		const store = new AppSettingsStore(dir);
		expect(store.getSnapshot().starPrompt).toEqual({ successfulExports: 0, dismissed: false });
		expect(store.recordSuccessfulExport().successfulExports).toBe(1);
		expect(store.recordSuccessfulExport().successfulExports).toBe(2);
		store.dismissStarPrompt();
		// Past the answer the number cannot change any decision, so it stops moving rather than
		// quietly becoming a lifetime usage count.
		expect(store.recordSuccessfulExport()).toEqual({ successfulExports: 2, dismissed: true });
		expect(store.getSnapshot().starPrompt).toEqual({ successfulExports: 2, dismissed: true });
	});

	it("survives a settings file that lies about the prompt state", () => {
		const dir = temp();
		const file = path.join(dir, "recording-settings.json");
		// A hand-edited or truncated file must never turn into "ask on every export".
		for (const bad of ['{"starPrompt":{"successfulExports":-4}}', '{"starPrompt":"nope"}']) {
			writeFileSync(file, bad, "utf8");
			expect(new AppSettingsStore(dir).getSnapshot().starPrompt).toEqual({
				successfulExports: 0,
				dismissed: false,
			});
		}
	});

	it("keeps the recording preferences untouched when the prompt state changes", () => {
		const dir = temp();
		const store = new AppSettingsStore(dir);
		store.setRecordingPreferences({ micEnabled: true, micDeviceId: "mic" });
		store.recordSuccessfulExport();
		store.dismissStarPrompt();
		expect(store.getSnapshot().recording).toMatchObject({ micEnabled: true, micDeviceId: "mic" });
	});
});
