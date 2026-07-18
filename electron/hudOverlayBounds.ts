export type HudOverlayBounds = {
	x: number;
	y: number;
	width: number;
	height: number;
};

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/**
 * Resize around the HUD's bottom-centre anchor, then keep the full transparent
 * window inside the selected display's work area. The second step matters when
 * a popup opens after the user parked the compact bar near a monitor edge.
 */
export function getHudOverlayResizedBounds(
	currentBounds: HudOverlayBounds,
	workArea: HudOverlayBounds,
	requestedWidth: number,
	requestedHeight: number,
): HudOverlayBounds {
	const workWidth = Math.max(1, Math.round(workArea.width));
	const workHeight = Math.max(1, Math.round(workArea.height));
	const width = Math.min(workWidth, Math.max(1, Math.round(requestedWidth)));
	const height = Math.min(workHeight, Math.max(1, Math.round(requestedHeight)));
	const centerX = currentBounds.x + currentBounds.width / 2;
	const bottomY = currentBounds.y + currentBounds.height;
	const minX = Math.round(workArea.x);
	const minY = Math.round(workArea.y);
	const maxX = minX + workWidth - width;
	const maxY = minY + workHeight - height;

	return {
		x: clamp(Math.round(centerX - width / 2), minX, maxX),
		y: clamp(Math.round(bottomY - height), minY, maxY),
		width,
		height,
	};
}
