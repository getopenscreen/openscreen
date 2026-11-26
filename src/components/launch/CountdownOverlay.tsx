import { useEffect, useState } from "react";
import { flushSync } from "react-dom";

/**
 * Display frames to let pass after the digit is cleared before saying so: one for Chromium to
 * produce the empty frame, one for it to reach the compositor, and one of margin. The hide
 * waits on this on Linux, where the capture would otherwise record the last painted digit
 * (`electron/countdownOverlay.ts`).
 */
export const CLEARED_AFTER_FRAMES = 3;

function afterAnimationFrames(count: number, callback: () => void) {
	if (count <= 0) {
		callback();
		return;
	}
	requestAnimationFrame(() => afterAnimationFrames(count - 1, callback));
}

export function CountdownOverlay() {
	const [value, setValue] = useState<number | null>(null);
	/** The one-shot ring that sweeps the display between the last digit and the take. */
	const [marquee, setMarquee] = useState(false);

	useEffect(() => {
		const unsubscribe = window.electronAPI.onCountdownOverlayValue((nextValue, runId) => {
			// Committed now rather than batched, so every frame counted below is already empty.
			// The ring clears in the same commit as the digit OR the cleared frame: a null value
			// must not leave the previous run's sweep still painted when the cleared frame is
			// acknowledged, or the hide can carry that ring into the take on Linux.
			flushSync(() => {
				setValue(nextValue);
				setMarquee(false);
			});
			if (nextValue === null) {
				afterAnimationFrames(CLEARED_AFTER_FRAMES, () =>
					window.electronAPI.notifyCountdownOverlayCleared(runId),
				);
			}
		});

		const unsubscribeMarquee = window.electronAPI.onCountdownOverlayMarquee(() => {
			setMarquee(true);
		});

		return () => {
			unsubscribe();
			unsubscribeMarquee();
		};
	}, []);

	if (value === null && !marquee) {
		return null;
	}

	return (
		<div className="w-screen h-screen bg-transparent flex items-center justify-center pointer-events-none select-none">
			{marquee ? (
				<div className="recording-marquee-ring" aria-hidden="true" />
			) : (
				value !== null && (
					<div className="flex items-center justify-center w-40 h-40 rounded-full bg-black/50">
						<div
							className="text-white/90 text-[80px] font-bold leading-none tabular-nums"
							style={{ textShadow: "0 4px 24px rgba(0, 0, 0, 0.65)" }}
						>
							{value}
						</div>
					</div>
				)
			)}
		</div>
	);
}
