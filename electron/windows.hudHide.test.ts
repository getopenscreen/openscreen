import { afterAll, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
	class FakeWindow {
		webContents = { on: vi.fn(), send: vi.fn() };
		setContentProtection = vi.fn();
		setVisibleOnAllWorkspaces = vi.fn();
		setAlwaysOnTop = vi.fn();
		isAlwaysOnTop = () => true;
		hide = vi.fn();
		minimize = vi.fn();
		once = vi.fn();
		on = vi.fn();
		loadURL = vi.fn();
		loadFile = vi.fn();
		isDestroyed() {
			return false;
		}
	}
	const handlers = new Map<string, () => void>();
	return { FakeWindow, handlers };
});

vi.mock("electron", () => ({
	app: {},
	BrowserWindow: electron.FakeWindow,
	ipcMain: {
		on: (channel: string, handler: () => void) => electron.handlers.set(channel, handler),
	},
	screen: {
		getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
		on: vi.fn(),
	},
}));

const REAL_PLATFORM = process.platform;

afterAll(() => {
	Object.defineProperty(process, "platform", { value: REAL_PLATFORM, configurable: true });
	Reflect.deleteProperty(process, "getSystemVersion");
});

/** Opens a HUD on `platform` (windows.ts decides at import) and presses "Hide recording bar". */
async function hideHudOn(platform: NodeJS.Platform) {
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
	Object.defineProperty(process, "getSystemVersion", {
		value: () => (platform === "darwin" ? "15.5.0" : "10.0.26100"),
		configurable: true,
	});
	vi.resetModules();
	electron.handlers.clear();
	const { createHudOverlayWindow } = await import("./windows");
	const win = createHudOverlayWindow() as unknown as InstanceType<typeof electron.FakeWindow>;
	electron.handlers.get("hud-overlay-hide")?.();
	return win;
}

describe("Hide recording bar", () => {
	it("hides the HUD on Linux, where a Wayland client cannot un-minimize itself", async () => {
		const win = await hideHudOn("linux");
		expect(win.hide).toHaveBeenCalledOnce();
		expect(win.minimize).not.toHaveBeenCalled();
	});

	it.each(["win32", "darwin"] as const)("still minimizes the HUD on %s", async (platform) => {
		const win = await hideHudOn(platform);
		expect(win.minimize).toHaveBeenCalledOnce();
		expect(win.hide).not.toHaveBeenCalled();
	});
});
