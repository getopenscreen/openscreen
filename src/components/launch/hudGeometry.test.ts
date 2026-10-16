import { describe, expect, it } from "vitest";
import {
	addHudToastsToStack,
	computeHudAvailableHeight,
	computeHudBarMaxHeight,
	computeHudModalMaxHeight,
	computeHudPopoverMaxHeight,
	computeHudToastBottom,
	computeHudToastsHeight,
	computeHudTooltipClearance,
	computeHudWindowSize,
	HUD_BAR_BOTTOM,
	HUD_EDGE_SLACK,
	HUD_MODAL_MAX_HEIGHT,
	HUD_POPOVER_GAP,
	HUD_POPOVER_MAX_HEIGHT,
	HUD_POPOVER_MIN_HEIGHT,
	HUD_STACK_GAP,
	HUD_STACK_WIDTH,
	HUD_TOAST_LIFT,
	HUD_TOAST_VISIBLE,
	HUD_TOAST_WIDTH,
	HUD_UNREPORTED_PANELS_ALLOWANCE,
} from "./hudGeometry";

const SCREEN = 1080;

function size(barWidth: number, barHeight: number, noticeHeight = 0, availableHeight = SCREEN) {
	return computeHudWindowSize({
		barWidth,
		barHeight,
		noticeHeight,
		availableHeight,
		// What LaunchWindow reserves: the tallest surface that can float above the
		// bar, regardless of which one is currently open.
		stackMaxHeight: Math.max(
			computeHudPopoverMaxHeight(barHeight, availableHeight),
			computeHudModalMaxHeight(barHeight, availableHeight),
		),
	});
}

describe("computeHudWindowSize", () => {
	it("reserves the popover's full height whether or not one is open", () => {
		// The whole point of reserving: the window is already big enough for a
		// popover before the first one is ever opened, so opening one can't resize
		// (and therefore can't move or flicker) the overlay.
		const { required } = size(520, 48);
		expect(required.height).toBeGreaterThanOrEqual(
			HUD_BAR_BOTTOM + 48 + HUD_POPOVER_GAP + HUD_POPOVER_MAX_HEIGHT,
		);
	});

	it("reserves enough for the tallest surface, the device-settings panel", () => {
		// The panel is taller than a popover. If the reserve only covered popovers,
		// opening it would grow the window — and because the stack is bottom
		// anchored, that shifts the content and shows up as position judder.
		const { required } = size(520, 48);
		expect(required.height).toBeGreaterThanOrEqual(
			HUD_BAR_BOTTOM + 48 + HUD_POPOVER_GAP + HUD_MODAL_MAX_HEIGHT,
		);
	});

	it("reserves room for the widest floating panel even when the bar is narrow", () => {
		const { required } = size(48, 520);
		expect(required.width).toBeGreaterThanOrEqual(HUD_STACK_WIDTH + HUD_EDGE_SLACK * 2);
	});

	it("absorbs bar growth without needing a bigger window", () => {
		// Recording adds a timer and three aux buttons to the bar. That must fit in
		// the already-granted window, otherwise every record start is a resize.
		const idle = size(520, 48);
		const recording = size(640, 48);
		expect(recording.required.width).toBeLessThanOrEqual(idle.granted.width);
		expect(recording.required.height).toBeLessThanOrEqual(idle.granted.height);
	});

	it("grows for a notice and shrinks back once it is gone", () => {
		const withNotice = size(520, 48, 140);
		const without = size(520, 48, 0);
		expect(withNotice.required.height).toBeGreaterThan(without.required.height);
	});

	it("never asks for more height than the display's work area", () => {
		const shortScreen = 700;
		const { required, granted } = size(48, 560, 0, shortScreen);
		expect(required.height).toBeLessThanOrEqual(shortScreen);
		expect(granted.height).toBeLessThanOrEqual(shortScreen);
	});
});

describe("computeHudAvailableHeight", () => {
	// GNOME 46 Wayland, 1920x1080 at 100 %: the vertical tray's window came out 1080 tall, the
	// budget's ceiling, so Chromium's availHeight was the whole display, top bar and dock included.
	const WAYLAND_1080P = { height: 1080, availHeight: 1080 };
	const GNOME_TOP_BAR = 32;
	// Ubuntu's dock at its largest icon size (64px), along the bottom edge.
	const LARGEST_UBUNTU_DOCK = 80;

	it("leaves room for the panels a Wayland session never reports", () => {
		expect(computeHudAvailableHeight(WAYLAND_1080P, "linux")).toBe(
			1080 - HUD_UNREPORTED_PANELS_ALLOWANCE,
		);
	});

	it("trusts a work area the platform did report", () => {
		// X11 publishes the panels (_NET_WORKAREA), so availHeight already leaves them out.
		expect(computeHudAvailableHeight({ height: 1080, availHeight: 1048 }, "linux")).toBe(1048);
		// A full-height work area on Windows is an auto-hidden taskbar, and macOS reports the
		// menu bar and the Dock: neither is touched.
		expect(computeHudAvailableHeight({ height: 1080, availHeight: 1080 }, "win32")).toBe(1080);
		expect(computeHudAvailableHeight({ height: 1080, availHeight: 1055 }, "darwin")).toBe(1055);
	});

	it("budgets a vertical tray on Wayland that fits between GNOME's top bar and its dock", () => {
		// The vertical bar from the GNOME pass, 54x499. Budgeted on the reported 1080 it was
		// granted the full 1080: taller than the room under the top bar, so its bottom
		// controls stayed off screen wherever it was dragged.
		expect(size(54, 499, 0, WAYLAND_1080P.availHeight).granted.height).toBe(1080);

		const budget = computeHudAvailableHeight(WAYLAND_1080P, "linux");
		const { required, granted } = size(54, 499, 0, budget);
		expect(granted.height).toBeLessThanOrEqual(1080 - GNOME_TOP_BAR - LARGEST_UBUNTU_DOCK);
		expect(required.height).toBeLessThanOrEqual(granted.height);
		// Still room for the bar itself and a usable popover above it, and no internal scroll.
		expect(granted.height).toBeGreaterThanOrEqual(
			HUD_BAR_BOTTOM + 499 + HUD_POPOVER_GAP + HUD_POPOVER_MAX_HEIGHT + HUD_EDGE_SLACK,
		);
		expect(computeHudBarMaxHeight(budget)).toBeGreaterThanOrEqual(499);
	});

	it("leaves the horizontal tray's window as it was", () => {
		const budget = computeHudAvailableHeight(WAYLAND_1080P, "linux");
		expect(size(528, 54, 0, budget)).toEqual(size(528, 54, 0, WAYLAND_1080P.availHeight));
	});
});

