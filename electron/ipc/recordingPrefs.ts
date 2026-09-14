import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import type { RecordingPrefs } from "./handlers";

/** Shared session preferences. */
export function registerRecordingPrefsHandlers(
	defaults: RecordingPrefs,
	getMainWindow: () => BrowserWindow | null,
): void {
	let recordingPrefs = { ...defaults };

	ipcMain.handle("get-recording-prefs", () => recordingPrefs);
	ipcMain.handle("set-recording-prefs", (_, prefs: Partial<RecordingPrefs>) => {
		recordingPrefs = {
			...recordingPrefs,
			...prefs,
		};
		const mainWin = getMainWindow();
		if (mainWin && !mainWin.isDestroyed()) {
			mainWin.webContents.send("recording-prefs-changed", recordingPrefs);
		}
		return recordingPrefs;
	});
}
