export interface HudOverlayPoint {
	x: number;
	y: number;
}

export interface HudOverlayBounds extends HudOverlayPoint {
	width: number;
	height: number;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

/**
 * Resolves a HUD position from one absolute drag origin.
 *
 * Electron's screen cursor and BrowserWindow bounds are both expressed in DIP.
 * Keeping the calculation in that single coordinate space avoids the feedback
 * drift caused by repeatedly adding renderer PointerEvent.screenX/screenY deltas.
 */
export function resolveHudOverlayDragPosition(
	startBounds: HudOverlayBounds,
	startCursor: HudOverlayPoint,
	currentCursor: HudOverlayPoint,
): HudOverlayPoint {
	const desiredX = startBounds.x + currentCursor.x - startCursor.x;
	const desiredY = startBounds.y + currentCursor.y - startCursor.y;

	return {
		x: Math.round(desiredX),
		y: Math.round(desiredY),
	};
}

/** Keeps the complete HUD inside a display's taskbar-aware work area after release. */
export function clampHudOverlayPosition(
	position: HudOverlayPoint,
	hudSize: Pick<HudOverlayBounds, "width" | "height">,
	workArea: HudOverlayBounds,
): HudOverlayPoint {
	const maxX = workArea.x + Math.max(0, workArea.width - hudSize.width);
	const maxY = workArea.y + Math.max(0, workArea.height - hudSize.height);

	return {
		x: Math.round(clamp(position.x, workArea.x, maxX)),
		y: Math.round(clamp(position.y, workArea.y, maxY)),
	};
}
