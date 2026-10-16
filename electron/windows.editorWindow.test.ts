import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WAYLAND_MAXIMIZE_SETTLE_MS } from "./editorWindowState";

const electron = vi.hoisted(() => {
	type Rect = { x: number; y: number; width: number; height: number };
	type Insets = { top: number; left: number; bottom: number; right: number };
	const NONE: Insets = { top: 0, left: 0, bottom: 0, right: 0 };
	const outset = (r: Rect, i: Insets): Rect => ({
		x: r.x - i.left,
		y: r.y - i.top,
		width: r.width + i.left + i.right,
		height: r.height + i.top + i.bottom,
	});
	const inset = (r: Rect, i: Insets): Rect =>
		outset(r, {
			top: -i.top,
			left: -i.left,
			bottom: -i.bottom,
			right: -i.right,
		});

	const state = {
		// The output as Chromium reports it under Wayland: the whole 1920x1080, panels included.
		workArea: { x: 0, y: 0, width: 1920, height: 1080 },
		userData: "",
		ozonePlatform: "",
		// Electron 41's client-side frame under Wayland (OpaqueFrameView, LinuxCSDCustomFrameLayout):
		// shadow and resize band while restored, a 1 px edge while maximized. NONE elsewhere.
		restoredInsets: NONE,
		maximizedInsets: NONE,
		windows: [] as FakeWindow[],
	};

	/**
	 * A BrowserWindow reduced to the bounds arithmetic of shell/browser/native_window_views.cc:
	 * the widget rect carries the frame insets, getBounds() takes the current ones back off, and
	 * getNormalBounds() takes the *current* ones off the restored widget rect — which is the
	 * Electron 41 bug under Wayland, since the restored rect carries the restored insets.
	 */
	class FakeWindow {
		options: Partial<Rect>;
		widget: Rect;
		restoredWidget: Rect | null = null;
		maximized = false;
		destroyed = false;
		maximize = vi.fn(() => {
			if (this.maximized) return;
			this.restoredWidget = this.widget;
			this.maximized = true;
			this.widget = { ...state.workArea };
			this.emit("maximize");
			this.emit("resize");
		});
		webContents = { on: vi.fn(), send: vi.fn(), insertCSS: vi.fn(async () => undefined) };
		setAutoHideMenuBar = vi.fn();
		loadURL = vi.fn();
		loadFile = vi.fn();
		private listeners = new Map<string, { fn: () => void; once: boolean }[]>();

		constructor(options: Partial<Rect> & { width: number; height: number }) {
			this.options = options;
			const { width, height } = options;
			// widget()->CenterWindow() when no position is given.
			const x = options.x ?? state.workArea.x + Math.floor((state.workArea.width - width) / 2);
			const y = options.y ?? state.workArea.y + Math.floor((state.workArea.height - height) / 2);
			this.widget = outset({ x, y, width, height }, state.restoredInsets);
			state.windows.push(this);
		}
		on(event: string, fn: () => void) {
			this.listeners.set(event, [...(this.listeners.get(event) ?? []), { fn, once: false }]);
			return this;
		}
		once(event: string, fn: () => void) {
			this.listeners.set(event, [...(this.listeners.get(event) ?? []), { fn, once: true }]);
			return this;
		}
		emit(event: string) {
			const list = this.listeners.get(event) ?? [];
			this.listeners.set(
				event,
				list.filter((l) => !l.once),
			);
			for (const l of list) l.fn();
		}
		private insets() {
			return this.maximized ? state.maximizedInsets : state.restoredInsets;
		}
		getBounds() {
			return this.maximized ? { ...this.widget } : inset(this.widget, this.insets());
		}
		getNormalBounds() {
			return inset(this.restoredWidget ?? this.widget, this.insets());
		}
		unmaximize() {
			if (!this.maximized || !this.restoredWidget) return;
			this.widget = this.restoredWidget;
			this.restoredWidget = null;
			this.maximized = false;
			this.emit("unmaximize");
			this.emit("resize");
		}
		/** A resize by the user, in logical (shadow-free) size. */
		resizeTo(width: number, height: number) {
			const { x, y } = this.getBounds();
			this.widget = outset({ x, y, width, height }, this.insets());
			this.emit("resize");
		}
		close() {
			this.emit("close");
			this.destroyed = true;
		}
		isMaximized() {
			return this.maximized;
		}
		isMinimized() {
			return false;
		}
		isFullScreen() {
			return false;
		}
		isDestroyed() {
			return this.destroyed;
		}
	}

	return { state, FakeWindow, NONE };
});

