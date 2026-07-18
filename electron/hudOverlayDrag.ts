export type HudOverlayDragPoint = {
	x: number;
	y: number;
};

export type HudOverlayDragBounds = HudOverlayDragPoint & {
	width: number;
	height: number;
};

export function parseHudOverlayDragPoint(x: unknown, y: unknown): HudOverlayDragPoint | null {
	return typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y)
		? { x, y }
		: null;
}

/**
 * Resolve each drag frame from the immutable start state. Electron exposes both
 * BrowserWindow bounds and cursor screen points in DIP, so no display scale
 * conversion is needed at 125%, arbitrary custom scaling, or across monitors.
 * Re-anchoring to the start also prevents rounding error from accumulating.
 */
export function getHudOverlayDragPosition(
	startWindow: HudOverlayDragPoint,
	startCursor: HudOverlayDragPoint,
	currentCursor: HudOverlayDragPoint,
): HudOverlayDragPoint {
	return {
		x: Math.round(startWindow.x + currentCursor.x - startCursor.x),
		y: Math.round(startWindow.y + currentCursor.y - startCursor.y),
	};
}

/**
 * Keep the BrowserWindow's logical size immutable for the complete drag. On
 * fractional-DPI Windows displays, repeatedly moving only the HWND position can
 * otherwise let Chromium publish slightly different viewport dimensions.
 */
export function getHudOverlayDragBounds(
	startWindow: HudOverlayDragBounds,
	startCursor: HudOverlayDragPoint,
	currentCursor: HudOverlayDragPoint,
): HudOverlayDragBounds {
	return {
		...getHudOverlayDragPosition(startWindow, startCursor, currentCursor),
		width: startWindow.width,
		height: startWindow.height,
	};
}
