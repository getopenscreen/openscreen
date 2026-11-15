import type { BrowserWindow, WebContents } from "electron";
import {
	CAMERA_PREVIEW_DEFAULT_ASPECT_RATIO,
	CAMERA_PREVIEW_DEFAULT_SIZE,
	CAMERA_PREVIEW_SIZES,
} from "../src/lib/cameraPreview";

/** One stable window per HUD: hiding it must not change the native capture exclusion id. */
export class CameraPreviewController {
	private window: BrowserWindow | null = null;
	private owner: WebContents | null = null;
	private visible = false;
	private captureAllowed = true;
	/** False while the HUD is minimized or hidden ("Hide recording bar"): the preview goes with it. */
	private ownerShown = true;
	private captureGeneration = 0;
	private width: number = CAMERA_PREVIEW_DEFAULT_SIZE;
	private aspectRatio = CAMERA_PREVIEW_DEFAULT_ASPECT_RATIO;
	private ready = false;
	private onOwnerDestroyed: (() => void) | null = null;
	private parked = false;

	/**
	 * `parkWindow`, when given, stands in for hiding a preview already on screen. Wayland needs
	 * it: a client cannot position its window there, so a hidden preview is placed anew by the
	 * compositor when it comes back (top-left on GNOME, over the HUD), losing wherever the user
	 * had dragged it. A parked window stays mapped where it was and draws nothing.
	 */
	constructor(
		private readonly createWindow: () => BrowserWindow,
		private readonly resizeWindow: (
			window: BrowserWindow,
			width: number,
			aspectRatio: number,
		) => void,
		private readonly parkWindow?: (window: BrowserWindow) => void,
		private readonly windowOf: (owner: WebContents) => BrowserWindow | null = () => null,
	) {}

	private shouldShow(): boolean {
		return this.visible && this.captureAllowed && this.ownerShown;
	}

	private conceal(window: BrowserWindow): void {
		if (this.parkWindow && window.isVisible()) {
			if (!this.parked) this.parkWindow(window);
			this.parked = true;
		} else {
			window.hide();
		}
	}

	private reveal(window: BrowserWindow): void {
		if (this.parked) {
			this.parked = false;
			this.resizeWindow(window, this.width, this.aspectRatio);
		}
		window.showInactive();
	}

	/** Reserve the capture-exclusion window before renderer configuration arrives. */
	ensure(owner: WebContents): BrowserWindow | null {
		if (this.owner && this.owner !== owner) return null;
		if (!this.owner) {
			this.owner = owner;
			owner.send("camera-preview:availability", this.captureAllowed);
			this.onOwnerDestroyed = () => {
				if (this.owner === owner) this.dispose();
			};
			owner.once("destroyed", this.onOwnerDestroyed);
			// Windows and macOS minimize the HUD, Linux hides it; the tray brings it back.
			const hud = this.windowOf(owner);
			hud?.on("minimize", () => this.setOwnerShown(false));
			hud?.on("hide", () => this.setOwnerShown(false));
			hud?.on("restore", () => this.setOwnerShown(true));
			hud?.on("show", () => this.setOwnerShown(true));
		}
		if (!this.window) {
			this.window = this.createWindow();
			const previewWindow = this.window;
			// A system-menu close is the same action as the preview's hide button.
			// Retain the native ID for capture exclusions and the renderer's size state.
			previewWindow.on("close", (event) => {
				event.preventDefault();
				this.hide(previewWindow.webContents);
			});
			previewWindow.once("closed", () => {
				if (this.window !== previewWindow) return;
				this.window = null;
				this.ready = false;
				this.visible = false;
				this.parked = false;
				this.owner?.send("camera-preview:hidden");
			});
			this.window.once("ready-to-show", () => {
				if (this.window !== previewWindow) return;
				this.ready = true;
				this.resizeWindow(previewWindow, this.width, this.aspectRatio);
				if (this.shouldShow()) this.reveal(previewWindow);
			});
		}
		return this.window;
	}

	configure(owner: WebContents, enabled: boolean, visible: boolean): void {
		const previewWindow = this.ensure(owner);
		if (!previewWindow) return;
		this.visible = enabled && visible;
		if (this.shouldShow() && this.ready) this.reveal(previewWindow);
		else if (!this.shouldShow()) this.conceal(previewWindow);
	}

	/** Linux portal monitor captures cannot exclude app windows. */
	setCaptureAllowed(allowed: boolean): void {
		this.captureGeneration++;
		this.captureAllowed = allowed;
		const previewWindow = this.window;
		if (previewWindow && !allowed) this.conceal(previewWindow);
		else if (previewWindow && this.shouldShow() && this.ready) this.reveal(previewWindow);
		this.owner?.send("camera-preview:availability", allowed);
	}

	setOwnerShown(shown: boolean): void {
		if (this.ownerShown === shown) return;
		this.ownerShown = shown;
		const previewWindow = this.window;
		if (previewWindow && !shown) this.conceal(previewWindow);
		else if (previewWindow && this.shouldShow() && this.ready) this.reveal(previewWindow);
	}

	/** A cancelled browser start may restore only its own preview suspension. */
	prepareCapture(): number {
		this.setCaptureAllowed(false);
		return this.captureGeneration;
	}

	restoreCapture(token: unknown): void {
		if (token === this.captureGeneration) this.setCaptureAllowed(true);
	}

	hide(sender: WebContents): void {
		if (sender !== this.window?.webContents) return;
		this.visible = false;
		this.conceal(this.window);
		this.owner?.send("camera-preview:hidden");
	}

	resize(sender: WebContents, width: unknown): void {
		if (
			sender !== this.window?.webContents ||
			typeof width !== "number" ||
			!CAMERA_PREVIEW_SIZES.some((size) => size === width)
		)
			return;
		this.width = width;
		// A parked preview takes its new width when it comes back (reveal).
		if (!this.parked) this.resizeWindow(this.window, this.width, this.aspectRatio);
	}

	frame(sender: WebContents, jpeg: unknown, aspectRatio?: unknown): void {
		if (sender !== this.owner || !this.visible || !this.captureAllowed || !this.window) return;
		// A 320px JPEG is usually under 20KB. Never relay arbitrary URLs or unbounded IPC data.
		if (
			typeof jpeg !== "string" ||
			jpeg.length > 128_000 ||
			!jpeg.startsWith("data:image/jpeg;base64,")
		)
			return;
		if (aspectRatio !== undefined) {
			if (
				typeof aspectRatio !== "number" ||
				!Number.isFinite(aspectRatio) ||
				aspectRatio < 1 / 8 ||
				aspectRatio > 8
			)
				return;
			if (this.aspectRatio !== aspectRatio) {
				this.aspectRatio = aspectRatio;
				this.resizeWindow(this.window, this.width, aspectRatio);
			}
		}
		this.window.webContents.send("camera-preview:frame", jpeg);
	}

	dispose(): void {
		if (this.owner && this.onOwnerDestroyed) {
			this.owner.removeListener("destroyed", this.onOwnerDestroyed);
		}
		this.onOwnerDestroyed = null;
		this.ready = false;
		this.parked = false;
		const previewWindow = this.window;
		this.window = null;
		this.owner = null;
		previewWindow?.destroy();
		this.visible = false;
		this.captureAllowed = true;
		this.ownerShown = true;
		this.captureGeneration++;
		this.width = CAMERA_PREVIEW_DEFAULT_SIZE;
		this.aspectRatio = CAMERA_PREVIEW_DEFAULT_ASPECT_RATIO;
	}
}
