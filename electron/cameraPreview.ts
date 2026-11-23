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
	private hud: BrowserWindow | null = null;
	private hudListeners: Array<[string, () => void]> = [];

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
				if (this.owner !== owner) return;
				// Wayland keeps the window for the next HUD, so an editor round trip does not
				// hand it back to the compositor to place anew.
				if (this.parkWindow) this.release();
				else this.dispose();
			};
			owner.once("destroyed", this.onOwnerDestroyed);
			// Windows and macOS minimize the HUD, Linux hides it; the tray brings it back.
			const hud = this.windowOf(owner);
			if (hud) {
				this.hud = hud;
				this.ownerShown = hud.isVisible() && !hud.isMinimized();
				const hidden = () => this.setOwnerShown(false);
				const shown = () => this.setOwnerShown(true);
				this.hudListeners = [
					["minimize", hidden],
					["hide", hidden],
					["restore", shown],
					["show", shown],
				];
				for (const [event, listener] of this.hudListeners) hud.on(event as "show", listener);
			}
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
		// The HUD configures on mount, camera on or off. With the camera off, do not open a
		// second content-protected transparent window beside the HUD at launch: v2.3.0 did,
		// and on macOS 15 the HUD then never painted (#1639). The macOS capture paths still
		// reserve the window before they read exclusion IDs (ensureMacCameraPreviewWindow).
		if (!enabled && !this.window) return;
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

	private detachOwner(): void {
		if (this.owner && this.onOwnerDestroyed) {
			this.owner.removeListener("destroyed", this.onOwnerDestroyed);
		}
		this.onOwnerDestroyed = null;
		for (const [event, listener] of this.hudListeners) {
			this.hud?.removeListener(event as "show", listener);
		}
		this.hud = null;
		this.hudListeners = [];
		this.owner = null;
		this.visible = false;
		this.captureAllowed = true;
		this.ownerShown = true;
		this.captureGeneration++;
	}

	/**
	 * The HUD is gone (the editor opened) but its window stays, parked where the user left it,
	 * with its size, for the next HUD to adopt: the window outlives HUDs only where it is parked.
	 * main.ts destroys it if it is all that is left open, so it never holds the app up.
	 */
	private release(): void {
		if (this.window) this.conceal(this.window);
		this.detachOwner();
	}

	dispose(): void {
		this.detachOwner();
		this.ready = false;
		this.parked = false;
		const previewWindow = this.window;
		this.window = null;
		previewWindow?.destroy();
		this.width = CAMERA_PREVIEW_DEFAULT_SIZE;
		this.aspectRatio = CAMERA_PREVIEW_DEFAULT_ASPECT_RATIO;
	}
}
