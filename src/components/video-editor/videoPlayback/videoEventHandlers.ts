import type React from "react";
import { MAX_NATIVE_PLAYBACK_RATE, type SpeedRegion, type TrimRegion } from "../types";
import { createRafCoalescer } from "./rafCoalescer";

// Keep "scrub mode" on for a brief tail after `seeked`: rapid drag-scrubbing fires
// `seeking`/`seeked` dozens of times a second and toggling effects each time would flicker.
const SCRUB_END_DEBOUNCE_MS = 150;
// When seek-stepping crosses a speed region's end, land this far past it so the next
// frame's `currentTimeMs < endMs` check exits the region. A plain clamp to endMs/1000
// can stall: (endMs/1000)*1000 may read back below endMs. 0.5 ms is imperceptible and
// dominates any floating-point round-trip error.
const REGION_EXIT_MARGIN_SEC = 0.0005;
// Minimum forward distance (seconds) before seek-stepping issues a seek, so a no-op
// seek to the element's current position never arms the in-flight throttle.
const STEP_MIN_SEEK_SEC = 0.01;
// Recover the throttle if a step seek never reports `seeked` (e.g. seeking past a
// non-finite-duration source's buffered end) rather than freezing for the session.
const STEP_SEEK_TIMEOUT_MS = 500;

interface VideoEventHandlersParams {
	video: HTMLVideoElement;
	isSeekingRef: React.MutableRefObject<boolean>;
	isPlayingRef: React.MutableRefObject<boolean>;
	allowPlaybackRef: React.MutableRefObject<boolean>;
	currentTimeRef: React.MutableRefObject<number>;
	timeUpdateAnimationRef: React.MutableRefObject<number | null>;
	onPlayStateChange: (playing: boolean) => void;
	onTimeUpdate: (time: number) => void;
	trimRegionsRef: React.MutableRefObject<TrimRegion[]>;
	speedRegionsRef: React.MutableRefObject<SpeedRegion[]>;
	isScrubbingRef?: React.MutableRefObject<boolean>;
	scrubEndTimerRef?: React.MutableRefObject<number | null>;
	onScrubChange?: (scrubbing: boolean) => void;
	// Seek-stepping state for speed regions above the native playbackRate cap (16×):
	// the element can't play that fast, so the rAF loop advances a virtual clock and
	// forward-seeks the muted element to it each frame.
	seekSteppingRef: React.MutableRefObject<boolean>;
	stepVirtualSecRef: React.MutableRefObject<number>;
	stepLastTsRef: React.MutableRefObject<number>;
	stepPrevMutedRef: React.MutableRefObject<boolean>;
}

