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

	it.each([{}, { XDG_SESSION_TYPE: "x11" }])("leaves a non-Wayland session alone: %j", (env) => {
		const commandLine = {
			appendSwitch: vi.fn(),
			hasSwitch: vi.fn(() => false),
			getSwitchValue: vi.fn(() => ""),
		};
		configureWaylandSupport(commandLine, env);
		expect(commandLine.appendSwitch).not.toHaveBeenCalled();
	});

	// The desktop's text scaling otherwise left every window the app sizes itself painted
	// in only part of its surface (see configureWaylandSupport).
	function fakeCommandLine(initial: Record<string, string> = {}) {
		const switches = new Map(Object.entries(initial));
		return {
			switches,
			hasSwitch: (name: string) => switches.has(name),
			getSwitchValue: (name: string) => switches.get(name) ?? "",
			appendSwitch: vi.fn((name: string, value?: string) => {
				switches.set(name, value ?? "");
			}),
		};
	}

	it("pins the device scale factor to 1 on the Wayland backend", () => {
		const commandLine = fakeCommandLine();
		configureWaylandSupport(commandLine, { XDG_SESSION_TYPE: "wayland" });
		expect(commandLine.switches.get("force-device-scale-factor")).toBe("1");
	});

	it("leaves the scale factor alone under Xwayland, where it is the whole HiDPI scale", () => {
		const commandLine = fakeCommandLine({ "ozone-platform": "x11" });
		configureWaylandSupport(commandLine, { XDG_SESSION_TYPE: "wayland" });
		expect(commandLine.switches.has("force-device-scale-factor")).toBe(false);
	});

	it("never overrides a scale factor the user passed", () => {
		const commandLine = fakeCommandLine({ "force-device-scale-factor": "1.5" });
		configureWaylandSupport(commandLine, { XDG_SESSION_TYPE: "wayland" });
		expect(commandLine.switches.get("force-device-scale-factor")).toBe("1.5");
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
