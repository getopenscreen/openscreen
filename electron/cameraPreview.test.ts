import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	handlers: new Map<string, (event: unknown, command?: unknown) => unknown>(),
	events: new Map<string, () => void>(),
	window: {
		isDestroyed: vi.fn(() => false),
		showInactive: vi.fn(),
		hide: vi.fn(),
		focus: vi.fn(),
		once: vi.fn((event: string, callback: () => void) => mocks.events.set(event, callback)),
		on: vi.fn(),
		webContents: { send: vi.fn() },
		getBounds: vi.fn(() => ({ x: 50, y: 50, width: 368, height: 214 })),
		setBounds: vi.fn(),
	},
	create: vi.fn(),
}));
vi.mock("electron", () => ({
	ipcMain: {
		handle: (name: string, callback: (event: unknown, command?: unknown) => unknown) =>
			mocks.handlers.set(name, callback),
	},
	screen: {
		getCursorScreenPoint: () => ({ x: 200, y: 200 }),
		getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
	},
}));
vi.mock("./windows", () => ({
	createCameraPreviewWindow: () => {
		mocks.create();
		return mocks.window;
	},
}));
const originalPlatform = process.platform;
beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	mocks.handlers.clear();
	mocks.events.clear();
	Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
});
afterEach(() => {
	Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
});
describe("macOS camera preview", () => {
	it("precreates one stable window before enabling the camera, and keeps it across device changes", async () => {
		const preview = await import("./cameraPreview");
		preview.registerCameraPreview();
		expect(preview.getCameraPreviewWindow()).toBe(mocks.window);
		preview.syncCameraPreview({ camEnabled: false });
		expect(mocks.window.showInactive).not.toHaveBeenCalled();
		preview.syncCameraPreview({ camEnabled: true, camDeviceId: "a" });
		expect(mocks.window.showInactive).not.toHaveBeenCalled();
		mocks.events.get("ready-to-show")?.();
		expect(mocks.window.showInactive).toHaveBeenCalled();
		preview.syncCameraPreview({ camEnabled: true, camDeviceId: "b" });
		expect(mocks.create).toHaveBeenCalledTimes(1);
		expect(mocks.window.webContents.send).toHaveBeenLastCalledWith("camera-preview-state", {
			enabled: true,
			deviceId: "b",
			deviceName: undefined,
		});
	});
	it("stops a dismissed preview without changing the recording preferences; explicit Show or a camera toggle reopens it", async () => {
		const preview = await import("./cameraPreview");
		preview.registerCameraPreview();
		const event = { sender: mocks.window.webContents };
		preview.syncCameraPreview({ camEnabled: true });
		mocks.handlers.get("camera-preview-hide")?.(event);
		preview.syncCameraPreview({ camEnabled: true, camDeviceId: "b" });
		expect(mocks.handlers.get("camera-preview-state")?.(event)).toEqual({
			enabled: false,
			deviceId: "b",
			deviceName: undefined,
		});
		preview.showCameraPreview();
		expect(mocks.handlers.get("camera-preview-state")?.(event)).toMatchObject({ enabled: true });
		mocks.handlers.get("camera-preview-hide")?.(event);
		preview.syncCameraPreview({ camEnabled: false });
		preview.syncCameraPreview({ camEnabled: true });
		expect(mocks.handlers.get("camera-preview-state")?.(event)).toMatchObject({ enabled: true });
	});
	it("rejects other windows and invalid geometry commands", async () => {
		const preview = await import("./cameraPreview");
		preview.registerCameraPreview();
		preview.syncCameraPreview({ camEnabled: true });
		expect(mocks.handlers.get("camera-preview-state")?.({ sender: {} })).toBe(null);
		mocks.handlers.get("camera-preview-hide")?.({ sender: {} });
		const transform = mocks.handlers.get("camera-preview-transform");
		const command = { action: "nudge", direction: "move", dx: 5, dy: 0 };
		transform?.({ sender: {} }, command);
		transform?.({ sender: mocks.window.webContents }, { ...command, dx: Infinity });
		transform?.({ sender: mocks.window.webContents }, { ...command, direction: "invalid" });
		expect(mocks.window.setBounds).not.toHaveBeenCalled();
		transform?.({ sender: mocks.window.webContents }, command);
		expect(mocks.window.setBounds).toHaveBeenCalledWith({ x: 55, y: 50, width: 368, height: 214 });
	});
	it.each(["win32", "linux"])("does not start an unprotected preview on %s", async (platform) => {
		Object.defineProperty(process, "platform", { value: platform, configurable: true });
		const preview = await import("./cameraPreview");
		preview.registerCameraPreview();
		expect(mocks.create).not.toHaveBeenCalled();
	});
});
