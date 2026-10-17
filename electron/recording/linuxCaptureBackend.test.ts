import { describe, expect, it } from "vitest";
import {
	linuxCaptureBackend,
	linuxPortalOwnsSources,
	resolveX11CaptureSource,
} from "./linuxCaptureBackend";

describe("Linux capture backend", () => {
	it("uses X11 on a native X11 desktop without a portal", () => {
		const environment = { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" };
		expect(linuxCaptureBackend(environment)).toBe("x11");
		expect(linuxPortalOwnsSources("linux", true, environment)).toBe(false);
	});
	it("keeps Wayland on its portal even when XWayland provides DISPLAY", () => {
		for (const environment of [
			{ XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" },
			{ WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
		]) {
			expect(linuxCaptureBackend(environment)).toBe("pipewire");
			expect(linuxPortalOwnsSources("linux", true, environment)).toBe(true);
		}
	});
	it("does not report a native portal without a helper or off Linux", () => {
		const environment = { XDG_SESSION_TYPE: "wayland" };
		expect(linuxPortalOwnsSources("linux", false, environment)).toBe(false);
		expect(linuxPortalOwnsSources("darwin", true, environment)).toBe(false);
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
