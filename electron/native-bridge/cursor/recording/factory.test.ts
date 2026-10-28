import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	screen: {
		getCursorScreenPoint: () => ({ x: 0, y: 0 }),
		getDisplayNearestPoint: () => ({
			bounds: { x: 0, y: 0, width: 1920, height: 1080 },
		}),
	},
}));

import { createCursorRecordingSession } from "./factory";
import { FallbackCursorRecordingSession } from "./fallbackCursorRecordingSession";
import { PipeWireCursorRecordingSession } from "./pipeWireCursorRecordingSession";

describe("createCursorRecordingSession linux fallback", () => {
	const REAL_PLATFORM = process.platform;
	const setPlatform = (value: NodeJS.Platform) =>
		Object.defineProperty(process, "platform", { value, configurable: true });

	let previousWayland: string | undefined;

	beforeEach(() => {
		setPlatform("linux");
		previousWayland = process.env.WAYLAND_DISPLAY;
		delete process.env.WAYLAND_DISPLAY;
		vi.stubEnv("XDG_SESSION_TYPE", "x11");
		vi.stubEnv("OPENSCREEN_FORCE_X11_CURSOR", "");
		vi.stubEnv("OPENSCREEN_DISABLE_X11_CURSOR", "");
	});

	afterEach(() => {
		setPlatform(REAL_PLATFORM);
		vi.unstubAllEnvs();
		if (previousWayland === undefined) {
			delete process.env.WAYLAND_DISPLAY;
		} else {
			process.env.WAYLAND_DISPLAY = previousWayland;
		}
	});

	const options = {
		getDisplayBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
		maxSamples: 10,
		sampleIntervalMs: 33,
		platform: "linux" as const,
	};

	it("wraps PipeWire in the X11 fallback on an X11 session", () => {
		const session = createCursorRecordingSession(options);
		expect(session).toBeInstanceOf(FallbackCursorRecordingSession);
	});

	it("uses PipeWire alone on Wayland", () => {
		vi.stubEnv("XDG_SESSION_TYPE", "wayland");
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		const session = createCursorRecordingSession(options);
		expect(session).toBeInstanceOf(PipeWireCursorRecordingSession);
	});
});
