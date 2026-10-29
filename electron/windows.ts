import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain, screen } from "electron";
import {
	type HudPanelAction,
	type HudPanelState,
	hudPanelHasContent,
} from "../src/components/launch/hudPanel";
import {
	fitEditorRect,
	loadEditorWindowState,
	resolveEditorCreation,
	saveEditorWindowState,
	shouldTrackEditorWindow,
	WAYLAND_MAXIMIZE_SETTLE_MS,
} from "./editorWindowState";
import { HUD_FRAMED_BY_COMPOSITOR_ARG } from "./hudWindowArgs";
import {
	clampHudBoundsToWorkArea,
	HUD_WINDOW_MIN,
	type HudContentRect,
	hudBarAnchor,
	hudContentScreenRect,
	hudDragDestination,
	hudResizeBounds,
	parseHudContentRect,
	sameRect,
} from "./hudWindowBounds";
import {
	placeHudBarAtBottom,
	placeHudPanelNearBar,
	presetHudBarPlacement,
	presetHudPanelPlacement,
	runsUnderHyprland,
} from "./hyprland";
import { keepAlwaysOnTop, reassertAlwaysOnTop } from "./keepOnTop";
import { followAcrossSpaces } from "./macSpaces";
import { markSheetless } from "./messageBox";
import { usesWaylandBackend } from "./wayland";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const APP_ROOT = path.join(__dirname, "..");
const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
const RENDERER_DIST = path.join(APP_ROOT, "dist");
const HEADLESS = process.env["HEADLESS"] === "true";

// The HUD and Notes windows are excluded from every screen/window capture (WGC on Windows uses
// the same SetWindowDisplayAffinity this sets), so the recording controls never end up baked into
// the recorded video.
//
// The side effect is that they are equally invisible to an *agent's* screenshots, and the HUD is
// what opens the editor — which makes a whole slice of the app unreachable from automation. Hence
// this escape hatch, for testing only. It warns on every window it skips, because a recording made
// while it is set WILL contain the HUD.
const CONTENT_PROTECTION_DISABLED = process.env["OPENSCREEN_DISABLE_CONTENT_PROTECTION"] === "1";

// Forces protection back on where it is auto-disabled below, so the macOS and
// Windows regressions can be re-tested against a future Electron without editing code.
const CONTENT_PROTECTION_FORCED = process.env["OPENSCREEN_FORCE_CONTENT_PROTECTION"] === "1";

/**
 * macOS 26 (Darwin 25) never displays a window that has had
 * `setContentProtection(true)` applied to it.
 *
 * Not "excludes it from captures" — which is the documented behaviour and the
 * whole point — but never paints it for the user either. Confirmed on Darwin
 * 25.5 / Electron 41.2.1 with the HUD: tray icon present, renderer alive and
 * painting (React mounted, no console errors), `ready-to-show` fired, `show()`
 * called, window at valid on-screen coordinates on the main display — and
 * nothing on screen. `showMainWindow()` from the tray and the global shortcut
 * were equally inert, because the window was already "visible" as far as
 * Electron was concerned. Unsetting protection makes it appear instantly; the
 * ordering of protect-vs-show makes no difference, so it is the call itself.
 *
 * `setContentProtection` maps to `NSWindow.sharingType = NSWindowSharingNone`,
 * a path Electron has repeatedly churned on (electron/electron#45990, and
 * PR #46886 reverting a macOS content-protection refactor).
 *
 * Gated on the Darwin major version rather than `darwin` wholesale: the
 * breakage is only *confirmed* on 25.x, and silently dropping protection on
 * older macOS — where it may well work — would be a privacy regression made on
 * no evidence.
 *
 * ScreenCaptureKit ignores `sharingType`, so the native recorder independently
 * excludes the HUD and Notes windows by their native IDs. This call remains the
 * Windows protection and a second line of defence on older macOS releases.
 */
const CONTENT_PROTECTION_BREAKS_DISPLAY = (() => {
	if (process.platform !== "darwin") return false;
	// getSystemVersion() reports the *macOS* version on darwin, not the Darwin
	// kernel version: measured "26.5.0" here where `os.release()` is "25.5.0".
	// So the affected major is 26, and the check must not be fed os.release().
	const macOSMajor = Number.parseInt(process.getSystemVersion().split(".")[0] ?? "", 10);
	return Number.isFinite(macOSMajor) && macOSMajor >= 26;
})();

/**
 * Windows before 11 22H2 never lets the click-through HUD take a click again once
 * it is content-protected (#1105).
 *
 * On those builds Electron makes a protected window WS_EX_LAYERED before setting
 * its display affinity, because WDA_EXCLUDEFROMCAPTURE alone does not keep it out
 * of captures there (electron/electron#47834, worked around in #47856). The style
 * is latched: `UpdateAllowScreenshots` in electron_desktop_window_tree_host_win.cc
 * calls `SetLayered()`, and every later `setIgnoreMouseEvents(false)` puts
 * WS_EX_LAYERED back because `layered_` is set. The "hud-overlay-cursor" poll still
 * toggles input as it should, and Windows passes every click to the desktop
 * underneath. Confirmed on Windows 10 22H2 (19045) / Electron 41.2.1: clickable
 * with OPENSCREEN_DISABLE_CONTENT_PROTECTION=1, never without.
 *
 * Same threshold as Electron's `base::win::GetVersion() < WIN11_22H2`, read from the
 * same place: on Windows getSystemVersion() is Chromium's OSInfo version number
 * ("10.0.19045"), the one GetVersion() maps, and 22H2 starts at build 22621.
 *
 * Only for the HUD, the transparent click-through window. The Notes window is
 * opaque and never click-through, nothing says it is affected, and dropping its
 * protection would put the user's notes in recordings on no evidence.
 */
const CONTENT_PROTECTION_BREAKS_CLICK_THROUGH = (() => {
	if (process.platform !== "win32") return false;
	const build = Number.parseInt(process.getSystemVersion().split(".")[2] ?? "", 10);
	return Number.isFinite(build) && build < 22621;
})();

