import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	backendFromProbe,
	isX11Session,
	linuxCaptureBackend,
	linuxPortalOwnsSources,
	resetLinuxCaptureBackendProbe,
	resolveX11CaptureSource,
} from "./linuxCaptureBackend";

describe("Linux capture backend", () => {
	beforeEach(() => resetLinuxCaptureBackendProbe());
	const x11 = { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" };

	it("takes X11 only when the helper reports no portal on an X11 session", async () => {
		const probe = vi.fn(async () => "x11" as const);
		await expect(linuxCaptureBackend("/helper", x11, probe)).resolves.toBe("x11");
		await expect(linuxCaptureBackend("/helper", x11, probe)).resolves.toBe("x11");
		expect(probe).toHaveBeenCalledTimes(1);
	});
	it("asks the helper again once a failed take forgets the probe", async () => {
		const probe = vi.fn<(helperPath: string) => Promise<"x11" | "pipewire">>(
			async () => "pipewire",
		);
		await linuxCaptureBackend("/helper", x11, probe);
		resetLinuxCaptureBackendProbe();
		probe.mockResolvedValueOnce("x11");
		await expect(linuxCaptureBackend("/helper", x11, probe)).resolves.toBe("x11");
		expect(probe).toHaveBeenCalledTimes(2);
	});
	it("keeps an X11 session with a working portal on the portal", async () => {
		await expect(linuxCaptureBackend("/helper", x11, async () => "pipewire")).resolves.toBe(
			"pipewire",
		);
	});
	it("keeps Wayland on its portal without probing, even when XWayland provides DISPLAY", async () => {
		const probe = vi.fn(async () => "x11" as const);
		for (const environment of [
			{ XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" },
			{ WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
		]) {
			expect(isX11Session(environment)).toBe(false);
			await expect(linuxCaptureBackend("/helper", environment, probe)).resolves.toBe("pipewire");
			await expect(linuxPortalOwnsSources("linux", "/helper", environment)).resolves.toBe(true);
		}
		expect(probe).not.toHaveBeenCalled();
	});
	it("does not report a native portal without a helper or off Linux", async () => {
		const environment = { XDG_SESSION_TYPE: "wayland" };
		await expect(linuxPortalOwnsSources("linux", null, environment)).resolves.toBe(false);
		await expect(linuxPortalOwnsSources("darwin", "/helper", environment)).resolves.toBe(false);
	});
	it("reads the backend from the helper's ready event", () => {
		expect(backendFromProbe('{"event":"ready","backend":"x11"}\n')).toBe("x11");
		expect(backendFromProbe('noise\n{"event":"ready","backend":"pipewire"}\n')).toBe("pipewire");
		expect(backendFromProbe('{"event":"ready"}\n')).toBe("pipewire");
		expect(backendFromProbe('{"event":"error","code":"portal-unavailable"}\n')).toBe("pipewire");
	});
});

describe("X11 source resolution", () => {
	const displays = [
		{ id: 7, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
		{ id: 9, bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
	];
	it("preserves the selected monitor's physical bounds", () => {
		expect(resolveX11CaptureSource({ id: "screen:9:0", display_id: "9" }, displays)).toEqual({
			kind: "display",
			x: 1920,
			y: 0,
			width: 1920,
			height: 1080,
		});
	});
	it("targets a selected XID without substituting a monitor", () => {
		expect(resolveX11CaptureSource({ id: "window:12345:0" }, displays)).toEqual({
			kind: "window",
			windowId: 12345,
		});
	});
	it("translates a monitor left of the primary into X11 root coordinates", () => {
		const arranged = [displays[0], { ...displays[1], bounds: { ...displays[1].bounds, x: -1920 } }];
		expect(resolveX11CaptureSource({ id: "screen:7:0", display_id: "7" }, arranged)).toMatchObject({
			x: 1920,
			y: 0,
		});
		expect(resolveX11CaptureSource({ id: "screen:9:0", display_id: "9" }, arranged)).toMatchObject({
			x: 0,
			y: 0,
		});
	});
	it("rejects stale, missing and malformed sources instead of recording something else", () => {
		expect(() => resolveX11CaptureSource(null, displays)).toThrow();
		expect(() =>
			resolveX11CaptureSource({ id: "screen:3:0", display_id: "3" }, displays),
		).toThrow();
		expect(() => resolveX11CaptureSource({ id: "window:4294967296:0" }, displays)).toThrow();
		expect(() => resolveX11CaptureSource({ id: "window:invalid:0" }, displays)).toThrow();
	});
	it("rejects ambiguous mixed-DPI monitor coordinates while retaining window capture", () => {
		const mixed = [displays[0], { ...displays[1], scaleFactor: 2 }];
		expect(() => resolveX11CaptureSource({ id: "screen:9:0", display_id: "9" }, mixed)).toThrow(
			"matching display scale factors",
		);
		expect(resolveX11CaptureSource({ id: "window:12345:0" }, mixed)).toEqual({
			kind: "window",
			windowId: 12345,
		});
	});
});
