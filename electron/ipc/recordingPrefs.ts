import { app, type BrowserWindow, ipcMain } from "electron";
import { loadAutoZoomEnabled, saveAutoZoomEnabled } from "../recording-settings";
import type { RecordingPrefs } from "./handlers";

/** Shared session preferences, with only the auto-zoom choice retained on disk. */
export function registerRecordingPrefsHandlers(
	defaults: RecordingPrefs,
	getMainWindow: () => BrowserWindow | null,
): void {
	const userData = app.getPath("userData");
	let recordingPrefs = { ...defaults, autoZoomEnabled: loadAutoZoomEnabled(userData) };

	ipcMain.handle("get-recording-prefs", () => recordingPrefs);
	ipcMain.handle("set-recording-prefs", (_, prefs: Partial<RecordingPrefs>) => {
		if (prefs.autoZoomEnabled !== undefined) {
			// Persist before publishing: a failed save must not report a durable change.
			saveAutoZoomEnabled(userData, prefs.autoZoomEnabled);
		}
		recordingPrefs = {
			...recordingPrefs,
			...prefs,
			autoZoomEnabled: prefs.autoZoomEnabled ?? recordingPrefs.autoZoomEnabled,
		};
		const mainWin = getMainWindow();
		if (mainWin && !mainWin.isDestroyed()) {
			mainWin.webContents.send("recording-prefs-changed", recordingPrefs);
		}
		return recordingPrefs;
	});
}