function applyContentProtection(win: BrowserWindow, label: string, { clickThrough = false } = {}) {
	if (CONTENT_PROTECTION_DISABLED) {
		console.warn(
			`[content-protection] OFF for the ${label} window ` +
				"(OPENSCREEN_DISABLE_CONTENT_PROTECTION=1) — it will appear in screen captures, " +
				"including recordings. Unset it for anything but automated testing.",
		);
		return;
	}
	if (CONTENT_PROTECTION_BREAKS_DISPLAY && !CONTENT_PROTECTION_FORCED) {
		console.warn(
			`[content-protection] OFF for the ${label} window — macOS ` +
				`${process.getSystemVersion()} never displays a content-protected window, so ` +
				"enabling it would make this window permanently invisible. It may therefore appear " +
				"in screen captures. Set OPENSCREEN_FORCE_CONTENT_PROTECTION=1 to re-test.",
		);
		return;
	}
	if (clickThrough && CONTENT_PROTECTION_BREAKS_CLICK_THROUGH && !CONTENT_PROTECTION_FORCED) {
		console.warn(
			`[content-protection] OFF for the ${label} window — Windows ` +
				`${process.getSystemVersion()} (before 11 22H2) never lets a content-protected ` +
				"click-through window take a click. It will therefore appear in screen captures, " +
				"including recordings. Set OPENSCREEN_FORCE_CONTENT_PROTECTION=1 to re-test.",
		);
		return;
	}
	win.setContentProtection(true);
}

// Asset base URL for renderer (wallpapers, etc.). Packaged: extraResources copies
// public/wallpapers to resources/wallpapers. Unpackaged: <appRoot>/public/.
const ASSET_BASE_DIR = process.defaultApp
	? path.join(__dirname, "..", "public")
	: process.resourcesPath;
export const ASSET_BASE_URL_ARG = `--asset-base-url=${pathToFileURL(`${ASSET_BASE_DIR}${path.sep}`).toString()}`;

/**
 * For the HUD bar and its panel: the compositor draws their windows' frame, with the desktop's
 * own border and corner rounding, so they render square inside it (LaunchWindow.module.css).
 * Hyprland does that to every window, frameless or not. Other desktops draw nothing around a
 * frameless window, so there the bar keeps its own rounded shape.
 */
const HUD_WINDOW_ARGUMENTS = [
	ASSET_BASE_URL_ARG,
	...(runsUnderHyprland(process.env) ? [HUD_FRAMED_BY_COMPOSITOR_ARG] : []),
];

let hudOverlayWindow: BrowserWindow | null = null;

// The HUD's size in DIP, as last given: at creation, then by "hud-overlay-set-size".
// Every move re-applies this size, never one read back from the window, because the
// read-back drifts: on Windows, getBounds() converts the physical rect to DIP by
// enclosing it (rounding outwards) and setBounds() converts back the same way, so under
// fractional scaling each read-modify-write grows the window by a pixel or two. At 125 %
// a drag grew it on every step, sliding the bar off the pointer and under the taskbar
// (#1004). setPosition() is no way out: Electron implements it as setBounds() with the
// size from getBounds().
let hudWindowSize = { width: 0, height: 0 };
/** Whether the HUD's renderer has reported the bar's size yet, and who is waiting for it; see
 *  the HUD's ready-to-show. */
let hudBarSizeKnown = false;
let hudSizeReported: (() => void) | null = null;

/** The HUD's position, with its own size instead of the drifting read-back. */
function hudBounds(win: BrowserWindow): Electron.Rectangle {
	const [x, y] = win.getPosition();
	return { x, y, ...hudWindowSize };
}

// Origin the current drag gesture started from. The renderer sends the pointer's
// *total* travel since pointerdown rather than per-frame deltas, so every move is
// an absolute `origin + delta` — no rounding to accumulate, and a dropped message
// self-corrects on the next one instead of leaving the window permanently offset.
let hudDragOrigin: { x: number; y: number } | null = null;

// The visible stack's rect inside the window (the bar plus anything open above it), as
// last measured by the renderer. Everything that positions the HUD clamps this rect —
// not the window — into the work area, because the window around it is transparent
// reserve that may overhang any edge (see hudWindowBounds.ts). Null until the
// renderer's first measurement.
let hudContentRect: HudContentRect | null = null;

// Where the user left the bar: its bottom-centre on screen, set by a drag and by the first
// resize. A re-clamp places the bar from here, never from where the window was last pushed:
// a popover opening near the top of the screen pushes the window down so the popover fits,
// and starting from the pushed window left the bar there once the popover closed, a little
// further down with each popover (#1136). Null until the first resize.
let hudBarHome: { x: number; y: number } | null = null;

// Linux never makes the HUD click-through (setHudMouseEventsEnabled in LaunchWindow), so
// an overhanging reserve would swallow clicks on the panels and docks under it. There the
// content rect is ignored and the whole window stays inside the work area.
const HUD_CLAMPS_CONTENT = process.platform !== "linux";

/** Work area of the display the bar is on (or heading for), not the window. */
function hudWorkAreaFor(bounds: Electron.Rectangle): Electron.Rectangle {
	const reference = hudContentRect ? hudContentScreenRect(bounds, hudContentRect) : bounds;
	return screen.getDisplayMatching(reference).workArea;
}

// Re-clamps a HUD nobody is dragging: a drag owns the position frame by frame, and the
// renderer re-measures on release. Skipped while minimized, where moving the window is
// platform-defined; "restore" runs it instead.
function reclampHud() {
	const win = hudOverlayWindow;
	if (!win || win.isDestroyed() || win.isMinimized() || hudDragOrigin) return;

	const bounds = hudBounds(win);
	const workArea = hudWorkAreaFor(bounds);
	const next = hudBarHome
		? hudResizeBounds({
				bounds,
				previousContent: hudContentRect,
				anchor: hudBarHome,
				width: bounds.width,
				height: bounds.height,
				nextContent: hudContentRect,
				workArea,
			})
		: clampHudBoundsToWorkArea(bounds, hudContentRect, workArea);
	if (!sameRect(next, bounds)) {
		win.setBounds(next, false);
	}
}

// The work area can shrink under a HUD nobody is touching: the taskbar stops auto-hiding
// (or is revealed), the Dock moves, the resolution or the scale changes. A bar parked at
// the bottom edge would then be left sitting on the taskbar until the next drag — and the
// drag handle is under the taskbar. Re-clamp whenever the displays change, so the
// invariant the drag and resize paths both maintain holds without user input too.
let isWatchingHudWorkArea = false;
function watchHudWorkAreaChanges() {
	if (isWatchingHudWorkArea) return;
	isWatchingHudWorkArea = true;

	screen.on("display-metrics-changed", reclampHud);
	screen.on("display-added", reclampHud);
	screen.on("display-removed", reclampHud);
}

