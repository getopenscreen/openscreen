import type { Rectangle } from "electron";
import { isWaylandSession } from "../../../wayland";
import { MacNativeCursorRecordingSession } from "./macNativeCursorRecordingSession";
import { PipeWireCursorRecordingSession } from "./pipeWireCursorRecordingSession";
import type { CursorRecordingSession } from "./session";
import { TelemetryRecordingSession } from "./telemetryRecordingSession";
import { WindowsNativeRecordingSession } from "./windowsNativeRecordingSession";
import { isX11PointerFallbackEnabled } from "./x11PointerFallback";
import { X11PointerRecordingSession } from "./x11PointerRecordingSession";

interface CreateCursorRecordingSessionOptions {
	getDisplayBounds: () => Rectangle | null;
	maxSamples: number;
	platform: NodeJS.Platform;
	sampleIntervalMs: number;
	sourceId?: string | null;
	startTimeMs?: number;
}

export function createX11PointerRecordingSession(
	options: Omit<CreateCursorRecordingSessionOptions, "platform" | "sourceId">,
): CursorRecordingSession {
	return new X11PointerRecordingSession({
		getDisplayBounds: options.getDisplayBounds,
		maxSamples: options.maxSamples,
		sampleIntervalMs: options.sampleIntervalMs,
		startTimeMs: options.startTimeMs,
	});
}

export function createCursorRecordingSession(
	options: CreateCursorRecordingSessionOptions,
): CursorRecordingSession {
	if (options.platform === "win32") {
		return new WindowsNativeRecordingSession({
			getDisplayBounds: options.getDisplayBounds,
			maxSamples: options.maxSamples,
			sampleIntervalMs: options.sampleIntervalMs,
			sourceId: options.sourceId,
			startTimeMs: options.startTimeMs,
		});
	}

	if (options.platform === "darwin") {
		return new MacNativeCursorRecordingSession({
			getDisplayBounds: options.getDisplayBounds,
			maxSamples: options.maxSamples,
			sampleIntervalMs: options.sampleIntervalMs,
			startTimeMs: options.startTimeMs,
		});
	}

	if (options.platform === "linux" && isWaylandSession(process.env)) {
		// The ScreenCast portal's METADATA cursor mode is the only source of a real
		// pointer position on Wayland: `screen.getCursorScreenPoint()` returns
		// {0,0} there, so TelemetryRecordingSession produced well-formed recordings
		// with every sample pinned to the top-left corner. The helper throws when
		// it is unavailable rather than falling back here — the caller then records
		// without cursor data, which beats a file full of {0,0}.
		return new PipeWireCursorRecordingSession({
			maxSamples: options.maxSamples,
			sampleIntervalMs: options.sampleIntervalMs,
			startTimeMs: options.startTimeMs,
		});
	}

	// X11 can read the pointer without a second portal grant. In particular,
	// do not try a cursor-only portal session after browser capture's picker.
	if (options.platform === "linux" && isX11PointerFallbackEnabled(options.platform)) {
		return createX11PointerRecordingSession(options);
	}

	// Anything else (X11, a future platform, or a test harness): capture cursor
	// positions via Electron's `screen` API on an interval. No cursor
	// sprites/assets and no clicks, just position telemetry.
	return new TelemetryRecordingSession({
		getDisplayBounds: options.getDisplayBounds,
		maxSamples: options.maxSamples,
		sampleIntervalMs: options.sampleIntervalMs,
		startTimeMs: options.startTimeMs,
	});
}

export { isX11PointerFallbackEnabled };
