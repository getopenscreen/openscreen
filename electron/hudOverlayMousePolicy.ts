export type HudOverlayPoint = {
	x: number;
	y: number;
};

export type HudOverlayBounds = HudOverlayPoint & {
	width: number;
	height: number;
};

export function isPointInsideHudOverlayBounds(
	point: HudOverlayPoint,
	bounds: HudOverlayBounds,
): boolean {
	return (
		bounds.width > 0 &&
		bounds.height > 0 &&
		point.x >= bounds.x &&
		point.x < bounds.x + bounds.width &&
		point.y >= bounds.y &&
		point.y < bounds.y + bounds.height
	);
}

/**
 * Renderer hover events are only a fast path. A native Electron drag region
 * consumes pointer events, so the main process must also make the HUD interactive
 * whenever the OS cursor is inside the BrowserWindow bounds.
 *
 * Electron reports both cursor points and BrowserWindow bounds in DIP, so this
 * comparison stays valid across arbitrary Windows scaling and negative monitor
 * origins without multiplying by a scale factor.
 */
export function shouldIgnoreHudOverlayMouseEvents(
	rendererRequestedIgnore: boolean,
	cursor: HudOverlayPoint,
	bounds: HudOverlayBounds,
): boolean {
	return rendererRequestedIgnore && !isPointInsideHudOverlayBounds(cursor, bounds);
}
