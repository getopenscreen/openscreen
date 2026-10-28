import type { Rectangle } from "electron";
import { FallbackCursorRecordingSession } from "./fallbackCursorRecordingSession";
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

	if (options.platform === "linux") {
		// The ScreenCast portal's METADATA cursor mode is the only source of a real
		// pointer position on Wayland: `screen.getCursorScreenPoint()` returns
		// {0,0} there, so TelemetryRecordingSession produced well-formed recordings
		// with every sample pinned to the top-left corner. The helper throws when
		// it is unavailable rather than falling back there — the caller then records
		// without cursor data, which beats a file full of {0,0}.
		//
		// On X11 (Xvfb cloud agents included) the portal often advertises
		// AvailableSourceTypes=0 / no METADATA mode, while the pointer is still
		// readable via Electron / xdotool / xev. Fall back to that sampler so a
		// take still writes `<video>.cursor.json` and `export --auto-zoom` works
		// with no extra import step.
		const pipewire = new PipeWireCursorRecordingSession({
			maxSamples: options.maxSamples,
			sampleIntervalMs: options.sampleIntervalMs,
			startTimeMs: options.startTimeMs,
		});
		if (!isX11PointerFallbackEnabled(options.platform)) {
			return pipewire;
		}
		return new FallbackCursorRecordingSession({
			primary: pipewire,
			createFallback: () => createX11PointerRecordingSession(options),
			fallbackLabel: "X11 pointer sampler",
		});
	}

	// Anything else (a future platform, or a test harness): capture cursor
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
