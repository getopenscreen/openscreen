import { describe, expect, it, vi } from "vitest";
import { configureWaylandSupport } from "./wayland";

describe("Wayland startup configuration", () => {
	it.each([
		{ XDG_SESSION_TYPE: "wayland" },
		{ WAYLAND_DISPLAY: "wayland-1" },
	])("defaults to Wayland when the environment advertises a Wayland session: %j", (env) => {
		const commandLine = { appendSwitch: vi.fn(), hasSwitch: vi.fn(() => false) };
		configureWaylandSupport(commandLine, env);
		expect(commandLine.appendSwitch).toHaveBeenCalledWith("ozone-platform", "wayland");
		expect(commandLine.appendSwitch).toHaveBeenCalledWith("disable-features", "Vulkan");
	});

	it.each(["x11", "wayland", "auto"])("preserves an explicit ozone-platform=%s", (platform) => {
		const switches = new Map([["ozone-platform", platform]]);
		const commandLine = {
			hasSwitch: (name: string) => switches.has(name),
			appendSwitch: vi.fn((name: string, value?: string) => {
				switches.set(name, value ?? "");
			}),
		};
		configureWaylandSupport(commandLine, { XDG_SESSION_TYPE: "wayland" });
		expect(switches.get("ozone-platform")).toBe(platform);
		expect(commandLine.appendSwitch).not.toHaveBeenCalledWith("ozone-platform", expect.anything());
	});

	it.each([{}, { XDG_SESSION_TYPE: "x11" }])("leaves a non-Wayland session alone: %j", (env) => {
		const commandLine = { appendSwitch: vi.fn(), hasSwitch: vi.fn(() => false) };
		configureWaylandSupport(commandLine, env);
		expect(commandLine.appendSwitch).not.toHaveBeenCalled();
	});
});
