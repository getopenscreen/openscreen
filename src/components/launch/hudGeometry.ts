/**
 * Geometry for the HUD overlay window.
 *
 * The HUD lives in a transparent, click-through BrowserWindow whose size the
 * renderer drives over IPC. The old approach *discovered* the size it needed by
 * measuring whatever happened to be on screen and growing to fit, which closed a
 * feedback loop: a native resize changes the viewport, viewport-sized elements
 * re-layout, the ResizeObserver fires again, and another resize goes out. Ten
 * animation frames per resize turned that into visible flicker, and the first
 * open of every popover was a jump because its space had never been seen before.
 *
 * So: reserve instead of discover. The bar is the only thing whose size can't be
 * predicted (localized labels, source names), so it alone is measured. Everything
 * that floats above it has a fixed width and a capped, internally-scrolling
 * height, and that space is reserved in the window from the very first frame.
 * Opening or closing a popover, or a device list changing length, then costs
 * exactly zero native resizes.
 *
 * Nothing here may depend on `window.innerWidth/innerHeight`: that is the edge
 * the loop used to close on. Screen-derived values (`screen.availHeight`) are
 * fine — they don't change when the window does.
 */

/** Gap between the window's bottom edge and the bar's bottom edge. */
export const HUD_BAR_BOTTOM = 20;
/** Hard minimum breathing room on every edge, so drop shadows aren't clipped. */
export const HUD_EDGE_SLACK = 24;
/** Vertical gap between the bar and the popover stack floating above it. */
export const HUD_POPOVER_GAP = 8;
/** Gap between stacked floating elements (popover, notices). */
export const HUD_STACK_GAP = 10;
/** Width of the device / language popovers. */
export const HUD_POPOVER_WIDTH = 220;
/** Width of the top notices (locale suggestion, software-encoder fallback). */
export const HUD_NOTICE_WIDTH = 360;
/**
 * Widest thing that can ever float above the bar. Always reserved, so a popover
 * or a notice appearing never changes the window's width.
 */
export const HUD_STACK_WIDTH = Math.max(HUD_POPOVER_WIDTH, HUD_NOTICE_WIDTH);
/** Cap on any popover's height; past this it scrolls internally. */
export const HUD_POPOVER_MAX_HEIGHT = 320;
/** Floor for the popover cap on very short screens. */
export const HUD_POPOVER_MIN_HEIGHT = 140;
/**
 * The device-settings panel is the tallest floating surface, so it is what the
 * window reserves room for — permanently, whether or not it happens to be open.
 * Sizing the reserve to what is currently open would mean the window grows on
 * open, and because the stack is bottom-anchored, growing upward shifts all the
 * content down in window coordinates; the renderer repaints that a frame behind
 * the native resize, which reads as position judder. Its width matches
 * HUD_STACK_WIDTH so it never affects the window's width either.
 */
export const HUD_MODAL_MAX_HEIGHT = 470;
export const HUD_MODAL_MIN_HEIGHT = 200;
/**
 * Slack granted *beyond* what is strictly required, on each axis. This is pure
 * hysteresis: the bar can grow by this much (recording controls appearing, a
 * longer source name) before the window has to resize at all, which is what
 * keeps the common interactions completely free of native window churn.
 */
export const HUD_GROWTH_RESERVE = 120;
/** Floor for the window itself, in case the bar measures as ~nothing. */
export const HUD_MIN_WINDOW_WIDTH = 220;
/**
 * Room left for desktop panels the platform never reported: GNOME's 32px top bar plus a
 * bottom dock at Ubuntu's largest icon size, with some to spare.
 */
export const HUD_UNREPORTED_PANELS_ALLOWANCE = 128;

/**
 * The height the HUD budgets its window against: the work area, as the platform reports it.
 *
 * Wayland reports none. No protocol tells a client where the shell's panels are, so
 * Chromium's `screen.availHeight` there is the display's full height, even on a GNOME
 * desktop whose top bar and dock take part of it. The vertical tray asks for more than it
 * can have, so on a 1080p display it was granted all 1080px: a window that cannot fit below
 * GNOME's top bar, so the bottom of the bar (Open Studio, Hide, Quit) stayed off screen
 * wherever it was dragged. The compositor also resizes a Wayland window from its top-left
 * corner, so every flip to vertical pushed the bar down under the dock, and mutter moves a
 * resized window back into the work area only when it fits there. Budgeted below the
 * display's height, the window fits: it can be dragged fully on screen, and mutter puts a
 * flipped tray back on screen by itself when the window was inside the work area before.
 *
 * Linux only, and only when nothing was reported: on X11 the panels are in `availHeight`
 * already, and on Windows a full-height work area is an auto-hidden taskbar.
 */
export function computeHudAvailableHeight(
	screen: { availHeight: number; height: number },
	platform: string,
): number {
	if (platform === "linux" && screen.availHeight >= screen.height) {
		return Math.max(0, screen.availHeight - HUD_UNREPORTED_PANELS_ALLOWANCE);
	}
	return screen.availHeight;
}

export interface HudSize {
	width: number;
	height: number;
}

export interface HudSizeInput {
	barWidth: number;
	barHeight: number;
	/** 0 when no notice is on screen. */
	noticeHeight: number;
	/** Work-area height of the display, NOT the window height. */
	availableHeight: number;
	/** Room reserved above the bar: the tallest surface that can float there. */
	stackMaxHeight: number;
}

/** Room left above the bar for whatever is floating there. */
function stackRoom(barHeight: number, availableHeight: number): number {
	return availableHeight - HUD_BAR_BOTTOM - barHeight - HUD_POPOVER_GAP - HUD_EDGE_SLACK * 2;
}

