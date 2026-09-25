import type {
	CursorTelemetryPoint,
	Rotation3D,
	ZoomFocus,
	ZoomRegion,
} from "@/components/video-editor/types";
import {
	DEFAULT_ROTATION_3D,
	getRotation3D,
	getZoomScale,
	lerpRotation3D,
} from "@/components/video-editor/types";
import { type SpeedRegion, screenTimeMs } from "@/lib/ai-edition/timeline/speed";
import { clamp01 } from "@/utils/math";
import { ZOOM_TRANSITION_BASE_MS, ZOOM_TRANSITION_PER_LN_MS } from "./constants";
import { interpolateCursorAt } from "./cursorFollowUtils";
import { clampFocusToScale } from "./focusUtils";
import { cubicBezier, easeSpring, scaleLerp } from "./mathUtils";

const CHAINED_ZOOM_PAN_GAP_MS = 1500;
const CONNECTED_ZOOM_PAN_DURATION_MS = 1000;

/** Timeline ms → screen ms. Transition windows are measured on it, see `screenTimeMs`. */
type ScreenClock = (timeMs: number) => number;

const sameTime: ScreenClock = (timeMs) => timeMs;

type DominantRegionOptions = {
	connectZooms?: boolean;
	cursorTelemetry?: CursorTelemetryPoint[];
	viewportRatio?: ViewportRatio;
	/** The timeline's speed regions: transitions keep their on-screen duration inside them. */
	speedRegions?: SpeedRegion[];
};

type ConnectedRegionPair = {
	currentRegion: ZoomRegion;
	nextRegion: ZoomRegion;
	/** Screen ms, like the gap that chains the pair. */
	transitionStart: number;
	transitionEnd: number;
};

type ConnectedPanTransition = {
	progress: number;
	startFocus: ZoomFocus;
	endFocus: ZoomFocus;
	startScale: number;
	endScale: number;
};

function lerp(start: number, end: number, amount: number) {
	return start + (end - start) * amount;
}

function easeConnectedPan(value: number) {
	return cubicBezier(0.1, 0.0, 0.2, 1.0, value);
}

// The zoom lands exactly on `startMs` and leaves from `endMs`; both moves last longer for a
// deeper zoom. The windows are measured on the screen clock, so a transition keeps its
// on-screen duration inside a speed region while the hold between them still flies through
// with the footage it covers. Mirror of `zoom_region_strength` (crates/compositor/src/regions.rs).
export function computeRegionStrength(
	region: ZoomRegion,
	timeMs: number,
	toScreen: ScreenClock = sameTime,
): number {
	const start = toScreen(region.startMs);
	const end = toScreen(region.endMs);
	const t = toScreen(timeMs);
	const window =
		ZOOM_TRANSITION_BASE_MS +
		ZOOM_TRANSITION_PER_LN_MS * Math.log(Math.max(1, getZoomScale(region)));

	if (t < start - window || t > end + window) {
		return 0;
	}

	if (t < start) {
		return easeSpring((t - (start - window)) / window);
	}

	if (t <= end) {
		return 1;
	}

	return 1 - easeSpring((t - end) / window);
}

function getLinearFocus(start: ZoomFocus, end: ZoomFocus, amount: number): ZoomFocus {
	return {
		cx: lerp(start.cx, end.cx, amount),
		cy: lerp(start.cy, end.cy, amount),
	};
}

interface ViewportRatio {
	widthRatio: number;
	heightRatio: number;
}

function getResolvedFocus(
	region: ZoomRegion,
	zoomScale: number,
	timeMs?: number,
	cursorTelemetry?: CursorTelemetryPoint[],
	viewportRatio?: ViewportRatio,
): ZoomFocus {
	let focus = region.focus;

	if (
		region.focusMode === "auto" &&
		cursorTelemetry &&
		cursorTelemetry.length > 0 &&
		timeMs !== undefined
	) {
		const cursorFocus = interpolateCursorAt(cursorTelemetry, timeMs);
		if (cursorFocus) {
			focus = cursorFocus;
		}
	}

	return clampFocusToScale(focus, zoomScale, viewportRatio);
}