vi.mock("electron", () => ({
	app: {
		getPath: () => electron.state.userData,
		commandLine: { getSwitchValue: () => electron.state.ozonePlatform },
	},
	BrowserWindow: electron.FakeWindow,
	ipcMain: { on: vi.fn() },
	screen: {
		getDisplayMatching: () => ({ workArea: electron.state.workArea }),
		getPrimaryDisplay: () => ({ workArea: electron.state.workArea }),
		on: vi.fn(),
	},
}));

const REAL_PLATFORM = process.platform;

/** windows.ts reads the platform and the OS version (an Electron-only API) at import. */
async function load(platform: NodeJS.Platform) {
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
	Object.defineProperty(process, "getSystemVersion", {
		value: () => "10.0.26100",
		configurable: true,
	});
	vi.resetModules();
	return import("./windows");
}

function stateFile() {
	return path.join(electron.state.userData, "editor-window.json");
}

function saved() {
	return JSON.parse(readFileSync(stateFile(), "utf8"));
}

function openEditor(createEditorWindow: () => unknown) {
	createEditorWindow();
	const win = electron.state.windows.at(-1);
	if (!win) throw new Error("no window was created");
	return win;
}

beforeEach(() => {
	vi.useFakeTimers();
	electron.state.userData = mkdtempSync(path.join(os.tmpdir(), "os-editor-window-"));
	electron.state.windows = [];
	electron.state.ozonePlatform = "";
});

