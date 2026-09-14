// Where the HUD overlay window is allowed to sit.
//
// The HUD is a transparent, always-on-top, `skipTaskbar` window, and the bar the
// user sees is only the bottom slice of it: everything above the bar is reserve
// for popovers plus growth hysteresis (see src/components/launch/hudGeometry.ts),
// which is why the window is several times taller than the bar. Clamping the
// *window* to the work area therefore over-constrains the bar: it inherits the
// reserve as a phantom margin at every edge and can never leave the bottom of
// the screen. So the invariant is stated on the bar, not on the window: the
// content rect the renderer measures must sit fully inside the work area, and
// the window around it may overhang any edge — the overhang is transparent and
// click-through (not on Linux, where windows.ts clamps the whole window instead).
//
// The Windows taskbar and the macOS Dock live *outside* the work area, so a HUD
// whose bar lands there is painted over them with no taskbar entry to bring it
// back — the tray icon is the only way home.
//
// Pure geometry on purpose: `screen` and the window are the caller's job, so the
// rules can be tested without an Electron runtime.

import {
	clampRectToWorkArea,
	type DisplayWorkArea,
	type EditorWindowRect,
} from "./editorWindowState";

/** The HUD's own floor, matching `minWidth`/`minHeight` at construction. */
export const HUD_WINDOW_MIN = { width: 120, height: 80 };

/**
 * The visible stack's rect relative to the window, as measured by the renderer:
 * the bar plus any popover or notice open above it, which is just as visible as
 * the bar. The viewport of the frameless window is the whole window, so a
 * `getBoundingClientRect()` is already in these coordinates.
 */
export type HudContentRect = EditorWindowRect;

export function sameRect(a: EditorWindowRect, b: EditorWindowRect): boolean {
	return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** Screenspace rect of the bar, given the window's position. */
export function hudContentScreenRect(
	bounds: EditorWindowRect,
	content: HudContentRect,
): EditorWindowRect {
	return {
		x: bounds.x + content.x,
		y: bounds.y + content.y,
		width: content.width,
		height: content.height,
	};
}

/**
 * Puts the bar inside the work area of the display it is heading for. The
 * window is translated by the same amount and may end up overhanging — that is
 * the reserve, not the content, and it is invisible.
 */
export function clampHudContentToWorkArea(
	bounds: EditorWindowRect,
	content: HudContentRect,
	workArea: DisplayWorkArea,
): EditorWindowRect {
	// The content's own size as the floor leaves its size untouched: only the
	// position is clamped.
	const { x, y } = clampRectToWorkArea(hudContentScreenRect(bounds, content), workArea, content);
	// `| 0` collapses the negative zero Math.round can produce and pins the value
	// to int32 for the native setter — same reasons as in hudDragDestination.
	return {
		...bounds,
		x: Math.round(x - content.x) | 0,
		y: Math.round(y - content.y) | 0,
	};
}

/**
 * Clamps by the bar when the renderer has reported one, and by the whole window
 * until then (the first frames, or a malformed message). The window fallback is
 * the conservative one: it can only leave the bar further from an edge.
 */
export function clampHudBoundsToWorkArea(
	bounds: EditorWindowRect,
	content: HudContentRect | null,
	workArea: DisplayWorkArea,
): EditorWindowRect {
	return content
		? clampHudContentToWorkArea(bounds, content, workArea)
		: clampRectToWorkArea(bounds, workArea, HUD_WINDOW_MIN);
}

/**
 * Where a resize re-anchors the window: the bar's bottom-centre stays under
 * where it was, so switching between the horizontal bar and the tall vertical
 * tray resizes the window around the bar instead of moving the bar. The new
 * content rect is supplied by the renderer for the size it is asking for — the
 * stack is centred and pinned `HUD_BAR_BOTTOM` above the window's bottom edge
 * (LaunchWindow.module.css), so the post-resize rect is computed, not guessed.
 * The result keeps the new bar fully inside the work area, so a layout flip
 * cannot strand the HUD off screen.
 */
export function hudResizeBounds(input: {
	bounds: EditorWindowRect;
	/** Bar rect in the window as it currently is; null before the first report. */
	previousContent: HudContentRect | null;
	width: number;
	height: number;
	/** Bar rect in the requested size; null for a malformed message. */
	nextContent: HudContentRect | null;
	workArea: DisplayWorkArea;
}): EditorWindowRect {
	// Not capped to the work area: the window may overhang, and capping it would move
	// the content away from the rect the renderer computed for this exact size.
	const width = Math.max(1, Math.round(input.width));
	const height = Math.max(1, Math.round(input.height));

	const anchorCenterX = input.previousContent
		? input.bounds.x + input.previousContent.x + input.previousContent.width / 2
		: input.bounds.x + input.bounds.width / 2;
	const anchorBottomY = input.previousContent
		? input.bounds.y + input.previousContent.y + input.previousContent.height
		: input.bounds.y + input.bounds.height;

	const x = input.nextContent
		? anchorCenterX - (input.nextContent.x + input.nextContent.width / 2)
		: anchorCenterX - width / 2;
	const y = input.nextContent
		? anchorBottomY - (input.nextContent.y + input.nextContent.height)
		: anchorBottomY - height;

	return clampHudBoundsToWorkArea(
		{ x: Math.round(x), y: Math.round(y), width, height },
		input.nextContent,
		input.workArea,
	);
}

/**
 * Validates the content rect arriving over IPC. Anything not shaped like a
 * finite rect with positive size is ignored, and the caller falls back to
 * whole-window clamping.
 */
export function parseHudContentRect(raw: unknown): HudContentRect | null {
	if (!raw || typeof raw !== "object") return null;
	const rec = raw as Record<string, unknown>;
	const { x, y, width, height } = rec;
	if (
		typeof x !== "number" ||
		typeof y !== "number" ||
		typeof width !== "number" ||
		typeof height !== "number"
	) {
		return null;
	}
	if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
	if (!(width > 0) || !Number.isFinite(width) || !(height > 0) || !Number.isFinite(height)) {
		return null;
	}
	return { x, y, width, height };
}

/**
 * Where the drag handle is asking for the window to go, before the work-area
 * clamp.
 *
 * The caller resolves the display from *this* rect rather than from the window's
 * current one, so dragging towards a second display follows the pointer instead
 * of stopping at the edge of the display the drag started on.
 */
export function hudDragDestination(input: {
	bounds: EditorWindowRect;
	origin: { x: number; y: number };
	deltaX: number;
	deltaY: number;
}): EditorWindowRect {
	// `| 0` is load-bearing, not defensive noise. Math.round returns NEGATIVE ZERO for
	// any delta in [-0.5, 0) — routine under fractional scaling, where screenY deltas
	// are fractional. V8's IsInt32() rejects -0, so gin refuses to convert it and the
	// main process dies with "Error processing argument at index 1, conversion failure
	// from". `Number.isFinite(-0)` is true, so a finiteness check does NOT catch this;
	// `| 0` collapses -0 to 0 and pins the value to int32. (`+ 0` would not: -0 + 0 is
	// still -0, and Math.trunc preserves it too.)
	const x = Math.round(input.origin.x + input.deltaX) | 0;
	const y = Math.round(input.origin.y + input.deltaY) | 0;

	return { ...input.bounds, x, y };
}