// Linux hides the bar instead of minimizing it, because a Wayland client cannot bring a
// minimized window back. xdg-shell has set_minimized and no request to undo it, and
// Chromium's Wayland Show() returns early on a toplevel that still exists, so the tray's
// restore() and show() did nothing; focus() then asked for activation without a fresh token,
// which GNOME turns into an "is ready" notification while the bar stays minimized. hide()
// destroys the toplevel and show() maps a new one, which every compositor displays. The cost
// is the position: the compositor places the new toplevel itself. X11 takes the same path:
// there `skipTaskbar` already left a minimized HUD no taskbar entry, so the tray was its only
// way back anyway.
const HUD_HIDES_INSTEAD_OF_MINIMIZING = process.platform === "linux";

ipcMain.on("hud-overlay-hide", () => {
	if (hudOverlayWindow && !hudOverlayWindow.isDestroyed()) {
		if (HUD_HIDES_INSTEAD_OF_MINIMIZING) {
			hudOverlayWindow.hide();
		} else {
			hudOverlayWindow.minimize();
		}
	}
});

// The cursor, sampled here and pushed to the renderer, because while the HUD is
// click-through nothing else can tell it where the pointer is.
//
// Chromium delivers no pointer event of any kind to a window it has made
// input-transparent — including the pointermove the renderer needs to ask for input
// back. Electron's `{ forward: true }` covered that with a global WH_MOUSE_LL hook
// that re-posts WM_MOUSEMOVE, and that hook was the ONLY route out: its install is
// unchecked (SetWindowsHookEx's return value is discarded), latched behind Electron's
// `forwarding_mouse_messages_` so it re-arms only after a setIgnoreMouseEvents(false)
// the renderer can no longer request, and Windows silently revokes any low-level hook
// whose callback overruns LowLevelHooksTimeout — "there is no way for the application
// to know whether the hook is removed". One hook that never installs or quietly dies
// and the HUD is painted, inert, forever, with the tray icon as the only way to quit
// the app. That is issue #266, and issue #385 after it: #266 was closed by moving
// *when* the hook is installed, which left the trapdoor exactly where it was.
//
// So the escape no longer runs on anything Windows can take away. getCursorScreenPoint
// is a plain positional read the main process can always make, the poll exists only
// while the window is click-through — the state it is there to escape — and the
// renderer re-derives the answer from scratch on every tick, so no dropped message,
// dead hook or stale flag can strand it.
const HUD_CURSOR_POLL_MS = 32;
let hudCursorPoll: ReturnType<typeof setInterval> | null = null;
let hudLastPoint: { x: number; y: number } | null = null;

function stopHudCursorPoll() {
	if (hudCursorPoll) clearInterval(hudCursorPoll);
	hudCursorPoll = null;
	hudLastPoint = null;
}

function pollHudCursor() {
	const win = hudOverlayWindow;
	if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return;

	// getBounds() and getCursorScreenPoint() are both in DIP, and so is a renderer CSS
	// pixel (the HUD is frameless, so the client area is the whole window).
	const bounds = win.getBounds();
	const cursor = screen.getCursorScreenPoint();
	const x = cursor.x - bounds.x;
	const y = cursor.y - bounds.y;
	if (x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) return;

	// Deduped on the WINDOW-RELATIVE point, not the cursor: "hud-overlay-set-size"
	// re-anchors the window on every content change, so the bar can arrive under a
	// cursor that never moved — and that changes the answer just as much.
	if (hudLastPoint && hudLastPoint.x === x && hudLastPoint.y === y) return;
	hudLastPoint = { x, y };

	win.webContents.send("hud-overlay-cursor", x, y);
}

ipcMain.on("hud-overlay-ignore-mouse-events", (_event, ignore: boolean) => {
	if (!hudOverlayWindow || hudOverlayWindow.isDestroyed()) {
		return;
	}

	// No `forward`: the poll above replaces it, and leaving it on would keep the app
	// depending on a hook it cannot check for a transition it no longer needs.
	hudOverlayWindow.setIgnoreMouseEvents(ignore);
	// The pointer crossing the bar is the one thing that follows every popover and dialog
	// closing, whatever took the HUD's topmost bit with it (see keepOnTop.ts).
	reassertAlwaysOnTop(hudOverlayWindow);

	if (!ignore) {
		// Input is live again; the document's own pointer events are cheaper and
		// finer-grained than anything sampled at 32 ms.
		stopHudCursorPoll();
		return;
	}
	if (!hudCursorPoll) {
		hudCursorPoll = setInterval(pollHudCursor, HUD_CURSOR_POLL_MS);
	}
});

ipcMain.on("hud-overlay-drag-start", () => {
	if (!hudOverlayWindow || hudOverlayWindow.isDestroyed()) {
		return;
	}

	// Under Wayland this origin is a lie: Electron documents getPosition() as returning
	// [0, 0] there, because the protocol prohibits a client from introspecting or
	// setting its own global coordinates. The origin+delta scheme below therefore
	// resolves against 0 rather than the window's real position, and the position
	// setBounds() asks for is ignored — so dragging cannot work on Wayland by this
	// route at all. The finiteness check only keeps a garbage origin from reaching a
	// native setter.
	const [x, y] = hudOverlayWindow.getPosition();
	hudDragOrigin = Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
});

ipcMain.on("hud-overlay-drag-to", (_event, deltaX: number, deltaY: number) => {
	if (
		!hudOverlayWindow ||
		hudOverlayWindow.isDestroyed() ||
		!hudDragOrigin ||
		!Number.isFinite(deltaX) ||
		!Number.isFinite(deltaY)
	) {
		return;
	}

	// Clamp the *bar* into the work area of the display the drag is heading for —
	// resolved from the destination, not from where the window currently sits, so a
	// drag towards a second display follows the pointer instead of stopping at the
	// edge it started on. The window itself may overhang: everything in it except
	// the bar is transparent reserve (see hudWindowBounds.ts), and clamping the
	// window instead would hand the bar the reserve's width and ~600px of height as
	// a margin it can never cross — the "stuck at the bottom of the screen" trap.
	const bounds = hudBounds(hudOverlayWindow);
	const destination = hudDragDestination({ bounds, origin: hudDragOrigin, deltaX, deltaY });

	const next = clampHudBoundsToWorkArea(destination, hudContentRect, hudWorkAreaFor(destination));

	// setBounds with the HUD's own size, not setPosition, which re-applies the size read
	// back from the window and grows it every frame under fractional scaling.
	hudOverlayWindow.setBounds(next, false);
	hudBarHome = hudBarAnchor(next, hudContentRect);
});

