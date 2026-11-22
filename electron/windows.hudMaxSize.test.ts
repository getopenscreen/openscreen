import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
	class FakeWindow {
		listeners = new Map<string, () => void>();
		webContents = { on: vi.fn(), send: vi.fn() };
		setContentProtection = vi.fn();
		setVisibleOnAllWorkspaces = vi.fn();
		setAlwaysOnTop = vi.fn();
		isAlwaysOnTop = () => true;
		setBounds = vi.fn();
		setResizable = vi.fn();
		setMaximumSize = vi.fn();
		getPosition = () => [10, 20];
		isVisible = vi.fn(() => true);
		once = vi.fn();
		on = (event: string, listener: () => void) => this.listeners.set(event, listener);
		loadURL = vi.fn();
		loadFile = vi.fn();
		isDestroyed() {
			return false;
		}
	}
	return { FakeWindow };
});

vi.mock("electron", () => ({
	app: { commandLine: { getSwitchValue: () => "" } },
	BrowserWindow: electron.FakeWindow,
	ipcMain: { on: vi.fn() },
	screen: {
		getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
		on: vi.fn(),
	},
}));

const REAL_PLATFORM = process.platform;

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

afterAll(() => {
	Object.defineProperty(process, "platform", { value: REAL_PLATFORM, configurable: true });
});

async function openHud(waylandDisplay: string | undefined) {
	Object.defineProperty(process, "platform", { value: "linux", configurable: true });
	vi.stubEnv("XDG_SESSION_TYPE", waylandDisplay ? "wayland" : "x11");
	vi.stubEnv("WAYLAND_DISPLAY", waylandDisplay);
	vi.useFakeTimers();
	vi.resetModules();
	const { createHudOverlayWindow } = await import("./windows");
	return createHudOverlayWindow() as unknown as InstanceType<typeof electron.FakeWindow>;
}

describe("HUD max size on Wayland (#1648)", () => {
	it("keeps the fixed size while the HUD maps, then drops the max and reapplies the size", async () => {
		const win = await openHud("wayland-0");
		win.listeners.get("show")?.();
		vi.advanceTimersByTime(100);
		expect(win.setMaximumSize).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1000);
		expect(win.setMaximumSize).toHaveBeenCalledWith(0, 0);
		expect(win.setBounds).toHaveBeenCalledWith({ x: 10, y: 20, width: 600, height: 560 }, false);
	});

	it("fixes the size again on hide, so the next map floats", async () => {
		const win = await openHud("wayland-0");
		win.listeners.get("show")?.();
		win.listeners.get("hide")?.();
		vi.advanceTimersByTime(1000);
		expect(win.setMaximumSize).not.toHaveBeenCalled();
		expect(win.setResizable.mock.calls).toEqual([[true], [false]]);
	});

	it("leaves X11 alone", async () => {
		const win = await openHud(undefined);
		expect(win.listeners.has("show")).toBe(false);
	});
});