afterEach(() => {
	rmSync(electron.state.userData, { recursive: true, force: true });
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

afterAll(() => {
	Object.defineProperty(process, "platform", { value: REAL_PLATFORM, configurable: true });
	Reflect.deleteProperty(process, "getSystemVersion");
});

describe("editor window under Wayland (GNOME 46, Electron 41)", () => {
	beforeEach(() => {
		vi.stubEnv("XDG_SESSION_TYPE", "wayland");
		electron.state.restoredInsets = { top: 10, left: 16, bottom: 32, right: 16 };
		electron.state.maximizedInsets = { top: 0, left: 1, bottom: 1, right: 1 };
	});

	it("models Electron 41 as measured: read back while maximized, the normal rect grows", () => {
		// rc.1 clamped the saved {271,24,1410,1087} to {271,0,1410,1080}, opened it maximized and
		// wrote {256,-10,1440,1121} on close.
		const win = new electron.FakeWindow({ x: 271, y: 0, width: 1410, height: 1080 });
		win.maximize();
		expect(win.getNormalBounds()).toEqual({ x: 256, y: -10, width: 1440, height: 1121 });
	});

	it("maximizes only once the compositor has focused the window and settled", async () => {
		const { createEditorWindow } = await load("linux");
		const win = openEditor(createEditorWindow);
		expect(win.maximize).not.toHaveBeenCalled();

		win.emit("focus");
		vi.advanceTimersByTime(WAYLAND_MAXIMIZE_SETTLE_MS - 1);
		expect(win.maximize).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(win.maximize).toHaveBeenCalledTimes(1);
	});

	it("saves the normal bounds it opened with after a maximized session, every session", async () => {
		const { createEditorWindow } = await load("linux");
		// The file the rc.1 pass started from.
		writeFileSync(
			stateFile(),
			JSON.stringify({ x: 271, y: 24, width: 1410, height: 1087, maximized: true }),
		);

		const sessions = [];
		for (let i = 0; i < 3; i++) {
			const win = openEditor(createEditorWindow);
			win.emit("focus");
			vi.advanceTimersByTime(WAYLAND_MAXIMIZE_SETTLE_MS);
			expect(win.isMaximized()).toBe(true);
			win.close();
			sessions.push(saved());
		}

		// Placement is the compositor's: no position is handed to the window.
		const first = electron.state.windows[0];
		expect(first?.options.x).toBeUndefined();
		expect(first?.options.y).toBeUndefined();
		// Fits the share of the output the panels leave free, and no longer grows.
		expect(sessions[0]).toEqual({ x: 255, y: 54, width: 1410, height: 972, maximized: true });
		expect(sessions[1]).toEqual(sessions[0]);
		expect(sessions[2]).toEqual(sessions[0]);
	});

	it("saves the size the user restored to, not the shadowed one Electron reports", async () => {
		const { createEditorWindow } = await load("linux");
		const win = openEditor(createEditorWindow);
		win.emit("focus");
		vi.advanceTimersByTime(WAYLAND_MAXIMIZE_SETTLE_MS);

		win.unmaximize();
		win.resizeTo(1300, 900);
		win.maximize();
		win.close();

		expect(saved()).toMatchObject({ width: 1300, height: 900, maximized: true });
	});

	it("records an un-maximized close as such", async () => {
		const { createEditorWindow } = await load("linux");
		const win = openEditor(createEditorWindow);
		win.emit("focus");
		vi.advanceTimersByTime(WAYLAND_MAXIMIZE_SETTLE_MS);

		win.unmaximize();
		win.close();

		expect(saved()).toEqual({ x: 360, y: 140, width: 1200, height: 800, maximized: false });
	});

	it("still records maximized when closed before the deferred maximize", async () => {
		const { createEditorWindow } = await load("linux");
		const win = openEditor(createEditorWindow);
		win.close();
		vi.runAllTimers();

		expect(win.maximize).not.toHaveBeenCalled();
		expect(saved().maximized).toBe(true);
	});

	it("does not fight a maximize the user made first", async () => {
		const { createEditorWindow } = await load("linux");
		const win = openEditor(createEditorWindow);
		win.emit("focus");
		win.maximize();
		win.unmaximize();
		vi.advanceTimersByTime(WAYLAND_MAXIMIZE_SETTLE_MS);

		expect(win.maximize).toHaveBeenCalledTimes(1);
		expect(win.isMaximized()).toBe(false);
	});

	it("opens the default window for a hand-edited zero size and non-boolean maximized", async () => {
		const { createEditorWindow } = await load("linux");
		writeFileSync(
			stateFile(),
			JSON.stringify({ x: 10, y: 20, width: 0, height: 0, maximized: "true" }),
		);
		const win = openEditor(createEditorWindow);

		expect(win.options).toMatchObject({ width: 1200, height: 800 });
		win.emit("focus");
		vi.advanceTimersByTime(WAYLAND_MAXIMIZE_SETTLE_MS);
		expect(win.isMaximized()).toBe(true);
	});

	it("keeps the immediate maximize for the export bench", async () => {
		const { createEditorWindow } = await load("linux");
		createEditorWindow({ windowType: "bench" });
		expect(electron.state.windows.at(-1)?.maximize).toHaveBeenCalledTimes(1);
	});

	it("treats Xwayland (--ozone-platform=x11) as X11", async () => {
		electron.state.ozonePlatform = "x11";
		electron.state.restoredInsets = electron.NONE;
		electron.state.maximizedInsets = electron.NONE;
		const { createEditorWindow } = await load("linux");
		writeFileSync(
			stateFile(),
			JSON.stringify({ x: 40, y: 30, width: 1280, height: 720, maximized: true }),
		);
		const win = openEditor(createEditorWindow);

		expect(win.options).toMatchObject({ x: 40, y: 30, width: 1280, height: 720 });
		expect(win.maximize).toHaveBeenCalledTimes(1);
	});
});

describe("editor window on Windows", () => {
	beforeEach(() => {
		electron.state.restoredInsets = electron.NONE;
		electron.state.maximizedInsets = electron.NONE;
		electron.state.workArea = { x: 0, y: 0, width: 1920, height: 1040 };
	});

	afterEach(() => {
		electron.state.workArea = { x: 0, y: 0, width: 1920, height: 1080 };
	});

	it("keeps the saved position, maximizes at once and saves getNormalBounds()", async () => {
		const { createEditorWindow } = await load("win32");
		writeFileSync(
			stateFile(),
			JSON.stringify({ x: 100, y: 50, width: 1280, height: 720, maximized: true }),
		);
		const win = openEditor(createEditorWindow);

		expect(win.options).toMatchObject({ x: 100, y: 50, width: 1280, height: 720 });
		expect(win.maximize).toHaveBeenCalledTimes(1);
		win.close();
		expect(saved()).toEqual({ x: 100, y: 50, width: 1280, height: 720, maximized: true });
	});

	it("clamps what it saves to the work area", async () => {
		const { createEditorWindow } = await load("win32");
		const win = openEditor(createEditorWindow);
		win.unmaximize();
		win.resizeTo(1920, 1080);
		win.close();

		expect(saved()).toMatchObject({ y: 0, width: 1920, height: 1040, maximized: false });
	});
});