ipcMain.on("hud-overlay-drag-end", () => {
	hudDragOrigin = null;
});

// Resize the HUD to fit its rendered content. The renderer also sends the bar's
// rect inside the requested size (the stack layout is deterministic: centred,
// pinned HUD_BAR_BOTTOM above the window's bottom edge), and every positioning
// decision below is made on that rect rather than on the window — anchored on
// the bar's bottom-centre so a horizontal↔vertical flip resizes the window
// around the bar instead of moving it, and clamped so the bar cannot end up off
// screen. The window around it may overhang; the reserve is invisible.
//
// Applied in one shot rather than tweened. The renderer now reserves space for
// everything that can float above the bar, so a resize only ever accompanies a
// discrete content change (orientation flip, recording controls appearing) that
// snaps anyway — tweening the window across 10 frames just meant 10 frames of the
// bar sitting at an offset that didn't match the content it was drawn with.
ipcMain.on("hud-overlay-set-size", (_event, width: number, height: number, content: unknown) => {
	// An empty size is refused too: it would be stored as the HUD's own size and re-applied by
	// every later move.
	if (
		!hudOverlayWindow ||
		hudOverlayWindow.isDestroyed() ||
		!Number.isFinite(width) ||
		!Number.isFinite(height) ||
		width <= 0 ||
		height <= 0
	) {
		return;
	}

	// A resize re-anchors from the window's current bounds, which would fight the
	// position an in-flight drag is applying. The renderer re-measures on release,
	// which re-sends the rect that matched the size actually in force.
	if (hudDragOrigin) {
		return;
	}

	const bounds = hudBounds(hudOverlayWindow);
	const nextContent = HUD_CLAMPS_CONTENT ? parseHudContentRect(content) : null;
	hudBarHome ??= hudBarAnchor(bounds, hudContentRect);
	const next = hudResizeBounds({
		bounds,
		previousContent: hudContentRect,
		anchor: hudBarHome,
		width,
		height,
		nextContent,
		workArea: hudWorkAreaFor(bounds),
	});
	// A malformed rect must not clobber the last good one: the stored rect is
	// what every later positioning decision clamps by.
	if (nextContent) {
		hudContentRect = nextContent;
	}
	hudWindowSize = { width: next.width, height: next.height };
	hudBarSizeKnown = true;
	hudSizeReported?.();
	hudSizeReported = null;

	if (!sameRect(next, bounds)) {
		hudOverlayWindow.setBounds(next, false);
		// Hyprland keeps the top-left of a resized window, which lifts the bar off the
		// bottom; the bounds asked for above are ignored there. The rule follows the new
		// size too, for the next time the bar is shown.
		placeHudBar();
		void presetHudBar();
	}
	reassertAlwaysOnTop(hudOverlayWindow);
});

// The visible stack changed without a resize: the bar grew into its reserve, or a
// popover or notice opened above it. Re-clamp so none of it is left off screen.
ipcMain.on("hud-overlay-content", (_event, content: unknown) => {
	const nextContent = HUD_CLAMPS_CONTENT ? parseHudContentRect(content) : null;
	if (!nextContent) return;
	hudContentRect = nextContent;
	reclampHud();
	if (hudOverlayWindow) reassertAlwaysOnTop(hudOverlayWindow);
});

/** Gap between the HUD window and the bottom of the work area. */
const HUD_BOTTOM_MARGIN = 5;
/**
 * On Hyprland, fixed, so a window rule can place the bar before it maps (presetHudBar). Only
 * there: elsewhere the window keeps the page's title, as it always has.
 */
const HUD_BAR_TITLE = "OpenScreen recording bar";
const HUD_BAR_TITLE_FIXED = runsUnderHyprland(process.env);
/** How long the first show waits on Hyprland for the bar to report its size. */
const HUD_FIRST_SIZE_TIMEOUT_MS = 1500;

/**
 * Frameless transparent HUD overlay, always-on-top, centred at the bottom of the
 * primary display. Follows the user across macOS Spaces so it isn't lost on switch.
 */
