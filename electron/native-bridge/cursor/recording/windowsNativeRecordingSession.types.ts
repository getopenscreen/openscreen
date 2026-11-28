import type { Rectangle } from "electron";
import type { NativeCursorType } from "../../../../src/native/contracts";

export interface WindowsCursorSampleEvent {
	type: "sample";
	timestampMs: number;
	x: number;
	y: number;
	visible: boolean;
	handle: string | null;
	cursorType?: NativeCursorType | null;
	leftButtonDown?: boolean;
	leftButtonPressed?: boolean;
	leftButtonReleased?: boolean;
	bounds?: {
		x: number;
		y: number;
		width: number;
		height: number;
	} | null;
	asset: WindowsCursorAssetPayload | null;
}

export interface WindowsCursorReadyEvent {
	type: "ready";
	timestampMs: number;
}

/** A live keydown from the sampler's WH_KEYBOARD_LL hook, for the keystroke overlay. */
export interface WindowsCursorKeyEvent {
	type: "key";
	timestampMs: number;
	/** Win32 virtual-key code (`KBDLLHOOKSTRUCT.vkCode`), left/right modifiers normalised. */
	vk: number;
	/** Modifier bits held at event time: 1=Shift 2=Ctrl 4=Alt 8=Win. */
	modifiers: number;
}

export interface WindowsCursorErrorEvent {
	type: "error";
	timestampMs: number;
	message: string;
}

export interface WindowsCursorAssetPayload {
	id: string;
	imageDataUrl: string;
	width: number;
	height: number;
	hotspotX: number;
	hotspotY: number;
	cursorType?: NativeCursorType | null;
}

export type WindowsCursorEvent =
	| WindowsCursorSampleEvent
	| WindowsCursorReadyEvent
	| WindowsCursorKeyEvent
	| WindowsCursorErrorEvent;

export interface WindowsNativeRecordingSessionOptions {
	getDisplayBounds: () => Rectangle | null;
	maxSamples: number;
	sampleIntervalMs: number;
	sourceId?: string | null;
	startTimeMs?: number;
	/** Live keydowns, forwarded to the keystroke overlay. Absent = not consumed. */
	onKeyEvent?: (event: WindowsCursorKeyEvent) => void;
	/** Install the helper's low-level keyboard hook. Off by default. */
	captureKeys?: boolean;
}
