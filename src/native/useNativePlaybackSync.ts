/**
 * Mirrors the app's transport (play/pause) and playhead (scrub/step) onto the
 * active native compositor view. Mounted once in the editor shell; a no-op
 * whenever no native view is active (flag off / addon absent), so it's safe to
 * call unconditionally.
 *
 * Playback model — why we don't push a seek every frame:
 *  - Play/pause maps to native *free-run* (`setNativePlaying`). While playing,
 *    the native decoder advances its own frames sequentially (cheap).
 *  - `currentTimeSec` ticks every rAF frame during playback. Pushing
 *    `setNativeTime` per tick would force an O(n) rewind+decode seek each frame
 *    AND fight the free-run (the render thread prioritises app-requested frames
 *    over free-run). So discrete seeks are only sent while *paused* — i.e. real
 *    scrub/step interactions. Pausing also re-snaps native to the app playhead.
 *
 * While playing, the two clocks are compared by `NativeCompositorOverlay`, from the
 * position each native frame reports (`nativeSync.ts`), not here: this hook used to
 * guess the drift from the wall clock at 1× speed, and re-seeked the view ten times a
 * second inside a 2× speed region.
 */
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { AxcutClip } from "@/lib/ai-edition/schema";
import { resolveNativePosition } from "@/lib/ai-edition/timeline/timelineMap";
import {
	getCurrentNativeViewId,
	setNativePlaying,
	setNativeTime,
	subscribeNativeCompositor,
} from "./nativeCompositorStore";

export function useNativePlaybackSync(
	playing: boolean,
	currentTimeSec: number,
	/** Trim-compressed playback segments (`resolveVisibleClips`) — the native stream. */
	visibleSegments: readonly AxcutClip[],
	/** RAW clip layout (`document.timeline.clips`) `currentTimeSec` is expressed against. */
	rawClips: readonly AxcutClip[],
): void {
	const activePosition = useMemo(
		() => resolveNativePosition(currentTimeSec, [...visibleSegments], [...rawClips]),
		[visibleSegments, rawClips, currentTimeSec],
	);
	const activeClipId = activePosition?.clip.id ?? null;
	const sourceTimeSec = activePosition?.sourceTimeSec ?? null;

	// Reactive "is a native view active?" so activation mid-session re-pushes the
	// current transport/playhead (time & playing aren't memoised in the store).
	const active = useSyncExternalStore(
		subscribeNativeCompositor,
		() => getCurrentNativeViewId() !== null,
	);

	// Play/pause → native free-run.
	useEffect(() => {
		if (!active) {
			return;
		}
		setNativePlaying(playing);
	}, [active, playing]);

	// Scrub/step while paused. A clip change is `setActiveClip`'s, in the overlay.
	const lastActiveClipIdRef = useRef<string | null>(null);

	useEffect(() => {
		if (!active || sourceTimeSec === null || !activeClipId) {
			return;
		}
		if (lastActiveClipIdRef.current !== activeClipId) {
			lastActiveClipIdRef.current = activeClipId;
			return;
		}
		if (!playing) {
			setNativeTime(sourceTimeSec);
		}
	}, [active, playing, activeClipId, sourceTimeSec]);
}
