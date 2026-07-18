export type HudViewportSize = {
	width: number;
	height: number;
};

export type HudViewportCompensation = {
	x: number;
	y: number;
};

// Transparent HWND rounding is a small, bounded correction. Larger changes are
// intentional content/window resizes and must never move fixed HUD content.
const MAX_VIEWPORT_ROUNDING_DELTA = 16;

/**
 * Keeps viewport-centred, bottom-anchored HUD content fixed to the pointer while
 * Chromium rounds a transparent Windows HWND outward at fractional DPI scales.
 */
export function getHudViewportCompensation(
	startCompensation: HudViewportCompensation,
	startViewport: HudViewportSize,
	currentViewport: HudViewportSize,
): HudViewportCompensation {
	const widthDelta = currentViewport.width - startViewport.width;
	const heightDelta = currentViewport.height - startViewport.height;
	if (
		Math.abs(widthDelta) > MAX_VIEWPORT_ROUNDING_DELTA ||
		Math.abs(heightDelta) > MAX_VIEWPORT_ROUNDING_DELTA
	) {
		return startCompensation;
	}

	return {
		x: startCompensation.x + widthDelta / 2,
		y: startCompensation.y + heightDelta,
	};
}
