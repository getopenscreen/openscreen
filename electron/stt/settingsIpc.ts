import { app, type IpcMain, safeStorage } from "electron";
import { resolveAgyExecutable } from "./agyProvider";
import type { TranscriptionSettingsUpdate } from "./settingsContract";
import { TranscriptionSettingsStore } from "./settingsStore";

export function registerTranscriptionSettingsIpc(ipcMain: IpcMain): TranscriptionSettingsStore {
	const store = new TranscriptionSettingsStore(app.getPath("userData"), safeStorage);
	ipcMain.handle("stt:settings:get", () => ({
		...store.getSnapshot(),
		agyAvailable: Boolean(resolveAgyExecutable()),
	}));
	ipcMain.handle("stt:settings:update", (_event, update: TranscriptionSettingsUpdate) => ({
		...store.update(update),
		agyAvailable: Boolean(resolveAgyExecutable()),
	}));
	return store;
}
