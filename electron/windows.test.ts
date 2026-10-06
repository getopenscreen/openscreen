import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Windows at 125 %, as in #1004: a 1920x1080 panel whose taskbar leaves a 1032px work area.
const WORK_AREA_BOTTOM_PX = 1032;
// The bar as LaunchWindow lays it out: centred, 20 CSS px above the window's bottom edge.
const BAR = { width: 560, height: 64, bottomInset: 20 };

const electron = vi.hoisted(() => {
	type Rect = { x: number; y: number; width: number; height: number };
	const scale = 1.25;
	// Chromium's DIP <-> pixel conversion on Windows (ui/display/win/screen_win.cc): the
	// origin is rounded, the size is ScaleToEnclosingRect's, i.e. the span rounded outwards.
	const enclosing = (start: number, size: number, factor: number) =>
		Math.ceil((start + size) * factor) - Math.floor(start * factor);
	const convert = (rect: Rect, factor: number): Rect => ({
		x: Math.round(rect.x * factor),
		y: Math.round(rect.y * factor),
		width: enclosing(rect.x, rect.width, factor),
		height: enclosing(rect.y, rect.height, factor),
	});

	/** A BrowserWindow as Electron drives one on Windows: only the pixel rect is real. */
	class FakeWindow {
		pixels: Rect;
		webContents = { on: vi.fn(), send: vi.fn() };
		setContentProtection = vi.fn();
		once = vi.fn();
		on = vi.fn();
		loadURL = vi.fn();
		loadFile = vi.fn();
		constructor(options: Rect) {
			this.pixels = convert(options, scale);
		}
		getBounds() {
			return convert(this.pixels, 1 / scale);
		}
		getPosition() {
			const { x, y } = this.getBounds();
			return [x, y];
		}
		setBounds(bounds: Rect) {
			this.pixels = convert(bounds, scale);
		}
		// Electron's own implementation (shell/browser/native_window.cc).
		setPosition(x: number, y: number) {
			const { width, height } = this.getBounds();
			this.setBounds({ x, y, width, height });
		}
		isDestroyed() {
			return false;
		}
		isMinimized() {
			return false;
		}
	}

	// 1920x1032 px of work area, enclosed in DIP the way Chromium reports it.
	const display = { workArea: { x: 0, y: 0, width: 1536, height: 826 } };
	const handlers = new Map<string, (event: unknown, ...args: unknown[]) => void>();
	return { scale, FakeWindow, display, handlers };
});

vi.mock("electron", () => ({
	app: {},
	BrowserWindow: electron.FakeWindow,
	ipcMain: {
		on: (channel: string, handler: (event: unknown, ...args: unknown[]) => void) =>
			electron.handlers.set(channel, handler),
	},
	screen: {
		getPrimaryDisplay: () => electron.display,
		getDisplayMatching: () => electron.display,
		on: vi.fn(),
	},
}));

const REAL_PLATFORM = process.platform;
let createHudOverlayWindow: typeof import("./windows").createHudOverlayWindow;

beforeAll(async () => {
	// windows.ts decides at import whether to clamp the bar or, on Linux, the whole window.
	Object.defineProperty(process, "platform", { value: "win32", configurable: true });
	({ createHudOverlayWindow } = await import("./windows"));
});

afterAll(() => {
	Object.defineProperty(process, "platform", { value: REAL_PLATFORM, configurable: true });
});

const send = (channel: string, ...args: unknown[]) => electron.handlers.get(channel)?.({}, ...args);

/** A new HUD, sized by the renderer's first measurement: 944x705 DIP, 1180x882 px. */
function openHud() {
	const win = createHudOverlayWindow() as unknown as InstanceType<typeof electron.FakeWindow>;
	const size = { width: 944, height: 705 };
	send("hud-overlay-set-size", size.width, size.height, {
		x: (size.width - BAR.width) / 2,
		y: size.height - BAR.bottomInset - BAR.height,
		width: BAR.width,
		height: BAR.height,
	});
	return win;
}

/** A drag by the handle in small steps; the renderer sends the total travel each time. */
function drag(steps: number, stepX: number, stepY: number) {
	send("hud-overlay-drag-start");
	for (let i = 1; i <= steps; i++) {
		send("hud-overlay-drag-to", i * stepX, i * stepY);
	}
	send("hud-overlay-drag-end");
}

describe("HUD drag at 125 % scaling (#1004)", () => {
	it("keeps the window's size", () => {
		const win = openHud();
		const { width, height } = win.pixels;
		drag(40, 1.6, -2.4);
		// One DIP size lands on 1180 or 1181 px depending on where it starts: a pixel of
		// wobble, never growth.
		expect(Math.abs(win.pixels.width - width)).toBeLessThanOrEqual(1);
		expect(Math.abs(win.pixels.height - height)).toBeLessThanOrEqual(1);
	});

	it("keeps the bar above the taskbar after a long drag down", () => {
		const win = openHud();
		drag(40, 0.8, 40);
		const barBottom = win.pixels.y + win.pixels.height - BAR.bottomInset * electron.scale;
		// One row of slack: the work area Electron reports is enclosed in DIP (825.6 -> 826).
		expect(barBottom).toBeLessThanOrEqual(WORK_AREA_BOTTOM_PX + 1);
	});

	it("ignores an empty size instead of carrying it into the next move", () => {
		const win = openHud();
		const { width, height } = win.pixels;
		send("hud-overlay-set-size", 0, 0, null);
		drag(4, 2, 0);
		expect(Math.abs(win.pixels.width - width)).toBeLessThanOrEqual(1);
		expect(Math.abs(win.pixels.height - height)).toBeLessThanOrEqual(1);
	});
});
