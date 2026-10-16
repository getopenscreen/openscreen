import { EventEmitter } from "node:events";
import type { BrowserWindow, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { CameraPreviewController } from "./cameraPreview";

function setup() {
	const owner = Object.assign(new EventEmitter(), { send: vi.fn() });
	const overlay = Object.assign(new EventEmitter(), {
		webContents: { send: vi.fn() },
		showInactive: vi.fn(),
		hide: vi.fn(),
		destroy: vi.fn(),
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

	it("allows only the preview to resize to a supported diameter without replacing its window", () => {
		const { preview, sender, overlaySender, resize, create, overlay } = setup();
		preview.configure(sender, true, true);
		preview.resize(sender, 320);
		preview.resize(overlaySender, Number.NaN);
		preview.resize(overlaySender, 10000);
		expect(resize).not.toHaveBeenCalled();
		preview.resize(overlaySender, 320);
		expect(resize).toHaveBeenCalledWith(overlay, 320);
		expect(create).toHaveBeenCalledOnce();
		expect(overlay.destroy).not.toHaveBeenCalled();
	});

	it("destroys the auxiliary window when the HUD is destroyed", () => {
		const { preview, sender, owner, overlay } = setup();
		preview.configure(sender, true, true);
		owner.emit("destroyed");
		expect(overlay.destroy).toHaveBeenCalledOnce();
		preview.frame(sender, jpeg);
		expect(overlay.webContents.send).not.toHaveBeenCalled();
	});

	it("releases listeners on camera-off rather than accumulating them between takes", () => {
		const { preview, sender, owner, overlay } = setup();
		for (let i = 0; i < 15; i++) {
			preview.configure(sender, true, false);
			overlay.emit("ready-to-show");
			preview.configure(sender, false, false);
		}
		expect(owner.listenerCount("destroyed")).toBe(0);
		expect(overlay.destroy).toHaveBeenCalledTimes(15);
	});
});
