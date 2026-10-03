/** The preview plays on a clock; docking freezes that clock and rewinds it.
 * Once docked, the original editor score belongs entirely to the scroll. */
export const DOCK_VIEWPORTS = 0.28;

const clamp = (value: number) => Math.max(0, Math.min(1, value));

/** A short, refresh-rate-independent catch-up for wheel/trackpad increments. */
export function followDock(current: number, target: number, elapsed: number): number {
	if (Math.abs(target - current) < 0.5) return target;
	return current + (target - current) * (1 - Math.exp(-Math.min(elapsed, 64) / 36));
}

export function createPlayback(duration: number) {
	let previewTime = 0;
	let rewindFrom = 0;
	let lastNow: number | undefined;
	let lastOffset = 0;
	let wasPlaying = false;

	return (now: number, offset: number, span: number, dockDistance: number, playing: boolean) => {
		const elapsed = lastNow === undefined || !wasPlaying || !playing ? 0 : (now - lastNow) / 1000;
		if (lastOffset <= 0) previewTime = (previewTime + elapsed) % duration;
		if (offset > 0 && lastOffset <= 0) rewindFrom = previewTime;
		if (offset <= 0 && lastOffset > 0) previewTime = rewindFrom;

		const position = clamp(offset / dockDistance);
		// Respond immediately, then settle gently into the editor.
		const dock = 1 - (1 - position) ** 3;
		const progress = clamp((offset - dockDistance) / Math.max(1, span - dockDistance));
		const phase = offset <= 0 ? "preview" : position < 1 ? "docking" : "editor";
		const time =
			phase === "preview"
				? previewTime
				: phase === "docking"
					? rewindFrom * (1 - dock)
					: progress * duration;

		lastNow = now;
		lastOffset = offset;
		wasPlaying = playing;
		return { time, dock, phase };
	};
}
