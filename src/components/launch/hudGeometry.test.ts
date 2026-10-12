import { describe, expect, it } from "vitest";
import {
	addHudToastsToStack,
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
