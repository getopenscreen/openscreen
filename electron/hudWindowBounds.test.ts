import { describe, expect, it } from "vitest";
import {
	clampHudBoundsToWorkArea,
	clampHudContentToWorkArea,
	hudDragDestination,
	hudResizeBounds,
	parseHudContentRect,
} from "./hudWindowBounds";

// 1920x1080 with a 48px taskbar at the bottom: the work area stops above it.
const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1032 };

// A realistic HUD: a 930x696 window whose visible part is a 560x64 bar sitting
// 20px above the window's bottom edge, centred (see LaunchWindow.module.css and
// hudGeometry.ts). Everything else in the window is transparent reserve.
const WINDOW = { x: 680, y: 236, width: 930, height: 696 };
const BAR = { x: 185, y: 612, width: 560, height: 64 };
const BAR_BOTTOM_INSET = 696 - 612 - 64; // 20

/** The bar's rect on screen for a window position. */
function barOnScreen(bounds: { x: number; y: number }) {
	return {
		left: bounds.x + BAR.x,
		top: bounds.y + BAR.y,
		right: bounds.x + BAR.x + BAR.width,
		bottom: bounds.y + BAR.y + BAR.height,
	};
}

/** The drag path as the IPC handler runs it: destination first, then the clamp by the bar. */
function dragTo(
	deltaX: number,
	deltaY: number,
	{ bounds = WINDOW, bar = BAR, workArea = WORK_AREA } = {},
) {
	const destination = hudDragDestination({ bounds, origin: bounds, deltaX, deltaY });
	return clampHudContentToWorkArea(destination, bar, workArea);
}

describe("hud drag bounds", () => {
	it("follows the pointer while the bar stays on screen", () => {
		const next = dragTo(40, -120);
		expect(next).toEqual({ ...WINDOW, x: 720, y: 116 });
		expect(barOnScreen(next)).toEqual({
			left: 905,
			top: 728,
			right: 1465,
			bottom: 792,
		});
	});

	it("brings the bar flush to the right edge, with the reserve overhanging", () => {
		const next = dragTo(4000, 0);
		expect(barOnScreen(next).right).toBe(WORK_AREA.width);
		// The window itself ends past the screen edge: the overhang is the
		// transparent reserve, not the bar.
		expect(next.x + next.width).toBe(WORK_AREA.width + BAR.x);
	});

	it("brings the bar flush to the left edge", () => {
		const next = dragTo(-4000, 0);
		expect(barOnScreen(next).left).toBe(WORK_AREA.x);
		expect(next.x).toBe(WORK_AREA.x - BAR.x);
	});

	it("brings the bar to the top of the screen — the window overhangs above it", () => {
		// The whole point of clamping the bar rather than the window: with a
		// ~600px reserve above it, a window-clamped HUD could never leave the
		// bottom third of the display.
		const next = dragTo(0, -4000);
		expect(barOnScreen(next).top).toBe(WORK_AREA.y);
		expect(next.y).toBe(WORK_AREA.y - BAR.y);
		expect(next.y).toBeLessThan(0);
	});

	it("stops the bar above the taskbar, letting only the 20px inset overhang it", () => {
		const next = dragTo(0, 4000);
		expect(barOnScreen(next).bottom).toBe(WORK_AREA.height);
		expect(next.y + next.height).toBe(WORK_AREA.height + BAR_BOTTOM_INSET);
	});

	it("follows the pointer onto a secondary display with negative coordinates", () => {
		const left = { x: -1280, y: 0, width: 1280, height: 984 };
		const next = dragTo(-1500, 0, { workArea: left });
		expect(barOnScreen(next).left).toBeLessThan(0);
		expect(barOnScreen(next).left).toBeGreaterThanOrEqual(left.x);
		expect(barOnScreen(next).right).toBeLessThanOrEqual(left.x + left.width);
	});

	it("respects a work area inset on every side — menu bar and a side Dock", () => {
		// A typical macOS arrangement: 25px menu bar at the top, 80px Dock on the
		// right. The work area starts below the one and stops short of the other,
		// and the bar must honour both edges exactly, like the Windows taskbar.
		const mac = { x: 0, y: 25, width: 1920 - 80, height: 1080 - 25 };
		const right = dragTo(4000, 0, { workArea: mac });
		expect(barOnScreen(right).right).toBe(mac.x + mac.width);
		const top = dragTo(0, -4000, { workArea: mac });
		expect(barOnScreen(top).top).toBe(mac.y);
		const bottom = dragTo(0, 4000, { workArea: mac });
		expect(barOnScreen(bottom).bottom).toBe(mac.y + mac.height);
	});

	it("respects a Linux panel layout with bars on two sides", () => {
		// GNOME-classic style: a top panel and a left dock, so the work area is
		// inset from both the top and the left before the drag even starts.
		const linux = { x: 64, y: 32, width: 1856, height: 1048 };
		const left = dragTo(-4000, 0, { workArea: linux });
		expect(barOnScreen(left).left).toBe(linux.x);
		const top = dragTo(0, -4000, { workArea: linux });
		expect(barOnScreen(top).top).toBe(linux.y);
	});

	it("pins a bar larger than the work area to its top-left corner", () => {
		const next = clampHudContentToWorkArea(
			{ x: 900, y: 900, width: 930, height: 696 },
			{ x: 185, y: 612, width: 2600, height: 1400 },
			{ x: 0, y: 0, width: 1024, height: 768 },
		);
		expect(next.x).toBe(-185); // bar left edge at the work area's left
		expect(next.y).toBe(-612); // bar top edge at the work area's top
	});

	it("never hands a fractional or negative-zero coordinate to the window", () => {
		// The bar is centred, so its window-relative x is fractional whenever the
		// window and bar widths have different parity — routine, not exotic.
		const next = clampHudContentToWorkArea(
			{ ...WINDOW, x: 680.4, y: 236.6 },
			{ x: 185.5, y: 612.5, width: 560, height: 64 },
			WORK_AREA,
		);
		expect(Number.isInteger(next.x)).toBe(true);
		expect(Number.isInteger(next.y)).toBe(true);
		expect(Object.is(next.x, -0)).toBe(false);
		expect(Object.is(next.y, -0)).toBe(false);
	});

	it("is idempotent, so a drag that re-clamps every frame cannot creep", () => {
		const once = dragTo(0, 4000);
		const twice = clampHudContentToWorkArea(once, BAR, WORK_AREA);
		expect(twice).toEqual(once);
	});

	it("falls back to whole-window clamping before the renderer reports the bar", () => {
		const destination = hudDragDestination({
			bounds: WINDOW,
			origin: WINDOW,
			deltaX: 0,
			deltaY: 4000,
		});
		const next = clampHudBoundsToWorkArea(destination, null, WORK_AREA);
		expect(next.y + next.height).toBe(WORK_AREA.height);
	});
});

