import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
	class FakeWindow {
		webContents = { on: vi.fn(), send: vi.fn() };
		setContentProtection = vi.fn();
		setAutoHideMenuBar = vi.fn();
		setVisibleOnAllWorkspaces = vi.fn();
		once = vi.fn();
		on = vi.fn();
		loadURL = vi.fn();
		loadFile = vi.fn();
	}
	return { FakeWindow };
});

vi.mock("electron", () => ({
	app: {},
	BrowserWindow: electron.FakeWindow,
	ipcMain: { on: vi.fn() },
	screen: {
		getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
		on: vi.fn(),
	},
}));

const REAL_PLATFORM = process.platform;

/** windows.ts reads the platform, the OS version (Electron-only API) and the env at import. */
async function load(platform: NodeJS.Platform, systemVersion: string) {
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
	Object.defineProperty(process, "getSystemVersion", {
		value: () => systemVersion,
		configurable: true,
	});
	vi.resetModules();
	return import("./windows");
}

async function hudProtected(platform: NodeJS.Platform, systemVersion: string) {
	const { createHudOverlayWindow } = await load(platform, systemVersion);
	const win = createHudOverlayWindow() as unknown as InstanceType<typeof electron.FakeWindow>;
	return win.setContentProtection.mock.calls.some(([enable]) => enable === true);
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.stubEnv("OPENSCREEN_DISABLE_CONTENT_PROTECTION", "");
	vi.stubEnv("OPENSCREEN_FORCE_CONTENT_PROTECTION", "");
	warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

afterAll(() => {
	Object.defineProperty(process, "platform", { value: REAL_PLATFORM, configurable: true });
	Reflect.deleteProperty(process, "getSystemVersion");
});

describe("HUD content protection on Windows (#1105)", () => {
	it.each([
		["10 22H2", "10.0.19045"],
		["11 21H2", "10.0.22000"],
	])("is skipped on Windows %s, where it leaves the HUD unclickable", async (_name, version) => {
		expect(await hudProtected("win32", version)).toBe(false);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("OFF for the HUD window"));
	});

	it.each([
		["11 22H2", "10.0.22621"],
		["11 24H2", "10.0.26100"],
	])("is applied on Windows %s", async (_name, version) => {
		expect(await hudProtected("win32", version)).toBe(true);
	});

	it("is applied on Windows 10 with OPENSCREEN_FORCE_CONTENT_PROTECTION=1", async () => {
		vi.stubEnv("OPENSCREEN_FORCE_CONTENT_PROTECTION", "1");
		expect(await hudProtected("win32", "10.0.19045")).toBe(true);
	});

	it("is still lifted by OPENSCREEN_DISABLE_CONTENT_PROTECTION=1 on Windows 11 22H2", async () => {
		vi.stubEnv("OPENSCREEN_DISABLE_CONTENT_PROTECTION", "1");
		expect(await hudProtected("win32", "10.0.22621")).toBe(false);
	});

	it("still protects the Notes window on Windows 10", async () => {
		const { createNotesWindow } = await load("win32", "10.0.19045");
		const win = createNotesWindow() as unknown as InstanceType<typeof electron.FakeWindow>;
		expect(win.setContentProtection).toHaveBeenCalledWith(true);
	});
});

describe("HUD content protection on macOS", () => {
	it("is applied before macOS 26", async () => {
		expect(await hudProtected("darwin", "15.5.0")).toBe(true);
	});

	it("is skipped on macOS 26", async () => {
		expect(await hudProtected("darwin", "26.5.0")).toBe(false);
	});
});
