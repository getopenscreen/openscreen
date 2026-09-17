import { app, type BrowserWindow, ipcMain } from "electron";
import { AppSettingsStore } from "../app-settings";
import type { RecordingPrefs } from "./handlers";

/** Shared durable recording preferences. Persist before publishing any new snapshot. */
export function registerRecordingPrefsHandlers(
	defaults: RecordingPrefs,
	getMainWindow: () => BrowserWindow | null,
	getAppWindows: () => BrowserWindow[] = () => {
		const mainWindow = getMainWindow();
		return mainWindow ? [mainWindow] : [];
	},
): void {
	const userData = app.getPath("userData");
	const settings = new AppSettingsStore(userData);
	let recordingPrefs = { ...defaults, ...settings.getSnapshot().recording };
	const publish = () => {
		for (const window of new Set(getAppWindows())) {
			if (!window.isDestroyed()) {
				window.webContents.send("recording-prefs-changed", recordingPrefs);
			}
		}
	};

	ipcMain.handle("get-recording-prefs", () => recordingPrefs);
	ipcMain.handle("set-recording-prefs", (_, prefs: Partial<RecordingPrefs>) => {
		// Persist every validated field first. A failed save must leave both the
		// durable value and the main-process published snapshot unchanged.
		recordingPrefs = settings.setRecordingPreferences(prefs).recording;
		publish();
		return recordingPrefs;
	});
}