export function createHudOverlayWindow(): BrowserWindow {
	const primaryDisplay = screen.getPrimaryDisplay();
	const { workArea } = primaryDisplay;

	// Close to what the renderer asks for on its very first measurement (bar plus
	// the reserved space above it), so the HUD doesn't visibly resize itself the
	// instant it becomes visible. See src/components/launch/hudGeometry.ts.
	const windowWidth = 820;
	const windowHeight = 560;

	const x = Math.floor(workArea.x + (workArea.width - windowWidth) / 2);
	const y = Math.floor(workArea.y + workArea.height - windowHeight - HUD_BOTTOM_MARGIN);

	const win = new BrowserWindow({
		width: windowWidth,
		height: windowHeight,
		// Min/max are intentionally loose: the renderer resizes to fit content via
		// "hud-overlay-set-size" (above), needed for the vertical tray to grow taller.
		minWidth: HUD_WINDOW_MIN.width,
		minHeight: HUD_WINDOW_MIN.height,
		// The reserve may overhang the screen (hudWindowBounds.ts). Without this, macOS
		// re-constrains the frame below the menu bar whenever the window is re-ordered,
		// pulling a stack parked at the top down by the whole reserve.
		enableLargerThanScreen: true,
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
		alwaysOnTop: true,
		skipTaskbar: true,
		hasShadow: false,
		show: false, // shown via ready-to-show to avoid black rectangle flash
		...(HUD_BAR_TITLE_FIXED ? { title: HUD_BAR_TITLE } : {}),
		webPreferences: {
			preload: path.join(__dirname, "preload.mjs"),
			additionalArguments: HUD_WINDOW_ARGUMENTS,
			nodeIntegration: false,
			contextIsolation: true,
			backgroundThrottling: false,
		},
	});

	// Deliberately NOT born click-through: the renderer asks for it on mount, over
	// "hud-overlay-ignore-mouse-events" (`show: false` holds this window back until
	// ready-to-show, so the two are ~85 ms apart — measured, not assumed). What that
	// leaves open is an invisible rectangle that can swallow one desktop click in
	// those 85 ms, right after the user launched the app — against what doing it here
	// cost them: the whole app (issue #266). A window nothing ever asks for — a
	// renderer that dies before mount — then stays clickable instead of becoming a
	// ghost. See the "hud-overlay-cursor" poll above for the way back out.

	// Keep the recording controls out of the recording (see applyContentProtection).
	applyContentProtection(win, "HUD", { clickThrough: true });

	// Follow the user across macOS Spaces, else the HUD stays pinned to the Space
	// it was first opened on.
	followAcrossSpaces(win);
	keepAlwaysOnTop(win);

	// Show only once painted to avoid the black rectangle flash when a transparent
	// window is shown before its first paint.
	if (HUD_BAR_TITLE_FIXED) {
		// The page's <title> would replace it, and the title is what the bar's rule matches.
		win.on("page-title-updated", (event) => event.preventDefault());
	}
	hudBarSizeKnown = false;
	win.once("ready-to-show", () => {
		applyContentProtection(win, "HUD", { clickThrough: true });
		if (HEADLESS) return;
		// Placed before it maps, or Hyprland shows it mid-screen and it is seen moving down.
		void barSizeKnown()
			.then(presetHudBar)
			.finally(() => {
				if (!win.isDestroyed()) win.show();
			});
	});

	win.webContents.on("did-finish-load", () => {
		win?.webContents.send("main-process-message", new Date().toLocaleString());
	});

	hudOverlayWindow = win;
	hudWindowSize = { width: windowWidth, height: windowHeight };
	watchHudWorkAreaChanges();
	// Display changes while minimized were skipped; catch up on the way back.
	win.on("restore", reclampHud);

	win.on("closed", () => {
		if (hudOverlayWindow === win) {
			hudOverlayWindow = null;
			hudDragOrigin = null;
			// The next HUD is a new window: a rect measured in this one would misplace it.
			hudContentRect = null;
			hudBarHome = null;
			stopHudCursorPoll();
			closeHudPanelWindow();
		}
	});
	// The panel belongs to the bar: hidden with it, and its popovers closed when focus
	// leaves the pair (see checkHudPanelFocus).
	win.on("hide", () => hudPanelWindow?.hide());
	// And back with it: a notice still in the state sends no new size report to bring it.
	win.on("show", () => {
		// On Linux a hide unmaps the window and show maps a new one, which Hyprland
		// centres again.
		placeHudBar();
		const panel = hudPanelWindow;
		if (panel && !panel.isDestroyed() && hudPanelState && hudPanelHasContent(hudPanelState)) {
			revealHudPanel(panel);
		}
	});
	win.on("blur", checkHudPanelFocus);

	if (VITE_DEV_SERVER_URL) {
		win.loadURL(VITE_DEV_SERVER_URL + "?windowType=hud-overlay");
	} else {
		win.loadFile(path.join(RENDERER_DIST, "index.html"), {
			query: { windowType: "hud-overlay" },
		});
	}

	markSheetless(win);
	return win;
}

// ---------------------------------------------------------------------------
// Linux: the HUD's floating surfaces in a window of their own.
//
// On Wayland the HUD cannot have a transparent reserve that lets clicks through, cannot
// place itself and cannot choose how it grows (src/components/launch/hudPanel.ts), so on
// Linux the HUD window is just the bar and the device settings, the language menu, the
// notices and the toasts are shown here instead. This window only renders a snapshot
// the HUD sends and relays what the user does back to it; the HUD owns all of it.
// ---------------------------------------------------------------------------

let hudPanelWindow: BrowserWindow | null = null;
/** The last snapshot from the HUD, replayed to a panel window once it has loaded. */
let hudPanelState: HudPanelState | null = null;
/** Gap between the bar and the panel, where the panel can be placed (X11, Hyprland). */
const HUD_PANEL_GAP = 8;
/** Fixed, so Hyprland's IPC can tell the panel from the bar (see placeHudPanelNearBar). */
const HUD_PANEL_TITLE = "OpenScreen panel";
let hudPanelPlacementTimer: ReturnType<typeof setTimeout> | null = null;
let hudPanelRevealTimer: ReturnType<typeof setTimeout> | null = null;
/** How long a panel about to show on Hyprland waits for its size to stop changing. */
const HUD_PANEL_SETTLE_MS = 80;

/**
 * On Hyprland, moves the panel next to the bar: the compositor centres it on the monitor,
 * which is where the bar starts too. Retried briefly, since a window that was just shown may
 * not be in the compositor's client list yet. Elsewhere this resolves false and does nothing.
 */
function placeHudPanel(attempt = 0) {
	if (hudPanelPlacementTimer) clearTimeout(hudPanelPlacementTimer);
	hudPanelPlacementTimer = setTimeout(async () => {
		hudPanelPlacementTimer = null;
		if (!hudPanelWindow || hudPanelWindow.isDestroyed() || !hudPanelWindow.isVisible()) return;
		const placed = await placeHudPanelNearBar({
			env: process.env,
			pid: process.pid,
			panelTitle: HUD_PANEL_TITLE,
			barSize: hudWindowSize,
			gap: HUD_PANEL_GAP,
		});
		if (!placed && attempt < 4 && process.env.HYPRLAND_INSTANCE_SIGNATURE) {
			placeHudPanel(attempt + 1);
		}
	}, 40);
}

let hudBarPlacementTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * On Hyprland, moves the bar to the bottom centre of its monitor, where every other platform
 * puts it: the compositor centres it instead, ignoring the position the window asked for.
 * Retried briefly, as a window just shown or resized may not be listed at its new size yet.
 * Then the panel follows the bar. Elsewhere this does nothing.
 */
