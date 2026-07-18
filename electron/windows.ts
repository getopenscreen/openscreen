import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BrowserWindow, ipcMain, screen } from "electron";
import { getHudOverlayResizedBounds } from "./hudOverlayBounds";
import {
	getHudOverlayDragBounds,
	type HudOverlayDragBounds,
	type HudOverlayDragPoint,
	parseHudOverlayDragPoint,
} from "./hudOverlayDrag";
import {
	shouldIgnoreHudOverlayMouseEvents,
	supportsHudOverlayHoverClickThrough,
} from "./hudOverlayMousePolicy";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const APP_ROOT = path.join(__dirname, "..");
const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
const RENDERER_DIST = path.join(APP_ROOT, "dist");
const HEADLESS = process.env["HEADLESS"] === "true";

// Asset base URL for renderer (wallpapers, etc.). Packaged: extraResources copies
// public/wallpapers to resources/wallpapers. Unpackaged: <appRoot>/public/.
const ASSET_BASE_DIR = process.defaultApp
	? path.join(__dirname, "..", "public")
	: process.resourcesPath;
const ASSET_BASE_URL_ARG = `--asset-base-url=${pathToFileURL(`${ASSET_BASE_DIR}${path.sep}`).toString()}`;

let hudOverlayWindow: BrowserWindow | null = null;
let hudOverlayRendererRequestedMouseIgnore = true;
let hudOverlayMouseEventsIgnored: boolean | undefined;
let hudOverlayMousePoll: NodeJS.Timeout | null = null;
let hudOverlayDragTimeout: NodeJS.Timeout | null = null;
const HUD_OVERLAY_DRAG_INACTIVITY_TIMEOUT_MS = 30_000;
let hudOverlayDrag:
	| {
			windowId: number;
			webContentsId: number;
			startWindow: HudOverlayDragBounds;
			startCursor: HudOverlayDragPoint;
	  }
	| undefined;

function setHudOverlayMouseEventsIgnored(ignore: boolean): void {
	// A Windows `app-region: drag` is handled by the OS before Chromium receives
	// hover or pointer events. Keeping the content-sized HUD interactive removes
	// the first-contact race that otherwise makes its drag handle ungrabbable.
	const effectiveIgnore = supportsHudOverlayHoverClickThrough(process.platform) && ignore;
	if (
		!hudOverlayWindow ||
		hudOverlayWindow.isDestroyed() ||
		hudOverlayMouseEventsIgnored === effectiveIgnore
	) {
		return;
	}

	hudOverlayMouseEventsIgnored = effectiveIgnore;
	hudOverlayWindow.setIgnoreMouseEvents(
		effectiveIgnore,
		effectiveIgnore ? { forward: true } : undefined,
	);
}

function applyHudOverlayMousePolicy(): void {
	if (!hudOverlayWindow || hudOverlayWindow.isDestroyed()) {
		return;
	}

	if (!hudOverlayWindow.isVisible()) {
		setHudOverlayMouseEventsIgnored(true);
		return;
	}

	setHudOverlayMouseEventsIgnored(
		shouldIgnoreHudOverlayMouseEvents(
			hudOverlayRendererRequestedMouseIgnore,
			screen.getCursorScreenPoint(),
			hudOverlayWindow.getBounds(),
		),
	);
}

function stopHudOverlayMousePoll(): void {
	if (hudOverlayMousePoll) {
		clearInterval(hudOverlayMousePoll);
		hudOverlayMousePoll = null;
	}
}

function startHudOverlayMousePoll(): void {
	stopHudOverlayMousePoll();
	if (!supportsHudOverlayHoverClickThrough(process.platform)) {
		return;
	}
	// Forwarded renderer hover is unreliable over `app-region: drag` because the
	// OS consumes pointer events there. Polling at display cadence closes that gap.
	hudOverlayMousePoll = setInterval(applyHudOverlayMousePolicy, 16);
	hudOverlayMousePoll.unref();
}

function stopHudOverlayDrag(): void {
	if (hudOverlayDragTimeout) {
		clearTimeout(hudOverlayDragTimeout);
		hudOverlayDragTimeout = null;
	}
	hudOverlayDrag = undefined;
}

function armHudOverlayDragTimeout(): void {
	if (hudOverlayDragTimeout) {
		clearTimeout(hudOverlayDragTimeout);
	}
	hudOverlayDragTimeout = setTimeout(stopHudOverlayDrag, HUD_OVERLAY_DRAG_INACTIVITY_TIMEOUT_MS);
	hudOverlayDragTimeout.unref();
}

