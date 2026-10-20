import type { Rectangle } from "electron";
import type { CursorRecordingData } from "../../../../src/native/contracts";

export interface CursorRecordingSession {
	start(): Promise<void>;
	stop(): Promise<CursorRecordingData>;
	updateCaptureBounds?(bounds: Rectangle): void;
}
