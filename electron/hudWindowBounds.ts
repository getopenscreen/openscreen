// Where the HUD overlay window is allowed to sit.
//
// The HUD is transparent, always-on-top and `skipTaskbar`, and two different inputs move
// it: the drag handle repositions it frame by frame, and a content change re-anchors it
// around its bottom edge. The Windows taskbar and the macOS Dock live *outside* the
// display work area, so a HUD that lands there is painted over them with no taskbar
// entry to bring it back — the tray icon is the only way home.
//
// Pure geometry on purpose: `screen` and the window are the caller's job, so the rules
// can be tested without an Electron runtime.

import {
	clampRectToWorkArea,
	type DisplayWorkArea,
	type EditorWindowRect,
} from "./editorWindowState";

/** The HUD's own floor, matching `minWidth`/`minHeight` at construction. */
export const HUD_WINDOW_MIN = { width: 120, height: 80 };

/** Puts HUD bounds inside the work area of the display they belong to. */
export function clampHudToWorkArea(
	bounds: EditorWindowRect,
	workArea: DisplayWorkArea,
): EditorWindowRect {
	return clampRectToWorkArea(bounds, workArea, HUD_WINDOW_MIN);
}

/**
 * Where the drag handle is asking for the window to go, before the work-area clamp.
 *
 * The caller resolves the display from *this* rect rather than from the window's current
 * one, so dragging towards a second display follows the pointer instead of stopping at
 * the edge of the display the drag started on.
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
