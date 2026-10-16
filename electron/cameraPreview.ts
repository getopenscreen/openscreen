import type { BrowserWindow, WebContents } from "electron";
import { CAMERA_PREVIEW_SIZES } from "../src/lib/cameraPreview";

/** One stable window per HUD: hiding it must not change the native capture exclusion id. */
export class CameraPreviewController {
	private window: BrowserWindow | null = null;
	private owner: WebContents | null = null;
	private visible = false;
	private ready = false;
	private onOwnerDestroyed: (() => void) | null = null;

	constructor(
		private readonly createWindow: () => BrowserWindow,
		private readonly resizeWindow: (window: BrowserWindow, diameter: number) => void,
	) {}

	configure(owner: WebContents, enabled: boolean, visible: boolean): void {
		if (this.owner && this.owner !== owner) return;
		if (!enabled) {
			this.dispose();
			return;
		}
		if (!this.owner) {
			this.owner = owner;
			this.onOwnerDestroyed = () => {
				if (this.owner === owner) this.dispose();
			};
			owner.once("destroyed", this.onOwnerDestroyed);
		}
		if (!this.window) {
			this.window = this.createWindow();
			const previewWindow = this.window;
			this.window.once("ready-to-show", () => {
				if (this.window !== previewWindow) return;
				this.ready = true;
				if (this.visible) this.window?.showInactive();
			});
		}
		this.visible = visible;
		if (visible && this.ready) this.window.showInactive();
		else if (!visible) this.window.hide();
	}

	hide(sender: WebContents): void {
		if (sender !== this.window?.webContents) return;
		this.visible = false;
		this.window.hide();
		this.owner?.send("camera-preview:hidden");
	}

	resize(sender: WebContents, diameter: unknown): void {
		if (
			sender !== this.window?.webContents ||
			typeof diameter !== "number" ||
			!CAMERA_PREVIEW_SIZES.some((size) => size === diameter)
		)
			return;
		this.resizeWindow(this.window, diameter);
	}

	frame(sender: WebContents, jpeg: unknown): void {
		if (sender !== this.owner || !this.visible || !this.window) return;
		// A 320px JPEG is usually under 20KB. Never relay arbitrary URLs or unbounded IPC data.
		if (
			typeof jpeg !== "string" ||
			jpeg.length > 128_000 ||
			!jpeg.startsWith("data:image/jpeg;base64,")
		)
			return;
		this.window.webContents.send("camera-preview:frame", jpeg);
	}

	dispose(): void {
		if (this.owner && this.onOwnerDestroyed) {
			this.owner.removeListener("destroyed", this.onOwnerDestroyed);
		}
		this.onOwnerDestroyed = null;
		this.ready = false;
		this.window?.destroy();
		this.window = null;
		this.owner = null;
		this.visible = false;
	}
}