/**
 * How tall a popover may be given the room left above the bar. The vertical tray
 * can be several hundred pixels tall, so on a short screen the popover has to
 * give way rather than push the window off the top of the display.
 */
export function computeHudPopoverMaxHeight(barHeight: number, availableHeight: number): number {
	const room = stackRoom(barHeight, availableHeight);
	return Math.round(Math.min(HUD_POPOVER_MAX_HEIGHT, Math.max(HUD_POPOVER_MIN_HEIGHT, room)));
}

/** Same, for the taller device-settings panel. */
export function computeHudModalMaxHeight(barHeight: number, availableHeight: number): number {
	const room = stackRoom(barHeight, availableHeight);
	return Math.round(Math.min(HUD_MODAL_MAX_HEIGHT, Math.max(HUD_MODAL_MIN_HEIGHT, room)));
}

/** Tallest the bar itself is allowed to get before it scrolls internally. */
export function computeHudBarMaxHeight(availableHeight: number): number {
	return Math.round(
		Math.max(
			HUD_POPOVER_MIN_HEIGHT,
			availableHeight -
				HUD_BAR_BOTTOM -
				HUD_POPOVER_GAP -
				HUD_POPOVER_MIN_HEIGHT -
				HUD_EDGE_SLACK * 2,
		),
	);
}

/**
 * `required` is the smallest window that shows everything without clipping;
 * `granted` is what we actually ask for. The gap between them is the hysteresis
 * that stops small content changes from resizing the window.
 */
export function computeHudWindowSize(input: HudSizeInput): {
	required: HudSize;
	granted: HudSize;
} {
	const stackWidth = Math.max(Math.ceil(input.barWidth), HUD_STACK_WIDTH);
	const requiredWidth = Math.max(HUD_MIN_WINDOW_WIDTH, stackWidth + HUD_EDGE_SLACK * 2);

	const noticeBlock = input.noticeHeight > 0 ? HUD_STACK_GAP + Math.ceil(input.noticeHeight) : 0;
	const rawHeight =
		HUD_BAR_BOTTOM +
		Math.ceil(input.barHeight) +
		HUD_POPOVER_GAP +
		Math.ceil(input.stackMaxHeight) +
		noticeBlock +
		HUD_EDGE_SLACK;

	// The main process clamps the whole window to the work area on Linux, so clamp here too:
	// otherwise the caller would record an allocation the window never actually
	// got, then skip a resize it genuinely needs later on.
	const ceiling = input.availableHeight > 0 ? input.availableHeight : Number.POSITIVE_INFINITY;
	const requiredHeight = Math.min(rawHeight, ceiling);

	return {
		required: { width: requiredWidth, height: requiredHeight },
		granted: {
			width: requiredWidth + HUD_GROWTH_RESERVE * 2,
			height: Math.min(rawHeight + HUD_GROWTH_RESERVE, ceiling),
		},
	};
}

/** Sonner's toast width (its TOAST_WIDTH), which a centred toast takes whatever it says. */
export const HUD_TOAST_WIDTH = 356;
/** How far sonner lifts each toast behind the front one in its collapsed stack (its GAP). */
export const HUD_TOAST_LIFT = 14;
/** How many toasts sonner shows at once (its VISIBLE_TOASTS_AMOUNT). */
export const HUD_TOAST_VISIBLE = 3;

/**
 * Where the HUD's toasts sit: their bottom edge this far above the window's bottom edge,
 * which is above the whole stack (the bar and anything open over it).
 *
 * Sonner's default corner of the window is where the bar is, so a toast covered Record,
 * Pause and Stop, and since sonner holds a toast while the pointer is over it, it stayed as
 * long as the user was reaching for the controls under it (#1149). Above the stack is the
 * reserve the window keeps for floating surfaces anyway, in either orientation.
 */
export function computeHudToastBottom(stackHeight: number): number {
	return HUD_BAR_BOTTOM + Math.ceil(stackHeight) + HUD_STACK_GAP;
}

/**
 * Height of sonner's collapsed stack: the front toast, plus one lift per toast behind it.
 * Zero when nothing is up, or before sonner has measured the front toast.
 */
export function computeHudToastsHeight(frontHeight: number, count: number): number {
	if (count <= 0 || !(frontHeight > 0)) return 0;
	return Math.ceil(frontHeight) + (Math.min(count, HUD_TOAST_VISIBLE) - 1) * HUD_TOAST_LIFT;
}

/**
 * The stack plus the toasts floating above it: what has to stay on screen. Both are centred
 * on the window, so only the width and the height grow.
 */
export function addHudToastsToStack(stack: HudSize, toastsHeight: number): HudSize {
	if (toastsHeight <= 0) return stack;
	return {
		width: Math.max(stack.width, HUD_TOAST_WIDTH),
		height: stack.height + HUD_STACK_GAP + Math.ceil(toastsHeight),
	};
}

/**
 * How far past its trigger a tooltip has to sit to clear the BAR, on the side it opens.
 *
 * Radix places a tooltip against the small trigger, but the bar is the surface the eye sees. It
 * pads the button (8px from the button's top edge to the bar's), and a vertical bar widens to
 * fit the timer while recording (Pause, Restart and Cancel then sit about 28px inside its right
 * edge). Both ate into the tooltip's gap, so it overlapped the bar. Measured at the moment the
 * tooltip opens, it holds for either orientation and either state.
 */
export function computeHudTooltipClearance(
	trigger: { top: number; right: number },
	bar: { top: number; right: number },
	side: "top" | "right",
): number {
	const inset = side === "top" ? trigger.top - bar.top : bar.right - trigger.right;
	return Math.max(0, Math.round(inset));
}
