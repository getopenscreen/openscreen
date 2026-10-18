export type CameraPreviewTransform = "move" | "nw" | "ne" | "sw" | "se";
export interface CameraPreviewState {
	enabled: boolean;
	deviceId?: string;
	deviceName?: string;
}
export type CameraPreviewCommand =
	| { action: "begin"; direction: CameraPreviewTransform }
	| { action: "update" | "end" }
	| { action: "nudge"; direction: CameraPreviewTransform; dx: number; dy: number };
