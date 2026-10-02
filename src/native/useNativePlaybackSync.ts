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
 * position each native frame reports (`nativeSync.ts`). This hook only guesses the drift
 * from the wall clock at 1× speed for an addon that reports no position: the guess
 * re-seeked the view ten times a second inside a 2× speed region.
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
import { getNativePosition } from "./nativeSync";

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

	// Scrub/step while paused, and drift while playing for an addon that reports no position.
	// A clip change is `setActiveClip`'s, in the overlay.
	const lastSyncedSourceTimeRef = useRef<number | null>(null);
	const lastSyncedWallTimeRef = useRef<number>(0);
	const lastActiveClipIdRef = useRef<string | null>(null);

	useEffect(() => {
		if (!active || sourceTimeSec === null || !activeClipId) {
			return;
		}
		const now = performance.now();
		if (lastActiveClipIdRef.current !== activeClipId) {
			lastActiveClipIdRef.current = activeClipId;
			lastSyncedSourceTimeRef.current = sourceTimeSec;
			lastSyncedWallTimeRef.current = now;
			return;
		}
		if (!playing) {
			setNativeTime(sourceTimeSec);
			lastSyncedSourceTimeRef.current = sourceTimeSec;
			lastSyncedWallTimeRef.current = now;
			return;
		}
		if (getNativePosition() !== null) {
			return;
		}
		if (lastSyncedSourceTimeRef.current === null || lastSyncedWallTimeRef.current === 0) {
			lastSyncedSourceTimeRef.current = sourceTimeSec;
			lastSyncedWallTimeRef.current = now;
			return;
		}
		const wallElapsedSec = (now - lastSyncedWallTimeRef.current) / 1000;
		const expectedSourceTimeSec = lastSyncedSourceTimeRef.current + wallElapsedSec;
		if (Math.abs(sourceTimeSec - expectedSourceTimeSec) > 0.1) {
			setNativeTime(sourceTimeSec);
			lastSyncedSourceTimeRef.current = sourceTimeSec;
			lastSyncedWallTimeRef.current = now;
		}
	}, [active, playing, activeClipId, sourceTimeSec]);
}