function updateHudOverlayDragPosition(currentCursor: HudOverlayDragPoint): void {
	if (
		!hudOverlayDrag ||
		!hudOverlayWindow ||
		hudOverlayWindow.isDestroyed() ||
		hudOverlayWindow.id !== hudOverlayDrag.windowId
	) {
		stopHudOverlayDrag();
		return;
	}

	const nextBounds = getHudOverlayDragBounds(
		hudOverlayDrag.startWindow,
		hudOverlayDrag.startCursor,
		currentCursor,
	);
	hudOverlayWindow.setBounds(nextBounds);
}

ipcMain.on("hud-overlay-hide", () => {
	if (hudOverlayWindow && !hudOverlayWindow.isDestroyed()) {
		hudOverlayWindow.minimize();
	}
});

ipcMain.on("hud-overlay-ignore-mouse-events", (_event, ignore: boolean) => {
	hudOverlayRendererRequestedMouseIgnore = ignore === true;
	applyHudOverlayMousePolicy();
});

ipcMain.on("hud-overlay-drag-start", (event, screenX: unknown, screenY: unknown) => {
	if (
		process.platform !== "win32" ||
		!hudOverlayWindow ||
		hudOverlayWindow.isDestroyed() ||
		event.sender.id !== hudOverlayWindow.webContents.id
	) {
		return;
	}

	setHudOverlayMouseEventsIgnored(false);
	stopHudOverlayDrag();
	const bounds = hudOverlayWindow.getBounds();
	hudOverlayDrag = {
		windowId: hudOverlayWindow.id,
		webContentsId: event.sender.id,
		startWindow: bounds,
		startCursor: parseHudOverlayDragPoint(screenX, screenY) ?? screen.getCursorScreenPoint(),
	};
	// A lost pointer-up must not leave an inactive drag session alive indefinitely.
	armHudOverlayDragTimeout();
});

ipcMain.on("hud-overlay-drag-move", (event, screenX: unknown, screenY: unknown) => {
	if (
		process.platform !== "win32" ||
		!hudOverlayDrag ||
		!hudOverlayWindow ||
		hudOverlayWindow.isDestroyed() ||
		hudOverlayWindow.id !== hudOverlayDrag.windowId ||
		event.sender.id !== hudOverlayDrag.webContentsId
	) {
		return;
	}

	const currentCursor = parseHudOverlayDragPoint(screenX, screenY);
	if (!currentCursor) return;
	updateHudOverlayDragPosition(currentCursor);
	armHudOverlayDragTimeout();
});

ipcMain.on("hud-overlay-drag-end", (event, screenX: unknown, screenY: unknown) => {
	if (hudOverlayDrag?.webContentsId === event.sender.id) {
		// Pointer-up may be the only event containing the final few pixels. For
		// cancel/lost-capture paths the renderer omits coordinates, so use the
		// authoritative Electron cursor point instead of accepting a synthetic 0,0.
		const finalCursor = parseHudOverlayDragPoint(screenX, screenY) ?? screen.getCursorScreenPoint();
		updateHudOverlayDragPosition(finalCursor);
		stopHudOverlayDrag();
	}
});

// Resize the HUD to fit its rendered content. Anchored by its bottom-centre so it
// stays where the user dragged it while only growing/shrinking, which lets the
// vertical tray layout grow tall instead of scrolling inside a fixed window.
ipcMain.on("hud-overlay-set-size", (_event, width: number, height: number) => {
	if (
		!hudOverlayWindow ||
		hudOverlayWindow.isDestroyed() ||
		!Number.isFinite(width) ||
		!Number.isFinite(height)
	) {
		return;
	}

	const bounds = hudOverlayWindow.getBounds();

	// Clamp to the work area of the display the HUD sits on; on a short screen the
	// vertical layout can exceed the display, where the bar's own overflow scroll takes over.
	const { workArea } = screen.getDisplayMatching(bounds);
	const nextBounds = getHudOverlayResizedBounds(bounds, workArea, width, height);

	if (
		bounds.x === nextBounds.x &&
		bounds.y === nextBounds.y &&
		bounds.width === nextBounds.width &&
		bounds.height === nextBounds.height
	) {
		return;
	}

	hudOverlayWindow.setBounds(nextBounds);
});

/**
 * Frameless transparent HUD overlay, always-on-top, centred at the bottom of the
 * primary display. Follows the user across macOS Spaces so it isn't lost on switch.
 */
