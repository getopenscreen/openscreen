export type HudViewportSize = {
	width: number;
	height: number;
};

export type HudViewportCompensation = {
	x: number;
	y: number;
};

/**
 * Keeps viewport-centred, bottom-anchored HUD content fixed to the pointer while
 * Chromium rounds a transparent Windows HWND outward at fractional DPI scales.
 */
export function getHudViewportCompensation(
	startCompensation: HudViewportCompensation,
	startViewport: HudViewportSize,
	currentViewport: HudViewportSize,
): HudViewportCompensation {
	return {
		x: startCompensation.x + (currentViewport.width - startViewport.width) / 2,
		y: startCompensation.y + currentViewport.height - startViewport.height,
	};
}
