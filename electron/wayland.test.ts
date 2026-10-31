import { describe, expect, it, vi } from "vitest";
import { configureWaylandSupport, usesWaylandBackend } from "./wayland";

describe("Wayland startup configuration", () => {
	it.each([
		{ XDG_SESSION_TYPE: "wayland" },
		{ WAYLAND_DISPLAY: "wayland-1" },
	])("defaults to Wayland when the environment advertises a Wayland session: %j", (env) => {
		const commandLine = {
			appendSwitch: vi.fn(),
			hasSwitch: vi.fn(() => false),
			getSwitchValue: vi.fn(() => ""),
		};
		configureWaylandSupport(commandLine, env);
		expect(commandLine.appendSwitch).toHaveBeenCalledWith("ozone-platform", "wayland");
		expect(commandLine.appendSwitch).toHaveBeenCalledWith("disable-features", "Vulkan");
	});

	it.each(["x11", "wayland", "auto"])("preserves an explicit ozone-platform=%s", (platform) => {
		const switches = new Map([["ozone-platform", platform]]);
		const commandLine = {
			hasSwitch: (name: string) => switches.has(name),
			getSwitchValue: (name: string) => switches.get(name) ?? "",
			appendSwitch: vi.fn((name: string, value?: string) => {
				switches.set(name, value ?? "");
			}),
		};
		configureWaylandSupport(commandLine, { XDG_SESSION_TYPE: "wayland" });
		expect(switches.get("ozone-platform")).toBe(platform);
		expect(commandLine.appendSwitch).not.toHaveBeenCalledWith("ozone-platform", expect.anything());
		// Capture still goes through PipeWire under Xwayland: X11 cannot see Wayland windows.
		expect(commandLine.appendSwitch).toHaveBeenCalledWith(
			"enable-features",
			"WaylandWindowDrag,WebRTCPipeWireCapturer",
		);
	});

	it("keeps the features passed on the command line (#1452)", () => {
		// Chromium keeps only the last value of a repeated switch.
		const switches = new Map([
			["enable-features", "WebRtcPipeWireCamera"],
			["disable-features", "WebRtcPipeWireCamera"],
		]);
		const commandLine = {
			hasSwitch: (name: string) => switches.has(name),
			getSwitchValue: (name: string) => switches.get(name) ?? "",
			appendSwitch: (name: string, value?: string) => switches.set(name, value ?? ""),
		};
		configureWaylandSupport(commandLine, { XDG_SESSION_TYPE: "wayland" });
		expect(switches.get("enable-features")).toBe(
			"WebRtcPipeWireCamera,WaylandWindowDrag,WebRTCPipeWireCapturer",
		);
		expect(switches.get("disable-features")).toBe("WebRtcPipeWireCamera,Vulkan");
	});

	it.each([{}, { XDG_SESSION_TYPE: "x11" }])("leaves a non-Wayland session alone: %j", (env) => {
		const commandLine = {
			appendSwitch: vi.fn(),
			hasSwitch: vi.fn(() => false),
			getSwitchValue: vi.fn(() => ""),
		};
		configureWaylandSupport(commandLine, env);
		expect(commandLine.appendSwitch).not.toHaveBeenCalled();
	});
});

describe("Wayland backend detection", () => {
	const ozone = (value: string) => ({ getSwitchValue: () => value });
	const session = { XDG_SESSION_TYPE: "wayland" };

	it.each(["wayland", "auto", ""])("is on in a Linux Wayland session (ozone-platform=%j)", (v) => {
		expect(usesWaylandBackend("linux", ozone(v), session)).toBe(true);
		expect(usesWaylandBackend("linux", ozone(v), { WAYLAND_DISPLAY: "wayland-0" })).toBe(true);
	});

	it("is off under Xwayland, when ozone-platform=x11 was passed explicitly", () => {
		expect(usesWaylandBackend("linux", ozone("x11"), session)).toBe(false);
	});

	it("is off in an X11 session", () => {
		expect(usesWaylandBackend("linux", ozone(""), { XDG_SESSION_TYPE: "x11" })).toBe(false);
	});

	it.each(["win32", "darwin"] as const)("is off on %s, whatever the environment", (platform) => {
		expect(usesWaylandBackend(platform, ozone("wayland"), session)).toBe(false);
	});
});