export function createHudOverlayWindow(): BrowserWindow {
	const primaryDisplay = screen.getPrimaryDisplay();
	const { workArea } = primaryDisplay;

	const windowWidth = 600;
	const windowHeight = 160;

	const x = Math.floor(workArea.x + (workArea.width - windowWidth) / 2);
	const y = Math.floor(workArea.y + workArea.height - windowHeight - 5);

	const win = new BrowserWindow({
		width: windowWidth,
		height: windowHeight,
		// Min/max are intentionally loose: the renderer resizes to fit content via
		// "hud-overlay-set-size" (above), needed for the vertical tray to grow taller.
		minWidth: 120,
		minHeight: 80,
		x: x,
		y: y,
		frame: false,
		transparent: true,
		// Fully-transparent ARGB backing. Without this macOS draws the window as a
		// rounded glass panel with a border around the HUD content.
		backgroundColor: "#00000000",
		// Don't let macOS mask the window into a rounded rect; the HUD bar provides
		// its own rounding and the window itself must be invisible.
		roundedCorners: false,
		resizable: false,
		movable: true,
		alwaysOnTop: true,
		skipTaskbar: true,
		hasShadow: false,
		show: false, // shown via ready-to-show to avoid black rectangle flash
		webPreferences: {
			preload: path.join(__dirname, "preload.mjs"),
			additionalArguments: [ASSET_BASE_URL_ARG],
			nodeIntegration: false,
			contextIsolation: true,
			backgroundThrottling: false,
		},
	});

	// Follow the user across macOS Spaces, else the HUD stays pinned to the Space
	// it was first opened on.
	if (process.platform === "darwin") {
		win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
	}

	// Show only once painted to avoid the black rectangle flash when a transparent
	// window is shown before its first paint.
	win.once("ready-to-show", () => {
		if (!HEADLESS) win.show();
	});

	win.webContents.on("did-finish-load", () => {
		win?.webContents.send("main-process-message", new Date().toLocaleString());
	});

	stopHudOverlayMousePoll();
	hudOverlayWindow = win;
	hudOverlayRendererRequestedMouseIgnore = true;
	hudOverlayMouseEventsIgnored = undefined;
	setHudOverlayMouseEventsIgnored(true);
	startHudOverlayMousePoll();

	win.on("closed", () => {
		if (hudOverlayWindow === win) {
			stopHudOverlayMousePoll();
			stopHudOverlayDrag();
			hudOverlayWindow = null;
			hudOverlayMouseEventsIgnored = undefined;
		}
	});

	if (VITE_DEV_SERVER_URL) {
		win.loadURL(VITE_DEV_SERVER_URL + "?windowType=hud-overlay");
	} else {
		win.loadFile(path.join(RENDERER_DIST, "index.html"), {
			query: { windowType: "hud-overlay" },
		});
	}

	return win;
}

/**
 * Main editor window. Starts maximised with a hidden title bar on macOS; not
 * always-on-top and appears in the taskbar/dock.
 */
export function createEditorWindow(): BrowserWindow {
	const isMac = process.platform === "darwin";

	const win = new BrowserWindow({
		width: 1200,
		height: 800,
		minWidth: 800,
		minHeight: 600,
		...(isMac && {
			titleBarStyle: "hiddenInset",
			trafficLightPosition: { x: 12, y: 12 },
		}),
		transparent: false,
		resizable: true,
		alwaysOnTop: false,
		skipTaskbar: false,
		title: "OpenScreen",
		backgroundColor: "#09090b",
		show: false, // shown via ready-to-show to avoid white flash on first load
		webPreferences: {
			preload: path.join(__dirname, "preload.mjs"),
			additionalArguments: [ASSET_BASE_URL_ARG],
			nodeIntegration: false,
			contextIsolation: true,
			webSecurity: false,
			backgroundThrottling: false,
		},
	});

	win.maximize();

	// The editor renders its own File/Edit/View menu bar in the custom titlebar,
	// so hide the native OS menu bar on Windows/Linux (it stays reachable via Alt).
	// macOS keeps its global menu bar.
	if (process.platform !== "darwin") {
		win.setAutoHideMenuBar(true);
	}

	// Show only once painted to avoid a white flash on cold Vite start.
	win.once("ready-to-show", () => {
		if (!HEADLESS) win.show();
	});

	// Inject dark background before any React paint so the sub-titlebar area never
	// flashes white on a cold Vite load.
	win.webContents.on("dom-ready", () => {
		win.webContents.insertCSS("html, body, #root { background: #09090b !important; }").catch(() => {
			// Best-effort cosmetic; ignore if the page is mid-teardown.
		});
	});

	win.webContents.on("did-finish-load", () => {
		win?.webContents.send("main-process-message", new Date().toLocaleString());
	});

	if (VITE_DEV_SERVER_URL) {
		win.loadURL(VITE_DEV_SERVER_URL + "?windowType=editor");
	} else {
		win.loadFile(path.join(RENDERER_DIST, "index.html"), {
			query: { windowType: "editor" },
		});
	}

	return win;
}

