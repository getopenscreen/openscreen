import { EventEmitter } from "node:events";
import type { BrowserWindow, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { collectMacCaptureExcludedWindowIds } from "../src/lib/nativeMacRecording";
import { CameraPreviewController } from "./cameraPreview";

function setup() {
	const owner = Object.assign(new EventEmitter(), { send: vi.fn() });
	const overlay = Object.assign(new EventEmitter(), {
		getMediaSourceId: () => "window:123:0",
		webContents: { send: vi.fn() },
		showInactive: vi.fn(),
		hide: vi.fn(),
		destroy: vi.fn(() => {
			overlay.emit("closed");
		}),
	});
	const create = vi.fn(() => overlay as unknown as BrowserWindow);
	const resize = vi.fn();
	const preview = new CameraPreviewController(create, resize);
	const sender = owner as unknown as WebContents;
	const overlaySender = overlay.webContents as unknown as WebContents;
	return { owner, overlay, create, resize, preview, sender, overlaySender };
}

const jpeg = "data:image/jpeg;base64,/9j/";

describe("floating camera preview lifecycle", () => {
	it("reserves the same exclusion ID before the renderer enables the preview", () => {
		const { preview, sender, overlay, create } = setup();
		const reserved = preview.ensure(sender);
		const excludedIds = collectMacCaptureExcludedWindowIds([reserved!.getMediaSourceId()]);
		expect(excludedIds).toContain(123);
		overlay.emit("ready-to-show");
		expect(overlay.showInactive).not.toHaveBeenCalled();
		preview.configure(sender, true, true);
		expect(preview.ensure(sender)).toBe(reserved);
		expect(create).toHaveBeenCalledOnce();
		expect(overlay.showInactive).toHaveBeenCalledOnce();
		expect(excludedIds).toContain(123);
	});

	it("ensuring an existing preview preserves visibility and refuses a different owner", () => {
		const { preview, sender, overlay, create } = setup();
		preview.configure(sender, true, true);
		overlay.emit("ready-to-show");
		expect(preview.ensure(sender)).toBe(overlay);
		expect(preview.ensure({} as WebContents)).toBeNull();
		preview.frame(sender, jpeg);
		expect(overlay.webContents.send).toHaveBeenCalledWith("camera-preview:frame", jpeg);
		expect(overlay.hide).not.toHaveBeenCalled();
		expect(create).toHaveBeenCalledOnce();
	});

	it("waits for the window to paint, then shows without taking focus", () => {
		const { preview, sender, overlay } = setup();
		preview.configure(sender, true, true);
		expect(overlay.showInactive).not.toHaveBeenCalled();
		overlay.emit("ready-to-show");
		expect(overlay.showInactive).toHaveBeenCalledOnce();
	});

	it("hides and restores the same window, retaining its capture exclusion id", () => {
		const { preview, sender, overlaySender, overlay, owner, create } = setup();
		preview.configure(sender, true, true);
		overlay.emit("ready-to-show");
		preview.hide(overlaySender);
		expect(owner.send).toHaveBeenCalledWith("camera-preview:hidden");
		preview.frame(sender, jpeg);
		expect(overlay.webContents.send).not.toHaveBeenCalled();
		preview.configure(sender, true, true);
		expect(create).toHaveBeenCalledOnce();
		expect(overlay.destroy).not.toHaveBeenCalled();
		preview.frame(sender, jpeg);
		expect(overlay.webContents.send).toHaveBeenCalledWith("camera-preview:frame", jpeg);
	});

	it("does not flash a preview disabled before its renderer is ready", () => {
		const { preview, sender, overlay } = setup();
		preview.configure(sender, true, true);
		preview.configure(sender, true, false);
		overlay.emit("ready-to-show");
		expect(overlay.showInactive).not.toHaveBeenCalled();
	});

	it("ignores other renderers and rejects oversized or non-JPEG frames", () => {
		const { preview, sender, overlay, create } = setup();
		const stranger = {} as WebContents;
		preview.configure(sender, true, true);
		preview.configure(stranger, false, false);
		preview.hide(stranger);
		for (const invalid of [undefined, "https://example.com/camera", jpeg + "x".repeat(128_000)]) {
			preview.frame(sender, invalid);
		}
		preview.frame(stranger, jpeg);
		expect(overlay.webContents.send).not.toHaveBeenCalled();
		expect(overlay.destroy).not.toHaveBeenCalled();
		expect(create).toHaveBeenCalledOnce();
	});

	it("allows only the preview to resize to a supported width without replacing its window", () => {
		const { preview, sender, overlaySender, resize, create, overlay } = setup();
		preview.configure(sender, true, true);
		preview.resize(sender, 320);
		preview.resize(overlaySender, Number.NaN);
		preview.resize(overlaySender, 10000);
		expect(resize).not.toHaveBeenCalled();
		preview.resize(overlaySender, 320);
		expect(resize).toHaveBeenCalledWith(overlay, 320, 16 / 9);
		expect(create).toHaveBeenCalledOnce();
		expect(overlay.destroy).not.toHaveBeenCalled();
	});

	it("sizes the same window to the delivered frame and preserves that ratio on resize", () => {
		const { preview, sender, overlaySender, resize, overlay } = setup();
		preview.configure(sender, true, true);
		preview.frame(sender, jpeg, 9 / 16);
		expect(resize).toHaveBeenLastCalledWith(overlay, 224, 9 / 16);
		preview.resize(overlaySender, 320);
		expect(resize).toHaveBeenLastCalledWith(overlay, 320, 9 / 16);
		const calls = resize.mock.calls.length;
		for (const ratio of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 100, "16:9"]) {
			preview.frame(sender, jpeg, ratio);
		}
		expect(resize).toHaveBeenCalledTimes(calls);
	});

	it("recreates an unexpectedly closed preview and waits for the replacement to be ready", () => {
		const { preview, sender, overlay, create } = setup();
		const replacement = setup().overlay;
		create
			.mockReturnValueOnce(overlay as unknown as BrowserWindow)
			.mockReturnValueOnce(replacement as unknown as BrowserWindow);
		preview.configure(sender, true, true);
		overlay.emit("ready-to-show");
		overlay.emit("closed");
		preview.frame(sender, jpeg);
		expect(overlay.webContents.send).not.toHaveBeenCalled();

		preview.configure(sender, true, true);
		expect(create).toHaveBeenCalledTimes(2);
		expect(replacement.showInactive).not.toHaveBeenCalled();
		replacement.emit("ready-to-show");
		expect(replacement.showInactive).toHaveBeenCalledOnce();
	});

	it("ignores a stale closed event from a previously disposed preview", () => {
		const { preview, sender, overlay, create } = setup();
		// Delay closure to exercise a late event after the replacement already exists.
		overlay.destroy.mockImplementationOnce(() => undefined);
		const replacement = setup().overlay;
		create
			.mockReturnValueOnce(overlay as unknown as BrowserWindow)
			.mockReturnValueOnce(replacement as unknown as BrowserWindow);
		preview.configure(sender, true, true);
		preview.dispose();
		preview.configure(sender, true, true);
		replacement.emit("ready-to-show");

		overlay.emit("closed");
		preview.frame(sender, jpeg);
		expect(replacement.webContents.send).toHaveBeenCalledWith("camera-preview:frame", jpeg);
		preview.configure(sender, true, true);
		expect(create).toHaveBeenCalledTimes(2);
		expect(replacement.showInactive).toHaveBeenCalledTimes(2);
	});

	it("destroys the auxiliary window when the HUD is destroyed", () => {
		const { preview, sender, owner, overlay } = setup();
		preview.configure(sender, true, true);
		owner.emit("destroyed");
		expect(overlay.destroy).toHaveBeenCalledOnce();
		preview.frame(sender, jpeg);
		expect(overlay.webContents.send).not.toHaveBeenCalled();
	});

	it("creates a hidden exclusion window even when the camera starts off", () => {
		const { preview, sender, owner, overlay, create } = setup();
		preview.configure(sender, false, true);
		overlay.emit("ready-to-show");
		expect(create).toHaveBeenCalledOnce();
		expect(overlay.hide).toHaveBeenCalledOnce();
		expect(overlay.showInactive).not.toHaveBeenCalled();
		preview.frame(sender, jpeg);
		expect(overlay.webContents.send).not.toHaveBeenCalled();
		preview.configure(sender, true, true);
		expect(create).toHaveBeenCalledOnce();
		expect(overlay.showInactive).toHaveBeenCalledOnce();
		owner.emit("destroyed");
		expect(overlay.destroy).toHaveBeenCalledOnce();
	});

	it("retains the exclusion window and one owner listener across camera toggles", () => {
		const { preview, sender, owner, overlay, create } = setup();
		for (let i = 0; i < 15; i++) {
			preview.configure(sender, true, true);
			if (i === 0) overlay.emit("ready-to-show");
			preview.configure(sender, false, true);
		}
		expect(create).toHaveBeenCalledOnce();
		expect(overlay.hide).toHaveBeenCalledTimes(15);
		expect(overlay.showInactive).toHaveBeenCalledTimes(15);
		expect(overlay.destroy).not.toHaveBeenCalled();
		expect(owner.listenerCount("destroyed")).toBe(1);
		owner.emit("destroyed");
		expect(owner.listenerCount("destroyed")).toBe(0);
		expect(overlay.destroy).toHaveBeenCalledOnce();
	});
});
