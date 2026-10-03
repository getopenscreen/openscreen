/** Fit a 16:9 picture in the viewport, then extend it only for a taller inspector. */
export function footageSize(width: number, columnHeight: number, availableHeight: number) {
	const fittedWidth = Math.min(width, availableHeight * (16 / 9));
	return { width: fittedWidth, height: Math.max(fittedWidth * (9 / 16), columnHeight) };
}

/** Follow a settled pane height without ever overshooting it. */
export function followHeight(current: number, target: number, elapsed: number): number {
	if (Math.abs(target - current) < 0.25) return target;
	return current + (target - current) * (1 - Math.exp(-Math.max(0, elapsed) / 70));
}