function placeHudBar(attempt = 0) {
	if (!process.env.HYPRLAND_INSTANCE_SIGNATURE) return;
	if (hudBarPlacementTimer) clearTimeout(hudBarPlacementTimer);
	hudBarPlacementTimer = setTimeout(async () => {
		hudBarPlacementTimer = null;
		if (!hudOverlayWindow || hudOverlayWindow.isDestroyed() || !hudOverlayWindow.isVisible()) {
			return;
		}
		const placed = await placeHudBarAtBottom({
			env: process.env,
			pid: process.pid,
			panelTitle: HUD_PANEL_TITLE,
			barSize: hudWindowSize,
			margin: HUD_BOTTOM_MARGIN,
		});
		if (!placed && attempt < 4) {
			placeHudBar(attempt + 1);
			return;
		}
		if (placed) placeHudPanel();
	}, 40);
}

/**
 * Resolves once the bar's size is known, on Hyprland, where the rule that places the bar is set
 * for it. Painted is not measured: served by the dev server, the page is ready to show before it
 * has sized the window, which then mapped at its creation size, its top mid-screen, and was seen
 * shrinking and moving down. The bound starts here, at ready-to-show, not when the window was
 * created: a page that took longer than it to load used to find it already spent. Bounded, so a
 * report that never comes delays the bar rather than losing it.
 */
function barSizeKnown(): Promise<void> {
	if (!HUD_BAR_TITLE_FIXED || hudBarSizeKnown) return Promise.resolve();
	return new Promise<void>((resolve) => {
		hudSizeReported = resolve;
		setTimeout(resolve, HUD_FIRST_SIZE_TIMEOUT_MS);
	});
}

/**
 * On Hyprland, (re)sets the rule that maps the bar at the bottom centre at its current size, so
 * it opens there rather than mid-screen. Resolves at once elsewhere.
 */
function presetHudBar(): Promise<boolean> {
	if (!HUD_BAR_TITLE_FIXED) return Promise.resolve(false);
	return presetHudBarPlacement({
		env: process.env,
		pid: process.pid,
		barTitle: HUD_BAR_TITLE,
		panelTitle: HUD_PANEL_TITLE,
		barSize: hudWindowSize,
		margin: HUD_BOTTOM_MARGIN,
	});
}

function hudPanelHasPopover(state: HudPanelState | null): boolean {
	return Boolean(state && (state.deviceSettings || state.languageMenu));
}

function sendToHud(action: HudPanelAction) {
	if (hudOverlayWindow && !hudOverlayWindow.isDestroyed()) {
		hudOverlayWindow.webContents.send("hud-panel-action", action);
	}
}

/**
 * A popover closes when the user leaves it, which here means leaving BOTH windows: moving
 * from the bar into the panel blurs the bar, and that must not close what was just opened.
 * Checked a tick after the blur, once the focus has landed wherever it is going.
 */
function checkHudPanelFocus() {
	setTimeout(() => {
		if (!hudPanelHasPopover(hudPanelState)) return;
		const focused = BrowserWindow.getFocusedWindow();
		if (focused && (focused === hudOverlayWindow || focused === hudPanelWindow)) return;
		sendToHud({ kind: "close-popovers" });
	}, 50);
}

function closeHudPanelWindow() {
	hudPanelState = null;
	if (hudPanelWindow && !hudPanelWindow.isDestroyed()) hudPanelWindow.destroy();
	hudPanelWindow = null;
}

function createHudPanelWindow(): BrowserWindow {
	const win = new BrowserWindow({
		width: 380,
		height: 200,
		// The renderer reports its size before the first show (hud-panel-set-size).
		show: false,
		frame: false,
		resizable: false,
		alwaysOnTop: true,
		skipTaskbar: true,
		title: HUD_PANEL_TITLE,
		backgroundColor: "#0f1115",
		// No `parent`, deliberately: a compositor centres a child window over its parent,
		// and centred over the bar it covered the bar entirely (Hyprland, measured). Without
		// one it is placed like any new window, which most compositors keep clear of others.
		webPreferences: {
			preload: path.join(__dirname, "preload.mjs"),
			additionalArguments: HUD_WINDOW_ARGUMENTS,
			nodeIntegration: false,
			contextIsolation: true,
			backgroundThrottling: false,
		},
	});
	keepAlwaysOnTop(win);
	applyContentProtection(win, "HUD panel");
	// The page's <title> would replace it, and the title is how Hyprland's IPC finds the panel.
	win.on("page-title-updated", (event) => event.preventDefault());

	win.on("blur", checkHudPanelFocus);
	// Closed from outside (a compositor keybinding): nothing it showed is open any more.
	win.on("closed", () => {
		if (hudPanelWindow !== win) return;
		hudPanelWindow = null;
		if (hudPanelHasPopover(hudPanelState)) sendToHud({ kind: "close-popovers" });
	});

	if (VITE_DEV_SERVER_URL) {
		win.loadURL(VITE_DEV_SERVER_URL + "?windowType=hud-panel");
	} else {
		win.loadFile(path.join(RENDERER_DIST, "index.html"), {
			query: { windowType: "hud-panel" },
		});
	}
	return win;
}

ipcMain.on("hud-panel-state", (event, state: HudPanelState) => {
	if (!hudOverlayWindow || event.sender !== hudOverlayWindow.webContents) return;
	const popoverOpened = !hudPanelHasPopover(hudPanelState) && hudPanelHasPopover(state);
	hudPanelState = state;
	if (!hudPanelHasContent(state)) {
		if (hudPanelWindow && !hudPanelWindow.isDestroyed()) {
			// Sent, not just hidden: a hidden panel still renders its last snapshot, and the
			// device settings in it hold the camera preview and the microphone meter open.
			hudPanelWindow.webContents.send("hud-panel-state", state);
			hudPanelWindow.hide();
		}
		return;
	}
	if (!hudPanelWindow || hudPanelWindow.isDestroyed()) {
		hudPanelWindow = createHudPanelWindow();
		return;
	}
	hudPanelWindow.webContents.send("hud-panel-state", state);
	// A popover opening over a panel already showing notices or toasts takes the focus, as
	// it would on first show (hud-panel-set-size).
	if (popoverOpened && hudPanelWindow.isVisible()) hudPanelWindow.focus();
});

// The panel asks for the snapshot once it is listening, rather than being sent one on
// did-finish-load: the renderer mounts after its translations load, which is later than
// that, and a snapshot sent before the listener exists is lost.
ipcMain.on("hud-panel-ready", (event) => {
	const win = hudPanelWindow;
	if (!win || win.isDestroyed() || event.sender !== win.webContents || !hudPanelState) return;
	win.webContents.send("hud-panel-state", hudPanelState);
});

