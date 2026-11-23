import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	screen: {
		getCursorScreenPoint: () => ({ x: 0, y: 0 }),
		getDisplayNearestPoint: () => ({
			bounds: { x: 0, y: 0, width: 1920, height: 1080 },
		}),
	},
}));

import { createCursorRecordingSession, createX11PointerRecordingSession } from "./factory";
import { TelemetryRecordingSession } from "./telemetryRecordingSession";
import { X11PointerRecordingSession } from "./x11PointerRecordingSession";

const options = {
	getDisplayBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
	maxSamples: 10,
	sampleIntervalMs: 33,
};

describe("X11 pointer sampler factory", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("creates the X11 sampler used alongside native Linux capture", () => {
		expect(createX11PointerRecordingSession(options)).toBeInstanceOf(X11PointerRecordingSession);
	});

	it("leaves the generic Linux X11 cursor session unchanged", () => {
		vi.stubEnv("XDG_SESSION_TYPE", "x11");
		vi.stubEnv("WAYLAND_DISPLAY", undefined);
		expect(createCursorRecordingSession({ ...options, platform: "linux" })).toBeInstanceOf(
			TelemetryRecordingSession,
		);
	});
});
