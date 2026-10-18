import { type BrowserWindow, type IpcMainInvokeEvent, ipcMain, screen } from "electron";
import type {
	CameraPreviewCommand,
	CameraPreviewState,
	CameraPreviewTransform,
} from "../src/lib/cameraPreview";
import { cameraPreviewBounds } from "./cameraPreviewBounds";
import { createCameraPreviewWindow } from "./windows";

let preview: BrowserWindow | null = null;
let state: CameraPreviewState = { enabled: false };
let cameraEnabled = false;
let dismissed = false;
let ready = false;
let gesture: {
	bounds: Electron.Rectangle;
	cursor: Electron.Point;
	direction: CameraPreviewTransform;
} | null = null;
const directions = new Set(["move", "nw", "ne", "sw", "se"]);
export function getCameraPreviewWindow() {
	return preview;
}

function publish() {
	if (!preview || preview.isDestroyed()) return;
	preview.webContents.send("camera-preview-state", state);
	if (state.enabled && ready) preview.showInactive();
	else preview.hide();
}

/** Only a new camera activation or an explicit Show action overrides a manual dismissal. */
export function syncCameraPreview(prefs: {
	camEnabled: boolean;
	camDeviceId?: string | null;
	camDeviceName?: string | null;
}) {
	if (!preview || preview.isDestroyed()) return;
	if (!prefs.camEnabled || !cameraEnabled) dismissed = false;
	cameraEnabled = prefs.camEnabled;
	state = {
		enabled: cameraEnabled && !dismissed,
		deviceId: prefs.camDeviceId ?? undefined,
		deviceName: prefs.camDeviceName ?? undefined,
	};
	publish();
}
export function showCameraPreview(focus = false) {
	if (!preview || preview.isDestroyed()) return;
	dismissed = false;
	state = { ...state, enabled: cameraEnabled };
	publish();
	if (focus && state.enabled && ready) preview.focus();
}

export function registerCameraPreview() {
	if (process.platform !== "darwin") return;
	// Precreate before a source can be picked, including while Camera is off.
	preview = createCameraPreviewWindow();
	preview.once("ready-to-show", () => {
		ready = true;
		publish();
	});
	preview.once("closed", () => {
		preview = null;
		gesture = null;
		ready = false;
	});
	preview.on("blur", () => {
		gesture = null;
	});
	const isPreview = (event: IpcMainInvokeEvent) =>
		preview && !preview.isDestroyed() && event.sender === preview.webContents;
	ipcMain.handle("camera-preview-state", (event) => (isPreview(event) ? state : null));
	ipcMain.handle("camera-preview-hide", (event) => {
		if (!isPreview(event)) return;
		dismissed = true;
		gesture = null;
		state = { ...state, enabled: false };
		publish();
	});
	ipcMain.handle("camera-preview-transform", (event, command: CameraPreviewCommand) => {
		if (!isPreview(event) || !preview || !state.enabled || !command) return;
		if (command.action === "begin" && directions.has(command.direction)) {
			gesture = {
				bounds: preview.getBounds(),
				cursor: screen.getCursorScreenPoint(),
				direction: command.direction,
			};
		} else if (command.action === "end") {
			gesture = null;
		} else if (command.action === "update" && gesture) {
			const cursor = screen.getCursorScreenPoint();
			preview.setBounds(
				cameraPreviewBounds(
					gesture.bounds,
					gesture.direction,
					{ x: cursor.x - gesture.cursor.x, y: cursor.y - gesture.cursor.y },
					screen.getDisplayNearestPoint(cursor).workArea,
				),
			);
		} else if (
			command.action === "nudge" &&
			directions.has(command.direction) &&
			Number.isFinite(command.dx) &&
			Number.isFinite(command.dy) &&
			Math.abs(command.dx) <= 40 &&
			Math.abs(command.dy) <= 40
		) {
			const bounds = preview.getBounds();
			preview.setBounds(
				cameraPreviewBounds(
					bounds,
					command.direction,
					{ x: command.dx, y: command.dy },
					screen.getDisplayMatching(bounds).workArea,
				),
			);
		}
	});
}