ipcMain.on("hud-panel-action", (event, action: HudPanelAction) => {
	if (!hudPanelWindow || event.sender !== hudPanelWindow.webContents) return;
	sendToHud(action);
});

/** Shows the panel and places it at the bar. A popover takes focus, so its keyboard handling
 * works straight away; a notice or a toast appearing must not pull focus away from whatever the
 * user is doing.
 *
 * On Hyprland a window rule places the panel first, or every show would map it mid-screen and
 * then jump it to the bar. The move after it maps stays, for a Hyprland the rule did not reach. */
function revealHudPanel(win: BrowserWindow, size?: { width: number; height: number }) {
	// The size just asked for, when there is one: an unmapped window reports its old size.
	const [width, height] = size ? [size.width, size.height] : win.getSize();
	void presetHudPanelPlacement({
		env: process.env,
		pid: process.pid,
		panelTitle: HUD_PANEL_TITLE,
		panelSize: { width, height },
		barSize: hudWindowSize,
		gap: HUD_PANEL_GAP,
	}).finally(() => {
		// The state can have moved on while Hyprland answered.
		const state = hudPanelState;
		if (win.isDestroyed() || win.isVisible() || !state || !hudPanelHasContent(state)) return;
		if (hudPanelHasPopover(state)) {
			win.show();
		} else {
			win.showInactive();
		}
		placeHudPanel();
	});
}

ipcMain.on("hud-panel-set-size", (event, width: number, height: number) => {
	const win = hudPanelWindow;
	if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
	if (!hudPanelState || !hudPanelHasContent(hudPanelState)) return;
	const size = { width: Math.ceil(width), height: Math.ceil(height) };
	const [currentWidth, currentHeight] = win.getContentSize();
	const resized = currentWidth !== size.width || currentHeight !== size.height;
	if (resized) {
		win.setContentSize(size.width, size.height);
	}
	// Above the bar where the platform honours a position (X11). Wayland ignores it and the
	// compositor places the window, which is the point of having one. Again on a resize: the
	// window grows from its top-left, so a taller panel would reach down over the bar.
	const hud = hudOverlayWindow;
	if (hud && !hud.isDestroyed() && (!win.isVisible() || resized)) {
		const bar = hud.getBounds();
		const workArea = screen.getDisplayMatching(bar).workArea;
		const x = Math.round(bar.x + (bar.width - size.width) / 2);
		const y = bar.y - size.height - HUD_PANEL_GAP;
		win.setPosition(
			Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - size.width),
			Math.max(y, workArea.y),
		);
	}
	if (!win.isVisible()) {
		// On Hyprland the panel is placed for the size it maps at (revealHudPanel), and content
		// still loading reports a second, taller size moments later — the device list, for one —
		// which then moved the panel in plain sight. So it waits for the size to settle first.
		if (hudPanelRevealTimer) clearTimeout(hudPanelRevealTimer);
		if (!process.env.HYPRLAND_INSTANCE_SIGNATURE) {
			revealHudPanel(win, size);
			return;
		}
		hudPanelRevealTimer = setTimeout(() => {
			hudPanelRevealTimer = null;
			if (!win.isDestroyed()) revealHudPanel(win, size);
		}, HUD_PANEL_SETTLE_MS);
	} else if (resized) {
		// Hyprland keeps a resized floating window centred where it was, off the bar's edge.
		placeHudPanel();
	}
});

/**
 * Main editor window. Starts maximised with a hidden title bar on macOS; not
 * always-on-top and appears in the taskbar/dock.
 *
 * `query` overrides the renderer's routing params. The export bench passes
 * windowType=bench so it runs under THIS window's webPreferences — same
 * preload, same sandbox, same backgroundThrottling:false — because a bench that
 * configures its own window measures a different app than the one we ship.
 */