/**
 * Floating source-selector window for picking a screen or window to record.
 * Frameless, transparent, and follows the user across macOS Spaces.
 */
export function createSourceSelectorWindow(): BrowserWindow {
	const { width, height } = screen.getPrimaryDisplay().workAreaSize;

	const win = new BrowserWindow({
		width: 620,
		height: 420,
		minHeight: 350,
		maxHeight: 500,
		x: Math.round((width - 620) / 2),
		y: Math.round((height - 420) / 2),
		frame: false,
		resizable: false,
		alwaysOnTop: true,
		transparent: true,
		backgroundColor: "#00000000",
		webPreferences: {
			preload: path.join(__dirname, "preload.mjs"),
			additionalArguments: [ASSET_BASE_URL_ARG],
			nodeIntegration: false,
			contextIsolation: true,
		},
	});

	// Follow the user across macOS Spaces so the selector appears on the active
	// desktop regardless of where the HUD was opened.
	if (process.platform === "darwin") {
		win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
	}

	if (VITE_DEV_SERVER_URL) {
		win.loadURL(VITE_DEV_SERVER_URL + "?windowType=source-selector");
	} else {
		win.loadFile(path.join(RENDERER_DIST, "index.html"), {
			query: { windowType: "source-selector" },
		});
	}

	return win;
}

/**
 * Centered transparent countdown overlay that sits above the HUD during
 * recording pre-roll.
 */
export function createCountdownOverlayWindow(): BrowserWindow {
	const { workArea } = screen.getPrimaryDisplay();
	const overlayWidth = 420;
	const overlayHeight = 260;

	const win = new BrowserWindow({
		width: overlayWidth,
		height: overlayHeight,
		minWidth: overlayWidth,
		maxWidth: overlayWidth,
		minHeight: overlayHeight,
		maxHeight: overlayHeight,
		x: Math.round(workArea.x + (workArea.width - overlayWidth) / 2),
		y: Math.round(workArea.y + (workArea.height - overlayHeight) / 2),
		frame: false,
		resizable: false,
		alwaysOnTop: true,
		skipTaskbar: true,
		focusable: false,
		transparent: true,
		backgroundColor: "#00000000",
		hasShadow: false,
		show: false,
		webPreferences: {
			preload: path.join(__dirname, "preload.mjs"),
			additionalArguments: [ASSET_BASE_URL_ARG],
			nodeIntegration: false,
			contextIsolation: true,
			backgroundThrottling: false,
		},
	});

	win.setIgnoreMouseEvents(true);

	if (process.platform === "darwin") {
		win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
	}

	if (VITE_DEV_SERVER_URL) {
		win.loadURL(VITE_DEV_SERVER_URL + "?windowType=countdown-overlay");
	} else {
		win.loadFile(path.join(RENDERER_DIST, "index.html"), {
			query: { windowType: "countdown-overlay" },
		});
	}

	return win;
}

// Frameless Notes Window for taking notes during a recording.
export function createNotesWindow(): BrowserWindow {
	const win = new BrowserWindow({
		width: 400,
		height: 540,
		minWidth: 360,
		minHeight: 400,
		maxWidth: 640,
		maxHeight: 720,
		title: "OpenScreen - Notes",
		backgroundColor: "#09090b",
		resizable: true,
		alwaysOnTop: true,
		skipTaskbar: false,
		show: false,
		webPreferences: {
			preload: path.join(__dirname, "preload.mjs"),
			additionalArguments: [ASSET_BASE_URL_ARG],
			nodeIntegration: false,
			contextIsolation: true,
			backgroundThrottling: false,
		},
	});

	// Match the editor: no native OS menu bar on Windows/Linux (reachable via Alt).
	if (process.platform !== "darwin") {
		win.setAutoHideMenuBar(true);
	}

	win.setContentProtection(true);
	win.once("ready-to-show", () => {
		win.setContentProtection(true);
		win.show();
	});

	if (VITE_DEV_SERVER_URL) {
		win.loadURL(VITE_DEV_SERVER_URL + "?showNotes=true");
	} else {
		win.loadFile(path.join(RENDERER_DIST, "index.html"), {
			query: { showNotes: "true" },
		});
	}

	return win;
}
