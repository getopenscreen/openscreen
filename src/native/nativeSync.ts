/**
 * Where the native preview view is, against where the app's playhead is.
 *
 * While playing, the view runs its own clock and crosses clip boundaries by itself, so the
 * app does not drive it frame by frame. It used to guess whether the view had drifted from
 * the wall clock, assuming 1× speed: inside a 2× speed region the guess was 100 ms off every
 * 100 ms, and the view was re-seeked ten times a second. Each frame now says where the view
 * really is (`clipIndex`, `sourceTimeSec`), and this compares that with the playhead on the
 * one timeline both share: programme time, the trim-compressed one, where a cut is no jump.
 */

/** A segment of the trim-compressed programme, as `resolveVisibleClips` lays them out. */
export interface ProgrammeSegment {
	timelineStartSec: number;
	sourceStartSec: number;
}

/** Where a frame is: the active clip in the scene and the frame's time in its source file. */
export interface NativePosition {
	clipIndex: number;
	sourceTimeSec: number;
}

/** The position the view last reported, and when it reached the renderer. */
export interface ReportedNativePosition extends NativePosition {
	receivedAtMs: number;
}

/** Beyond this the picture is visibly off the sound: re-anchor the view. Lip sync is noticed
 *  from ~45 ms when the picture leads and ~125 ms when it lags (ITU-R BT.1359); frames reach
 *  the renderer up to a frame or two late, so a tighter bound would chase measurement noise. */
export const NATIVE_DRIFT_TOLERANCE_SEC = 0.15;
/** The gap must hold this long: right at a cut the view and the playhead cross it a frame or
 *  two apart, and a scene edit re-indexes the clips for a frame before both agree again. */
export const NATIVE_DRIFT_PERSIST_MS = 100;
/** After a re-anchor the view needs a seek and a first frame before it reports the new place. */
export const NATIVE_RESYNC_COOLDOWN_MS = 500;

/** `sourceTimeSec` of segment `clipIndex`, on the programme timeline. `null` for a segment the
 *  layout does not have (the scene and the document briefly disagree after an edit). */
export function programmeTimeSec(
	segments: readonly ProgrammeSegment[],
	position: NativePosition,
): number | null {
	const segment = segments[position.clipIndex];
	if (!segment) {
		return null;
	}
	return segment.timelineStartSec + (position.sourceTimeSec - segment.sourceStartSec);
}

/** How far ahead of the playhead the view is now, in programme seconds (negative: behind).
 *  Its last frame is aged by the wall time since it arrived. `null` when either position
 *  cannot be placed. */
export function nativeLeadSec(
	native: ReportedNativePosition | null,
	app: NativePosition,
	segments: readonly ProgrammeSegment[],
	nowMs: number,
): number | null {
	if (!native) {
		return null;
	}
	const nativeSec = programmeTimeSec(segments, native);
	const appSec = programmeTimeSec(segments, app);
	if (nativeSec === null || appSec === null) {
		return null;
	}
	return nativeSec + Math.max(0, nowMs - native.receivedAtMs) / 1000 - appSec;
}

export interface DriftWatch {
	/** Since when the view has been out of tolerance, `null` while it is in. */
	outSinceMs: number | null;
	lastResyncMs: number;
}

export const IDLE_DRIFT_WATCH: DriftWatch = {
	outSinceMs: null,
	lastResyncMs: Number.NEGATIVE_INFINITY,
};

/** Whether to re-anchor the view now, given its lead. Only for a gap that holds, and not again
 *  before the last re-anchor has had time to land. */
export function watchDrift(
	watch: DriftWatch,
	leadSec: number | null,
	nowMs: number,
): { watch: DriftWatch; resync: boolean } {
	if (leadSec === null || Math.abs(leadSec) <= NATIVE_DRIFT_TOLERANCE_SEC) {
		return { watch: { ...watch, outSinceMs: null }, resync: false };
	}
	const outSinceMs = watch.outSinceMs ?? nowMs;
	if (
		nowMs - outSinceMs < NATIVE_DRIFT_PERSIST_MS ||
		nowMs - watch.lastResyncMs < NATIVE_RESYNC_COOLDOWN_MS
	) {
		return { watch: { ...watch, outSinceMs }, resync: false };
	}
	return { watch: { outSinceMs: null, lastResyncMs: nowMs }, resync: true };
}

let reported: ReportedNativePosition | null = null;

/** Records where the view's latest frame is, as it reaches the renderer. `null` forgets it: the
 *  view is gone, or its addon predates positions — then nothing here may steer it. */
export function publishNativePosition(
	position: Partial<NativePosition> | null | undefined,
	receivedAtMs = performance.now(),
): void {
	reported =
		position && typeof position.clipIndex === "number" && typeof position.sourceTimeSec === "number"
			? { clipIndex: position.clipIndex, sourceTimeSec: position.sourceTimeSec, receivedAtMs }
			: null;
}

/** The position the view last reported, `null` before its first frame or without one. */
export function getNativePosition(): ReportedNativePosition | null {
	return reported;
}