function getConnectedRegionPairs(regions: ZoomRegion[], toScreen: ScreenClock) {
	const sortedRegions = [...regions].sort((a, b) => a.startMs - b.startMs);
	const pairs: ConnectedRegionPair[] = [];

	for (let index = 0; index < sortedRegions.length - 1; index += 1) {
		const currentRegion = sortedRegions[index];
		const nextRegion = sortedRegions[index + 1];
		const transitionStart = toScreen(currentRegion.endMs);
		const gapMs = toScreen(nextRegion.startMs) - transitionStart;

		if (gapMs > CHAINED_ZOOM_PAN_GAP_MS) {
			continue;
		}

		pairs.push({
			currentRegion,
			nextRegion,
			transitionStart,
			transitionEnd: transitionStart + CONNECTED_ZOOM_PAN_DURATION_MS,
		});
	}

	return pairs;
}

function getActiveRegion(
	regions: ZoomRegion[],
	timeMs: number,
	connectedPairs: ConnectedRegionPair[],
	toScreen: ScreenClock,
	cursorTelemetry?: CursorTelemetryPoint[],
	viewportRatio?: ViewportRatio,
) {
	const screenMs = toScreen(timeMs);
	const activeRegions = regions
		.map((region) => {
			const outgoingPair = connectedPairs.find((pair) => pair.currentRegion.id === region.id);
			if (outgoingPair && timeMs > outgoingPair.currentRegion.endMs) {
				return { region, strength: 0 };
			}

			const incomingPair = connectedPairs.find((pair) => pair.nextRegion.id === region.id);
			if (incomingPair && screenMs < incomingPair.transitionEnd) {
				return { region, strength: 0 };
			}

			return { region, strength: computeRegionStrength(region, timeMs, toScreen) };
		})
		.filter((entry) => entry.strength > 0)
		.sort((left, right) => {
			if (right.strength !== left.strength) {
				return right.strength - left.strength;
			}

			return right.region.startMs - left.region.startMs;
		});

	if (activeRegions.length === 0) {
		return null;
	}

	const activeRegion = activeRegions[0].region;
	const activeScale = getZoomScale(activeRegion);

	return {
		region: {
			...activeRegion,
			focus: getResolvedFocus(activeRegion, activeScale, timeMs, cursorTelemetry, viewportRatio),
		},
		strength: activeRegions[0].strength,
		blendedScale: null,
		rotation3D: getRotation3D(activeRegion),
	};
}

function getConnectedRegionHold(
	timeMs: number,
	screenMs: number,
	connectedPairs: ConnectedRegionPair[],
	cursorTelemetry?: CursorTelemetryPoint[],
	viewportRatio?: ViewportRatio,
) {
	for (const pair of connectedPairs) {
		if (screenMs > pair.transitionEnd && timeMs < pair.nextRegion.startMs) {
			const nextScale = getZoomScale(pair.nextRegion);
			return {
				region: {
					...pair.nextRegion,
					focus: getResolvedFocus(
						pair.nextRegion,
						nextScale,
						timeMs,
						cursorTelemetry,
						viewportRatio,
					),
				},
				strength: 1,
				blendedScale: null,
				rotation3D: getRotation3D(pair.nextRegion),
			};
		}
	}

	return null;
}

function getConnectedRegionTransition(
	connectedPairs: ConnectedRegionPair[],
	timeMs: number,
	screenMs: number,
	cursorTelemetry?: CursorTelemetryPoint[],
	viewportRatio?: ViewportRatio,
) {
	for (const pair of connectedPairs) {
		const { currentRegion, nextRegion, transitionStart, transitionEnd } = pair;

		if (screenMs < transitionStart || screenMs > transitionEnd) {
			continue;
		}

		const transitionProgress = easeConnectedPan(
			clamp01((screenMs - transitionStart) / Math.max(1, transitionEnd - transitionStart)),
		);
		const currentScale = getZoomScale(currentRegion);
		const nextScale = getZoomScale(nextRegion);
		const transitionScale = scaleLerp(currentScale, nextScale, transitionProgress);
		// Both regions share the same timeMs, so interpolate cursor once and reuse.
		const sharedCursorFocus =
			cursorTelemetry && cursorTelemetry.length > 0
				? interpolateCursorAt(cursorTelemetry, timeMs)
				: null;
		const currentFocus = clampFocusToScale(
			currentRegion.focusMode === "auto" && sharedCursorFocus
				? sharedCursorFocus
				: currentRegion.focus,
			currentScale,
			viewportRatio,
		);
		const nextFocus = clampFocusToScale(
			nextRegion.focusMode === "auto" && sharedCursorFocus ? sharedCursorFocus : nextRegion.focus,
			nextScale,
			viewportRatio,
		);
		const transitionFocus = getLinearFocus(currentFocus, nextFocus, transitionProgress);
		const transitionRotation = lerpRotation3D(
			getRotation3D(currentRegion),
			getRotation3D(nextRegion),
			transitionProgress,
		);

		return {
			region: {
				...nextRegion,
				focus: transitionFocus,
			},
			strength: 1,
			blendedScale: transitionScale,
			rotation3D: transitionRotation,
			transition: {
				progress: transitionProgress,
				startFocus: currentFocus,
				endFocus: nextFocus,
				startScale: currentScale,
				endScale: nextScale,
			},
		};
	}

	return null;
}

