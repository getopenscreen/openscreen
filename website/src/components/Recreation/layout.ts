/** Follow a settled pane height without ever overshooting it. */
export function followHeight(current: number, target: number, elapsed: number): number {
	if (Math.abs(target - current) < 0.25) return target;
	return current + (target - current) * (1 - Math.exp(-Math.max(0, elapsed) / 70));
}
