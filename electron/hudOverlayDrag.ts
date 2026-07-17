export type HudOverlayDragPoint = {
	x: number;
	y: number;
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