type DominantRegionResult = {
	region: ZoomRegion | null;
	strength: number;
	blendedScale: number | null;
	rotation3D: Rotation3D;
	transition: ConnectedPanTransition | null;
};

// Single-slot cache: the ticker calls findDominantRegion at 60fps with mostly
// unchanged inputs (especially while paused), so reusing the last result skips
// the per-frame O(N) scan and allocations.
let dominantRegionCache: {
	regions: ZoomRegion[];
	timeMsKey: number;
	speedRegions: SpeedRegion[] | undefined;
	telemetry: CursorTelemetryPoint[] | undefined;
	connectZooms: boolean;
	viewportRatio: ViewportRatio | undefined;
	result: DominantRegionResult;
} | null = null;

export function findDominantRegion(
	regions: ZoomRegion[],
	timeMs: number,
	options: DominantRegionOptions = {},
): DominantRegionResult {
	const connectZooms = !!options.connectZooms;
	const telemetry = options.cursorTelemetry;
	const vr = options.viewportRatio;
	const speedRegions = options.speedRegions;
	const timeMsKey = Math.round(timeMs);

	if (
		dominantRegionCache &&
		dominantRegionCache.regions === regions &&
		dominantRegionCache.timeMsKey === timeMsKey &&
		dominantRegionCache.speedRegions === speedRegions &&
		dominantRegionCache.telemetry === telemetry &&
		dominantRegionCache.connectZooms === connectZooms &&
		dominantRegionCache.viewportRatio === vr
	) {
		return dominantRegionCache.result;
	}

	const toScreen: ScreenClock = speedRegions?.length
		? (ms) => screenTimeMs(speedRegions, ms)
		: sameTime;
	const screenMs = toScreen(timeMs);
	const connectedPairs = connectZooms ? getConnectedRegionPairs(regions, toScreen) : [];

	let result: DominantRegionResult;
	if (connectZooms) {
		const connectedTransition = getConnectedRegionTransition(
			connectedPairs,
			timeMs,
			screenMs,
			telemetry,
			vr,
		);
		if (connectedTransition) {
			result = connectedTransition;
		} else {
			const connectedHold = getConnectedRegionHold(timeMs, screenMs, connectedPairs, telemetry, vr);
			if (connectedHold) {
				result = { ...connectedHold, transition: null };
			} else {
				const activeRegion = getActiveRegion(
					regions,
					timeMs,
					connectedPairs,
					toScreen,
					telemetry,
					vr,
				);
				result = activeRegion
					? { ...activeRegion, transition: null }
					: {
							region: null,
							strength: 0,
							blendedScale: null,
							rotation3D: DEFAULT_ROTATION_3D,
							transition: null,
						};
			}
		}
	} else {
		const activeRegion = getActiveRegion(regions, timeMs, connectedPairs, toScreen, telemetry, vr);
		result = activeRegion
			? { ...activeRegion, transition: null }
			: {
					region: null,
					strength: 0,
					blendedScale: null,
					rotation3D: DEFAULT_ROTATION_3D,
					transition: null,
				};
	}

	dominantRegionCache = {
		regions,
		timeMsKey,
		speedRegions,
		telemetry,
		connectZooms,
		viewportRatio: vr,
		result,
	};

	return result;
}