describe("computeHudPopoverMaxHeight", () => {
	it("caps at the design height when there is plenty of room", () => {
		expect(computeHudPopoverMaxHeight(48, SCREEN)).toBe(HUD_POPOVER_MAX_HEIGHT);
	});

	it("gives way to a tall vertical tray rather than pushing off screen", () => {
		const tall = computeHudPopoverMaxHeight(620, 800);
		expect(tall).toBeLessThan(HUD_POPOVER_MAX_HEIGHT);
		expect(tall).toBeGreaterThanOrEqual(HUD_POPOVER_MIN_HEIGHT);
	});

	it("never returns a height a popover couldn't be usable at", () => {
		expect(computeHudPopoverMaxHeight(2000, 800)).toBe(HUD_POPOVER_MIN_HEIGHT);
	});
});

describe("computeHudTooltipClearance", () => {
	it("clears the padding above a button in a horizontal bar", () => {
		expect(
			computeHudTooltipClearance({ top: 508, right: 300 }, { top: 500, right: 900 }, "top"),
		).toBe(8);
	});

	it("clears a vertical bar that widened to show the timer, not just the trigger", () => {
		// Idle: the bar hugs its 34px buttons. Recording: the timer makes it about 28px wider than
		// the Pause, Restart and Cancel buttons, which stay where they were.
		const idle = computeHudTooltipClearance({ top: 0, right: 92 }, { top: 0, right: 100 }, "right");
		const recording = computeHudTooltipClearance(
			{ top: 0, right: 72 },
			{ top: 0, right: 100 },
			"right",
		);
		expect(idle).toBe(8);
		expect(recording).toBe(28);
	});

	it("never pulls a tooltip toward the trigger", () => {
		expect(computeHudTooltipClearance({ top: 495, right: 0 }, { top: 500, right: 0 }, "top")).toBe(
			0,
		);
	});
});

describe("computeHudBarMaxHeight", () => {
	it("leaves room below the screen height for a popover", () => {
		const max = computeHudBarMaxHeight(SCREEN);
		expect(max).toBeLessThan(SCREEN);
		expect(max + HUD_BAR_BOTTOM + HUD_POPOVER_GAP + HUD_POPOVER_MIN_HEIGHT).toBeLessThanOrEqual(
			SCREEN,
		);
	});
});

describe("HUD toasts", () => {
	it("sit above the whole stack, not in the corner where the bar is (#1149)", () => {
		// The bar alone, then the bar with a popover open over it.
		expect(computeHudToastBottom(56)).toBe(HUD_BAR_BOTTOM + 56 + HUD_STACK_GAP);
		expect(computeHudToastBottom(56 + HUD_POPOVER_GAP + 300)).toBe(
			HUD_BAR_BOTTOM + 56 + HUD_POPOVER_GAP + 300 + HUD_STACK_GAP,
		);
		// A vertical bar is tall: the toasts clear all of it.
		expect(computeHudToastBottom(480.4)).toBe(HUD_BAR_BOTTOM + 481 + HUD_STACK_GAP);
	});

	it("take the front toast's height plus one lift per toast behind it, up to sonner's three", () => {
		expect(computeHudToastsHeight(0, 0)).toBe(0);
		expect(computeHudToastsHeight(64, 0)).toBe(0);
		// Not measured by sonner yet.
		expect(computeHudToastsHeight(0, 2)).toBe(0);
		expect(computeHudToastsHeight(Number.NaN, 2)).toBe(0);
		expect(computeHudToastsHeight(63.5, 1)).toBe(64);
		expect(computeHudToastsHeight(64, 2)).toBe(64 + HUD_TOAST_LIFT);
		expect(computeHudToastsHeight(64, 7)).toBe(64 + (HUD_TOAST_VISIBLE - 1) * HUD_TOAST_LIFT);
	});

	it("count in the rect kept on screen, as wide as a toast over a narrow vertical bar", () => {
		expect(addHudToastsToStack({ width: 48, height: 480 }, 0)).toEqual({ width: 48, height: 480 });
		expect(addHudToastsToStack({ width: 48, height: 480 }, 64)).toEqual({
			width: HUD_TOAST_WIDTH,
			height: 480 + HUD_STACK_GAP + 64,
		});
		expect(addHudToastsToStack({ width: 600, height: 56 }, 64)).toEqual({
			width: 600,
			height: 56 + HUD_STACK_GAP + 64,
		});
	});
});
