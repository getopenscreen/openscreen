import { describe, expect, it, vi } from "vitest";
import { keepAlwaysOnTop, reassertAlwaysOnTop } from "./keepOnTop";

/** A window whose topmost bit Windows can take away, as `isAlwaysOnTop()` would then report. */
function fakeWindow({ topmost = true, destroyed = false } = {}) {
	const listeners = new Map<string, () => void>();
	const win = {
		topmost,
		listeners,
		isDestroyed: () => destroyed,
		isAlwaysOnTop: () => win.topmost,
		setAlwaysOnTop: vi.fn((flag: boolean) => {
			win.topmost = flag;
		}),
		on: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
	};
	return win;
}

describe("keepAlwaysOnTop on Windows (#1193)", () => {
	it("uses a level Electron does not tuck under the taskbar", () => {
		const win = fakeWindow();
		keepAlwaysOnTop(win, "win32");
		expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true, "pop-up-menu");
	});

	it.each([
		"focus",
		"blur",
		"show",
		"restore",
	])("puts the topmost bit back on %s once Windows took it", (event) => {
		const win = fakeWindow();
		keepAlwaysOnTop(win, "win32");
		win.setAlwaysOnTop.mockClear();

		win.topmost = false;
		win.listeners.get(event)?.();

		expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true, "pop-up-menu");
		expect(win.topmost).toBe(true);
	});
});

describe("reassertAlwaysOnTop", () => {
	it("leaves a window that is still topmost alone, so it is never re-ordered", () => {
		const win = fakeWindow();
		reassertAlwaysOnTop(win, "win32");
		expect(win.setAlwaysOnTop).not.toHaveBeenCalled();
	});

	it("skips a destroyed window", () => {
		const win = fakeWindow({ topmost: false, destroyed: true });
		reassertAlwaysOnTop(win, "win32");
		expect(win.setAlwaysOnTop).not.toHaveBeenCalled();
	});

	it.each(["darwin", "linux"] as const)("does nothing on %s", (platform) => {
		const win = fakeWindow({ topmost: false });
		keepAlwaysOnTop(win, platform);
		reassertAlwaysOnTop(win, platform);
		expect(win.setAlwaysOnTop).not.toHaveBeenCalled();
		expect(win.on).not.toHaveBeenCalled();
	});
});
