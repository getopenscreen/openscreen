import { afterEach, describe, expect, it } from "vitest";
import { isX11PointerFallbackEnabled } from "./x11PointerFallback";

describe("isX11PointerFallbackEnabled", () => {
	const REAL_PLATFORM = process.platform;
	const setPlatform = (value: NodeJS.Platform) =>
		Object.defineProperty(process, "platform", { value, configurable: true });

	afterEach(() => {
		setPlatform(REAL_PLATFORM);
	});

	it("is on for a Linux X11 session", () => {
		expect(isX11PointerFallbackEnabled("linux", { XDG_SESSION_TYPE: "x11" })).toBe(true);
		expect(isX11PointerFallbackEnabled("linux", {})).toBe(true);
		expect(isX11PointerFallbackEnabled("linux", { WAYLAND_DISPLAY: "" })).toBe(true);
	});

	it("is off for a Wayland session unless forced", () => {
		expect(isX11PointerFallbackEnabled("linux", { XDG_SESSION_TYPE: "wayland" })).toBe(false);
		expect(
			isX11PointerFallbackEnabled("linux", {
				XDG_SESSION_TYPE: "wayland",
				OPENSCREEN_FORCE_X11_CURSOR: "1",
			}),
		).toBe(true);
	});

	it("is off when explicitly disabled, even on X11", () => {
		expect(
			isX11PointerFallbackEnabled("linux", {
				XDG_SESSION_TYPE: "x11",
				OPENSCREEN_DISABLE_X11_CURSOR: "1",
			}),
		).toBe(false);
	});

	it("is off off Linux", () => {
		expect(isX11PointerFallbackEnabled("win32", { XDG_SESSION_TYPE: "x11" })).toBe(false);
		expect(isX11PointerFallbackEnabled("darwin", {})).toBe(false);
	});
});
