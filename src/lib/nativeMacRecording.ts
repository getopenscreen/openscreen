import type { Rectangle } from "electron";
import type { CursorCaptureMode } from "./recordingSession";

export type NativeMacSourceType = "display" | "window";

export type NativeMacRecordingRequest = {
	recordingId?: number;
	source: {
		type: NativeMacSourceType;
		sourceId: string;
		displayId?: number;
		windowId?: number;
		bounds?: Rectangle;
	};
	video: {
		fps: number;
		width: number;
		height: number;
		bitrate?: number;
		hideSystemCursor: boolean;
	};
	audio: {
		system: {
			enabled: boolean;
		};
		microphone: {
			enabled: boolean;
			deviceId?: string;
			deviceName?: string;
			gain: number;
		};
	};
	webcam: {
		enabled: boolean;
		deviceId?: string;
		deviceName?: string;
		width: number;
		height: number;
		fps: number;
	};
	cursor: {
		mode: CursorCaptureMode;
	};
	outputs: {
		screenPath: string;
		manifestPath?: string;
	};
};

export type NativeMacRecordingStartResult = {
	success: boolean;
	recordingId?: number;
	path?: string;
	helperPath?: string;
	error?: string;
};

export function parseMacWindowIdFromSourceId(sourceId?: string | null) {
	if (!sourceId?.startsWith("window:")) {
		return null;
	}

	const windowIdPart = sourceId.split(":")[1];
	if (!windowIdPart || !/^\d+$/.test(windowIdPart)) {
		return null;
	}

	return Number(windowIdPart);
}

export function parseMacDisplayIdFromSourceId(sourceId?: string | null) {
	if (!sourceId?.startsWith("screen:")) {
		return null;
	}

	const displayIdPart = sourceId.split(":")[1];
	if (!displayIdPart || !/^\d+$/.test(displayIdPart)) {
		return null;
	}

	return Number(displayIdPart);
}