describe("hud resize bounds", () => {
	it("keeps the bar's bottom-centre anchored across a layout flip", () => {
		// Horizontal bar at the bottom of the work area, flipped to the tall
		// vertical tray: the bar must stay put, not the window.
		const atBottom = dragTo(0, 4000);
		const verticalBar = { x: 433, y: 400, width: 64, height: 276 };
		const next = hudResizeBounds({
			bounds: atBottom,
			previousContent: BAR,
			width: 930,
			height: 696,
			nextContent: verticalBar,
			workArea: WORK_AREA,
		});
		// Bar bottom-centre before the flip: x 1145 (window 680 + bar 185 + 280).
		const beforeCenterX = atBottom.x + BAR.x + BAR.width / 2;
		const beforeBottomY = atBottom.y + BAR.y + BAR.height;
		expect(next.x + verticalBar.x + verticalBar.width / 2).toBeCloseTo(beforeCenterX, 0);
		expect(next.y + verticalBar.y + verticalBar.height).toBe(beforeBottomY);
	});

	it("cannot strand the HUD off screen when the bar grows past the top edge", () => {
		// Bar parked at the very top of the screen (window overhanging above),
		// then the vertical tray makes the bar taller than the room it had: the
		// result must keep the whole bar inside the work area.
		const atTop = dragTo(0, -4000);
		const tallBar = { x: 433, y: 300, width: 64, height: 800 };
		const next = hudResizeBounds({
			bounds: atTop,
			previousContent: BAR,
			width: 930,
			height: 1120,
			nextContent: tallBar,
			workArea: WORK_AREA,
		});
		expect(next.y + tallBar.y).toBeGreaterThanOrEqual(WORK_AREA.y);
		expect(next.y + tallBar.y + tallBar.height).toBeLessThanOrEqual(WORK_AREA.y + WORK_AREA.height);
	});

	it("is the identity when neither the size nor the bar changes", () => {
		const next = hudResizeBounds({
			bounds: WINDOW,
			previousContent: BAR,
			width: WINDOW.width,
			height: WINDOW.height,
			nextContent: BAR,
			workArea: WORK_AREA,
		});
		expect(next).toEqual(WINDOW);
	});

	it("does not cap the window to the work area, so the renderer's rect stays exact", () => {
		// A capped height would shift the bar by the difference while main still
		// stored the rect computed for the requested size.
		const next = hudResizeBounds({
			bounds: WINDOW,
			previousContent: BAR,
			width: 930,
			height: 1200,
			nextContent: { ...BAR, y: 1200 - BAR_BOTTOM_INSET - BAR.height },
			workArea: WORK_AREA,
		});
		expect(next.height).toBe(1200);
		// The bar's bottom edge stays exactly where it was.
		expect(next.y + next.height - BAR_BOTTOM_INSET).toBe(WINDOW.y + BAR.y + BAR.height);
	});
});

describe("hud content rect parsing", () => {
	it("accepts a measured rect", () => {
		expect(parseHudContentRect({ x: 185.5, y: 612, width: 560, height: 64 })).toEqual({
			x: 185.5,
			y: 612,
			width: 560,
			height: 64,
		});
	});

	it("rejects garbage, non-finite and non-positive input", () => {
		expect(parseHudContentRect(null)).toBeNull();
		expect(parseHudContentRect("560x64")).toBeNull();
		expect(parseHudContentRect({ x: 0, y: 0, width: Number.NaN, height: 64 })).toBeNull();
		expect(parseHudContentRect({ x: 0, y: 0, width: 0, height: 64 })).toBeNull();
		expect(parseHudContentRect({ x: 0, y: 0, width: 560 })).toBeNull();
	});
});