export function createEditorWindow(query: Record<string, string> = {}): BrowserWindow {
	const isMac = process.platform === "darwin";
	const wayland = usesWaylandBackend(process.platform, app.commandLine, process.env);
	const persist = shouldTrackEditorWindow(query);
	const loaded = persist ? loadEditorWindowState(app.getPath("userData")) : null;
	const saved = loaded
		? {
				...fitEditorRect(loaded, screen.getDisplayMatching(loaded).workArea, wayland),
				maximized: loaded.maximized,
			}
		: null;
	const creation = resolveEditorCreation({
		isBench: query.windowType === "bench",
		saved,
		wayland,
	});

	const win = new BrowserWindow({
		...creation.bounds,
		minWidth: 800,
		minHeight: 600,
		// Seamless titlebar on every platform: the app's own topbar IS the titlebar
		// (it already carries the logo, the title and a drag region). macOS keeps its
		// traffic lights, Windows/Linux get the native Window Controls Overlay — which
		// preserves Snap Layouts and the system close/maximise semantics instead of
		// re-implementing them as HTML buttons. Its colours follow the app theme via
		// the "set-titlebar-overlay" IPC (see handlers.ts).
		titleBarStyle: "hidden",
		...(isMac
			? { trafficLightPosition: { x: 18, y: 21 } }
			: // Windows fixes the width of its caption buttons (46px) and leaves us the height: at
				// 46px each hover area is a square in the top-right corner, as in Chrome or Explorer,
				// instead of a 58px-tall slab, and the top bar's bottom rule runs on under it.
				// Native, so Snap Layouts stays on the maximise button.
				{ titleBarOverlay: { color: "#09090b", symbolColor: "#a1a1aa", height: 46 } }),
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
			// Media track lists: the preview's hidden <video> and <audio> deselect their video
			// track, so Chromium stops decoding pictures the native compositor already draws
			// (`dropVideoTrack` in VirtualPreview.tsx).
			enableBlinkFeatures: "AudioVideoTracks",
		},
	});

	const inNormalState = () => !win.isMaximized() && !win.isMinimized() && !win.isFullScreen();
	// Under Wayland, Electron 41's getNormalBounds() is wrong while the window is maximized: it
	// takes the restored widget bounds, which carry the client-side shadow, and subtracts the
	// *maximized* frame insets (none) instead of the restored ones. Each close while maximized
	// so wrote the normal rect back 30×41 px larger and 15×10 px up-left — on GNOME 46,
	// {271,0,1410,1080} came back as {256,-10,1440,1121}. getBounds() read in the normal state
	// is exact, so the last such reading is what gets saved there. The window is still in its
	// normal state here, before any maximize.
	let lastNormalBounds = win.getBounds();
	const trackNormalBounds = () => {
		if (!win.isDestroyed() && inNormalState()) lastNormalBounds = win.getBounds();
	};

	// Under Wayland the maximize waits until the compositor has mapped and focused the window,
	// or it sticks (WAYLAND_MAXIMIZE_SETTLE_MS). Until then the window still counts as
	// maximized for the saved state, so closing it early does not forget the choice.
	let maximizePending = creation.maximize && creation.deferMaximize;
	if (maximizePending) {
		win.once("maximize", () => {
			maximizePending = false;
		});
		win.once("focus", () => {
			setTimeout(() => {
				if (!maximizePending || win.isDestroyed()) return;
				maximizePending = false;
				if (inNormalState()) win.maximize();
			}, WAYLAND_MAXIMIZE_SETTLE_MS);
		});
	} else if (creation.maximize) {
		win.maximize();
	}

	if (creation.persist) {
		// `resized` and `moved` never fire on Linux; `resize` does, mid-drag included.
		if (wayland) win.on("resize", trackNormalBounds);
		const persistState = () => {
			if (win.isDestroyed()) return;
			if (wayland) trackNormalBounds();
			const rect = wayland ? lastNormalBounds : win.getNormalBounds();
			const bounds = fitEditorRect(rect, screen.getDisplayMatching(rect).workArea, wayland);
			saveEditorWindowState(app.getPath("userData"), {
				x: bounds.x,
				y: bounds.y,
				width: bounds.width,
				height: bounds.height,
				maximized: win.isMaximized() || maximizePending,
			});
		};
		win.on("moved", persistState);
		win.on("resized", persistState);
		win.on("close", persistState);
	}

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
		// `--titlebar-inset-left` reserves room for the macOS traffic lights; on
		// Windows/Linux the topbar uses the `titlebar-area-*` env vars instead.
		win.webContents
			.insertCSS(
				`html, body, #root { background: #09090b !important; }
				 :root { --titlebar-inset-left: ${isMac ? "68px" : "0px"}; }`,
			)
			.catch(() => {
				// Best-effort cosmetic; ignore if the page is mid-teardown.
			});
	});

	win.webContents.on("did-finish-load", () => {
		win?.webContents.send("main-process-message", new Date().toLocaleString());
	});

	const routing = { windowType: "editor", ...query };
	if (VITE_DEV_SERVER_URL) {
		win.loadURL(`${VITE_DEV_SERVER_URL}?${new URLSearchParams(routing).toString()}`);
	} else {
		win.loadFile(path.join(RENDERER_DIST, "index.html"), { query: routing });
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
		width: 680,
		height: 580,
		minHeight: 420,
		maxHeight: 680,
		x: Math.round((width - 680) / 2),
		y: Math.round((height - 580) / 2),
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
	followAcrossSpaces(win);
	keepAlwaysOnTop(win);
	// The picker may close with another app in front, which gives the HUD no event of its own.
	win.on("closed", () => {
		if (hudOverlayWindow) reassertAlwaysOnTop(hudOverlayWindow);
	});

	if (VITE_DEV_SERVER_URL) {
		win.loadURL(VITE_DEV_SERVER_URL + "?windowType=source-selector");
	} else {
		win.loadFile(path.join(RENDERER_DIST, "index.html"), {
			query: { windowType: "source-selector" },
		});
	}

	markSheetless(win);
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

	followAcrossSpaces(win);
	keepAlwaysOnTop(win);

	if (VITE_DEV_SERVER_URL) {
		win.loadURL(VITE_DEV_SERVER_URL + "?windowType=countdown-overlay");
	} else {
		win.loadFile(path.join(RENDERER_DIST, "index.html"), {
			query: { windowType: "countdown-overlay" },
		});
	}

	markSheetless(win);
	return win;
}

/**
 * The macOS permissions window: first run, the app menu, and wherever a missing permission
 * would otherwise stop a recording. An ordinary opaque window on purpose -- it has to sit
 * beside System Settings and macOS' own prompts, not float above them like the HUD.
 */
export function createPermissionsWindow(): BrowserWindow {
	const win = new BrowserWindow({
		width: 520,
		height: 640,
		resizable: false,
		minimizable: false,
		maximizable: false,
		fullscreenable: false,
		title: "OpenScreen",
		backgroundColor: "#0b0c0f",
		show: false,
		webPreferences: {
			preload: path.join(__dirname, "preload.mjs"),
			additionalArguments: [ASSET_BASE_URL_ARG],
			nodeIntegration: false,
			contextIsolation: true,
		},
	});

	win.once("ready-to-show", () => {
		if (!HEADLESS) {
			win.show();
		}
	});

	if (VITE_DEV_SERVER_URL) {
		win.loadURL(VITE_DEV_SERVER_URL + "?windowType=permissions");
	} else {
		win.loadFile(path.join(RENDERER_DIST, "index.html"), {
			query: { windowType: "permissions" },
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
	keepAlwaysOnTop(win);

	applyContentProtection(win, "Notes");
	win.once("ready-to-show", () => {
		applyContentProtection(win, "Notes");
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

/** A hidden window running one of the CLI runners (src/cli/): `openscreen <command>`, or a
 *  media tool of an MCP server. */
export function createRunnerWindow(windowType: string): BrowserWindow {
	const win = new BrowserWindow({
		width: 1280,
		height: 720,
		show: false,
		webPreferences: {
			preload: path.join(__dirname, "preload.mjs"),
			additionalArguments: [ASSET_BASE_URL_ARG],
			nodeIntegration: false,
			contextIsolation: true,
			// Same relaxation as the editor window: exporters load recording media
			// via file:// URLs.
			webSecurity: false,
			backgroundThrottling: false,
		},
	});

	if (VITE_DEV_SERVER_URL) {
		win.loadURL(`${VITE_DEV_SERVER_URL}?windowType=${windowType}`);
	} else {
		win.loadFile(path.join(RENDERER_DIST, "index.html"), { query: { windowType } });
	}
	return win;
}