export function createVideoEventHandlers(params: VideoEventHandlersParams) {
	const {
		video,
		isSeekingRef,
		isPlayingRef,
		allowPlaybackRef,
		currentTimeRef,
		timeUpdateAnimationRef,
		onPlayStateChange,
		onTimeUpdate,
		trimRegionsRef,
		speedRegionsRef,
		isScrubbingRef,
		scrubEndTimerRef,
		onScrubChange,
		seekSteppingRef,
		stepVirtualSecRef,
		stepLastTsRef,
		stepPrevMutedRef,
	} = params;

	// True while a seek-stepping forward seek is in flight (cleared by its `seeked`).
	// Prevents issuing the next seek before the element has presented the current
	// frame — seeking every rAF frame keeps a slow decoder perpetually mid-seek so
	// the preview freezes. Local to the handler set (recreated when the video rewires).
	let stepSeekInFlight = false;
	let stepSeekIssuedAtMs = 0;
	// One-shot: suppress scrub-mode for the internal catch-up seek issued when stepping
	// hands back to native playback (that seek must not soften the preview / snap effects).
	let suppressSeekScrubOnce = false;

	const clearScrubEndTimer = () => {
		if (scrubEndTimerRef && scrubEndTimerRef.current !== null) {
			window.clearTimeout(scrubEndTimerRef.current);
			scrubEndTimerRef.current = null;
		}
	};

	// currentTimeRef is updated synchronously on every call (cheap; other imperative
	// consumers like the Pixi renderer read it directly). The React state commit
	// (`onTimeUpdate`) is coalesced to at most once per animation frame so a burst of
	// `seeking` events (fast timeline drag) or the per-frame rAF playback loop can't
	// force more than one parent re-render per frame.
	const timeUpdateCoalescer = createRafCoalescer<number>(onTimeUpdate);

	const emitTime = (timeValue: number) => {
		currentTimeRef.current = timeValue * 1000;
		timeUpdateCoalescer.schedule(timeValue);
	};

	const findActiveTrimRegion = (currentTimeMs: number): TrimRegion | null => {
		const trimRegions = trimRegionsRef.current;
		return (
			trimRegions.find(
				(region) => currentTimeMs >= region.startMs && currentTimeMs < region.endMs,
			) || null
		);
	};

	const findActiveSpeedRegion = (currentTimeMs: number): SpeedRegion | null => {
		return (
			speedRegionsRef.current.find(
				(region) => currentTimeMs >= region.startMs && currentTimeMs < region.endMs,
			) || null
		);
	};

	// Enter seek-stepping: mute the element, cap its rate to the native ceiling, and
	// seed the virtual clock from the current position. The element keeps "playing"
	// (paused would tear the rAF loop down) but every frame we override its time.
	const beginSeekStepping = (fromSec: number, nowMs: number) => {
		stepVirtualSecRef.current = fromSec;
		stepLastTsRef.current = nowMs;
		stepPrevMutedRef.current = video.muted;
		video.muted = true;
		// Clear any real/trim seek that was still pending when stepping began — our
		// per-frame step-seeks are suppressed in handleSeeked, so its `seeked` would
		// otherwise never run and isSeekingRef would strand true (blocking the next play).
		isSeekingRef.current = false;
		try {
			video.playbackRate = MAX_NATIVE_PLAYBACK_RATE;
		} catch {
			/* some elements reject rate changes mid-seek; the forward seek still drives time */
		}
		stepSeekInFlight = false;
		seekSteppingRef.current = true;
	};

	// Leave seek-stepping and restore the element's prior mute state so native
	// playback (≤16×) resumes with sound.
	const endSeekStepping = () => {
		if (!seekSteppingRef.current) return;
		seekSteppingRef.current = false;
		video.muted = stepPrevMutedRef.current;
	};

	function updateTime(now?: number) {
		if (!video) return;

		const nowMs = now ?? performance.now();
		// While stepping, the virtual clock — not the lagging element time — is the
		// authority for which region is active and where the playhead sits.
		const authoritativeSec = seekSteppingRef.current
			? stepVirtualSecRef.current
			: video.currentTime;
		const currentTimeMs = authoritativeSec * 1000;
		const activeTrimRegion = findActiveTrimRegion(currentTimeMs);

		// In a trim region during playback: skip to its end
		if (activeTrimRegion && !video.paused && !video.ended) {
			const skipToTime = activeTrimRegion.endMs / 1000;

			// Pause if the skip would run past the end
			if (skipToTime >= video.duration) {
				endSeekStepping();
				video.pause();
			} else {
				video.currentTime = skipToTime;
				if (seekSteppingRef.current) {
					stepVirtualSecRef.current = skipToTime;
					stepLastTsRef.current = nowMs;
					stepSeekInFlight = false;
				}
				emitTime(skipToTime);
			}
		} else {
			const activeSpeedRegion = findActiveSpeedRegion(currentTimeMs);
			const speed = activeSpeedRegion ? activeSpeedRegion.speed : 1;

			if (speed <= MAX_NATIVE_PLAYBACK_RATE) {
				// Native path (unchanged for ≤16×): let the element play at `speed`.
				if (seekSteppingRef.current) {
					endSeekStepping();
					// Snap the (possibly seek-lagged) element up to the virtual playhead so
					// native playback resumes exactly where the playhead is, no backward jump.
					// Flag it so the async seeking/seeked don't flip on scrub mode (which would
					// soften the preview and snap effects for ~150ms at the boundary).
					if (Math.abs(video.currentTime - stepVirtualSecRef.current) > STEP_MIN_SEEK_SEC) {
						suppressSeekScrubOnce = true;
						video.currentTime = stepVirtualSecRef.current;
					}
				}
				video.playbackRate = speed;
				emitTime(video.currentTime);
			} else {
				// Seek-stepping: advance a virtual clock at the true speed and yank the
				// muted element forward to it each frame.
				if (!seekSteppingRef.current) beginSeekStepping(video.currentTime, nowMs);
				const dtSec = Math.max(0, (nowMs - stepLastTsRef.current) / 1000);
				stepLastTsRef.current = nowMs;
				// A non-finite duration (some WebM sources report Infinity until fully
				// buffered) is not an end boundary — keep stepping until the region exits.
				const endSec = Number.isFinite(video.duration) ? video.duration : Number.POSITIVE_INFINITY;
				// Bound the advance to the active region so a fast frame doesn't overshoot
				// far into the next region and skip its content — but land just *past* the
				// end (not exactly on it) so the region is actually exited next frame.
				const regionEndSec = activeSpeedRegion ? activeSpeedRegion.endMs / 1000 : endSec;
				const rawNextSec = stepVirtualSecRef.current + speed * dtSec;
				const nextSec = Math.min(
					rawNextSec > regionEndSec ? regionEndSec + REGION_EXIT_MARGIN_SEC : rawNextSec,
					endSec,
				);

				if (nextSec >= endSec) {
					stepVirtualSecRef.current = endSec;
					video.currentTime = endSec;
					emitTime(endSec);
					endSeekStepping();
					video.pause();
					return;
				}
				stepVirtualSecRef.current = nextSec;
				// The playhead advances at the true speed every frame; the muted element
				// is seeked toward it only when the previous seek has landed (its `seeked`
				// fired), so a slow decoder still presents/steps frames instead of freezing
				// perpetually mid-seek. Require a real forward jump so a no-op seek (e.g. the
				// first frame, where dt≈0) can't leave the in-flight flag stuck with no `seeked`.
				// Recover if a prior seek never reported `seeked` (would otherwise strand the
				// throttle and freeze the frame for the rest of the session).
				if (stepSeekInFlight && nowMs - stepSeekIssuedAtMs > STEP_SEEK_TIMEOUT_MS) {
					stepSeekInFlight = false;
				}
				if (!stepSeekInFlight && nextSec - video.currentTime > STEP_MIN_SEEK_SEC) {
					stepSeekInFlight = true;
					stepSeekIssuedAtMs = nowMs;
					video.currentTime = nextSec;
				}
				emitTime(nextSec);
			}
		}

		if (!video.paused && !video.ended) {
			timeUpdateAnimationRef.current = requestAnimationFrame(updateTime);
		}
	}

	const handlePlay = () => {
		if (isSeekingRef.current) {
			video.pause();
			return;
		}

		if (!allowPlaybackRef.current) {
			video.pause();
			return;
		}

		isPlayingRef.current = true;
		onPlayStateChange(true);
		if (timeUpdateAnimationRef.current) {
			cancelAnimationFrame(timeUpdateAnimationRef.current);
		}
		timeUpdateAnimationRef.current = requestAnimationFrame(updateTime);
	};

	const handlePause = () => {
		endSeekStepping();
		isPlayingRef.current = false;
		onPlayStateChange(false);
		if (timeUpdateAnimationRef.current) {
			cancelAnimationFrame(timeUpdateAnimationRef.current);
			timeUpdateAnimationRef.current = null;
		}
		emitTime(video.currentTime);
	};

	const handleSeeked = () => {
		// Our own stepping seek landed (frame presented): allow the next one, then
		// ignore the event — the rAF loop is the sole time authority while stepping.
		if (seekSteppingRef.current) {
			stepSeekInFlight = false;
			return;
		}
		isSeekingRef.current = false;

		if (isScrubbingRef && scrubEndTimerRef) {
			clearScrubEndTimer();
			scrubEndTimerRef.current = window.setTimeout(() => {
				isScrubbingRef.current = false;
				scrubEndTimerRef.current = null;
				onScrubChange?.(false);
			}, SCRUB_END_DEBOUNCE_MS);
		}

		const currentTimeMs = video.currentTime * 1000;
		const activeTrimRegion = findActiveTrimRegion(currentTimeMs);

		// Seeked into a trim region while playing: skip to the end
		if (activeTrimRegion && isPlayingRef.current && !video.paused) {
			const skipToTime = activeTrimRegion.endMs / 1000;

			if (skipToTime >= video.duration) {
				video.pause();
			} else {
				video.currentTime = skipToTime;
				emitTime(skipToTime);
			}
		} else {
			if (!isPlayingRef.current && !video.paused) {
				video.pause();
			}
			emitTime(video.currentTime);
		}
	};

	const handleSeeking = () => {
		// Our per-frame forward seeks must not flip the element into scrub mode
		// (which would disable zoom/blur effects every frame during stepping).
		// Known limitation: while a >16× region is actively playing, the virtual clock
		// owns the playhead, so scrubbing mid-playback is overridden on the next frame —
		// pause first to reposition. (Distinguishing a user scrub from our own large
		// async forward seeks reliably isn't feasible, so we don't try.)
		if (seekSteppingRef.current) return;
		// The internal catch-up seek on stepping->native handback must not enter scrub.
		if (suppressSeekScrubOnce) {
			suppressSeekScrubOnce = false;
			return;
		}
		isSeekingRef.current = true;

		if (isScrubbingRef) {
			clearScrubEndTimer();
			if (!isScrubbingRef.current) {
				isScrubbingRef.current = true;
				onScrubChange?.(true);
			}
		}

		if (!isPlayingRef.current && !video.paused) {
			video.pause();
		}
		emitTime(video.currentTime);
	};

	return {
		handlePlay,
		handlePause,
		handleSeeked,
		handleSeeking,
		dispose: () => timeUpdateCoalescer.cancel(),
	};
}
