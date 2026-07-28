export const CURSOR_MOTION_PRESETS = [
	"recorded",
	"straight",
	"arc",
	"wave",
	"loop",
	"overshoot",
] as const;

export type CursorMotionPreset = (typeof CURSOR_MOTION_PRESETS)[number];

export const CURSOR_MOTION_EASINGS = ["linear", "ease-in-out", "ease-in", "ease-out"] as const;

export type CursorMotionEasing = (typeof CURSOR_MOTION_EASINGS)[number];

export interface CursorMotionPoint {
	cx: number;
	cy: number;
}

export const CURSOR_MOTION_ANCHOR_KINDS = ["manual", "rest", "click"] as const;

export type CursorMotionAnchorKind = (typeof CURSOR_MOTION_ANCHOR_KINDS)[number];

export const CURSOR_MOTION_SEGMENT_KINDS = ["move", "hold"] as const;

export type CursorMotionSegmentKind = (typeof CURSOR_MOTION_SEGMENT_KINDS)[number];

export interface CursorMotionTelemetrySample extends CursorMotionPoint {
	timeMs: number;
	visible?: boolean;
	interactionType?: string | null;
}

export interface CursorMotionSegmentDefinition {
	startMs: number;
	endMs: number;
	startPoint: CursorMotionPoint;
	endPoint: CursorMotionPoint;
	startAnchorKind: CursorMotionAnchorKind;
	endAnchorKind: CursorMotionAnchorKind;
	segmentKind: CursorMotionSegmentKind;
}

export interface CursorMotionRegion {
	id: string;
	startMs: number;
	endMs: number;
	startPoint?: CursorMotionPoint;
	endPoint?: CursorMotionPoint;
	startAnchorKind?: CursorMotionAnchorKind;
	endAnchorKind?: CursorMotionAnchorKind;
	segmentKind?: CursorMotionSegmentKind;
	preset: CursorMotionPreset;
	controlPoint: CursorMotionPoint;
	cycles: number;
	speed: number;
	easing: CursorMotionEasing;
}

export interface CursorMotionPath {
	sampleAt(timeMs: number): CursorMotionPoint | null;
}

const MIN_CYCLES = 1;
const MAX_CYCLES = 6;
export const CURSOR_MOTION_SPEED_MIN = 1;
export const CURSOR_MOTION_SPEED_MAX = 4;
export const DEFAULT_CURSOR_MOTION_SPEED = 1;
export const CURSOR_MOTION_SPEED_PRESETS = [1, 1.5, 2, 3, 4] as const;
const REST_MIN_DURATION_MS = 300;
const REST_MAX_DIAMETER = 0.009;
const REST_MAX_SAMPLE_GAP_MS = 150;
const HOLD_MAX_DISTANCE = 0.012;
const MIN_SEGMENT_DURATION_MS = 2;

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}

export function clampCursorMotionPoint(point: CursorMotionPoint): CursorMotionPoint {
	return {
		cx: clamp(Number.isFinite(point.cx) ? point.cx : 0.5, 0, 1),
		cy: clamp(Number.isFinite(point.cy) ? point.cy : 0.5, 0, 1),
	};
}

export function getCursorMotionSegmentKind(
	start: CursorMotionPoint,
	end: CursorMotionPoint,
): CursorMotionSegmentKind {
	return Math.hypot(end.cx - start.cx, end.cy - start.cy) <= HOLD_MAX_DISTANCE ? "hold" : "move";
}

export function clampCursorMotionCycles(cycles: number) {
	return clamp(Math.round(Number.isFinite(cycles) ? cycles : 1), MIN_CYCLES, MAX_CYCLES);
}

export function clampCursorMotionSpeed(speed: number | null | undefined) {
	const value = Number.isFinite(speed) ? Number(speed) : DEFAULT_CURSOR_MOTION_SPEED;
	return Math.round(clamp(value, CURSOR_MOTION_SPEED_MIN, CURSOR_MOTION_SPEED_MAX) * 10) / 10;
}

export function applyCursorMotionSpeed(progress: number, speed: number | null | undefined) {
	const t = clamp(progress, 0, 1);
	const multiplier = clampCursorMotionSpeed(speed);
	// Higher speeds advance immediately and settle near the destination sooner.
	// Do not create a leading frozen span: it made the cursor look broken and
	// hid most short moves at the default 2x setting.
	return clamp(1 - (1 - t) ** multiplier, 0, 1);
}

export function isCursorMotionPreset(value: unknown): value is CursorMotionPreset {
	return CURSOR_MOTION_PRESETS.includes(value as CursorMotionPreset);
}

export function isCursorMotionEasing(value: unknown): value is CursorMotionEasing {
	return CURSOR_MOTION_EASINGS.includes(value as CursorMotionEasing);
}

export function isCursorMotionAnchorKind(value: unknown): value is CursorMotionAnchorKind {
	return CURSOR_MOTION_ANCHOR_KINDS.includes(value as CursorMotionAnchorKind);
}

export function isCursorMotionSegmentKind(value: unknown): value is CursorMotionSegmentKind {
	return CURSOR_MOTION_SEGMENT_KINDS.includes(value as CursorMotionSegmentKind);
}

export function resolveCursorMotionClickAnchoredSpan(
	startMs: number,
	clickTimestamps: readonly number[],
): { startMs: number; endMs: number } | null {
	const safeStartMs = Math.max(0, Math.round(Number.isFinite(startMs) ? startMs : 0));
	const followingClick = clickTimestamps
		.filter((timeMs) => Number.isFinite(timeMs) && timeMs > safeStartMs + 1)
		.sort((a, b) => a - b)[0];
	if (followingClick === undefined) return null;
	return {
		startMs: safeStartMs,
		endMs: Math.max(safeStartMs + 1, Math.round(followingClick)),
	};
}

export function resolveCursorMotionClickAnchoredRange(
	startMs: number,
	clickTimestamps: readonly number[],
): { startMs: number; endMs: number } | null {
	const safeStartMs = Math.max(0, Math.round(Number.isFinite(startMs) ? startMs : 0));
	const followingClicks = clickTimestamps
		.filter((timeMs) => Number.isFinite(timeMs) && timeMs > safeStartMs + 1)
		.sort((a, b) => a - b);
	const finalClick = followingClicks.at(-1);
	if (finalClick === undefined) return null;
	return {
		startMs: safeStartMs,
		endMs: Math.max(safeStartMs + 1, Math.round(finalClick)),
	};
}

interface CursorMotionAnchor {
	timeMs: number;
	point: CursorMotionPoint;
	kind: CursorMotionAnchorKind;
}

interface CursorMotionRestSpan {
	startMs: number;
	endMs: number;
	point: CursorMotionPoint;
}

function isClickInteractionType(interactionType: string | null | undefined) {
	return (
		interactionType === "click" ||
		interactionType === "double-click" ||
		interactionType === "right-click" ||
		interactionType === "middle-click"
	);
}

function normalizeMotionSamples(
	samples: readonly CursorMotionTelemetrySample[],
	startMs: number,
	endMs: number,
) {
	return samples
		.filter(
			(sample) =>
				sample.visible !== false &&
				Number.isFinite(sample.timeMs) &&
				Number.isFinite(sample.cx) &&
				Number.isFinite(sample.cy) &&
				sample.timeMs >= startMs &&
				sample.timeMs <= endMs,
		)
		.map((sample) => ({
			...sample,
			timeMs: Math.round(sample.timeMs),
			...clampCursorMotionPoint(sample),
		}))
		.sort((a, b) => a.timeMs - b.timeMs);
}

function detectCursorMotionRestSpans(
	samples: readonly CursorMotionTelemetrySample[],
): CursorMotionRestSpan[] {
	const rests: CursorMotionRestSpan[] = [];
	let startIndex = 0;

	while (startIndex < samples.length - 1) {
		let endIndex = startIndex + 1;
		let minCx = samples[startIndex].cx;
		let maxCx = minCx;
		let minCy = samples[startIndex].cy;
		let maxCy = minCy;

		while (endIndex < samples.length) {
			const sample = samples[endIndex];
			if (sample.timeMs - samples[endIndex - 1].timeMs > REST_MAX_SAMPLE_GAP_MS) {
				break;
			}
			const nextMinCx = Math.min(minCx, sample.cx);
			const nextMaxCx = Math.max(maxCx, sample.cx);
			const nextMinCy = Math.min(minCy, sample.cy);
			const nextMaxCy = Math.max(maxCy, sample.cy);
			if (Math.hypot(nextMaxCx - nextMinCx, nextMaxCy - nextMinCy) > REST_MAX_DIAMETER) {
				break;
			}
			minCx = nextMinCx;
			maxCx = nextMaxCx;
			minCy = nextMinCy;
			maxCy = nextMaxCy;
			endIndex += 1;
		}

		const lastIndex = endIndex - 1;
		const start = samples[startIndex];
		const end = samples[lastIndex];
		if (end.timeMs - start.timeMs >= REST_MIN_DURATION_MS) {
			const run = samples.slice(startIndex, endIndex);
			const click = run.find((sample) => isClickInteractionType(sample.interactionType));
			const point = click
				? clampCursorMotionPoint(click)
				: clampCursorMotionPoint({
						cx: run.reduce((sum, sample) => sum + sample.cx, 0) / run.length,
						cy: run.reduce((sum, sample) => sum + sample.cy, 0) / run.length,
					});
			rests.push({ startMs: start.timeMs, endMs: end.timeMs, point });
			startIndex = endIndex;
		} else {
			startIndex += 1;
		}
	}

	return rests;
}

function anchorPriority(kind: CursorMotionAnchorKind) {
	if (kind === "click") return 3;
	if (kind === "rest") return 2;
	return 1;
}

function normalizeCursorMotionAnchors(anchors: CursorMotionAnchor[]) {
	const sorted = [...anchors].sort(
		(a, b) => a.timeMs - b.timeMs || anchorPriority(b.kind) - anchorPriority(a.kind),
	);
	const normalized: CursorMotionAnchor[] = [];
	for (const anchor of sorted) {
		const previous = normalized.at(-1);
		if (previous && Math.abs(previous.timeMs - anchor.timeMs) <= 1) {
			if (anchorPriority(anchor.kind) > anchorPriority(previous.kind)) {
				normalized[normalized.length - 1] = anchor;
			}
			continue;
		}
		normalized.push(anchor);
	}
	return normalized;
}

function nearestSamplePoint(
	samples: readonly CursorMotionTelemetrySample[],
	timeMs: number,
): CursorMotionPoint | null {
	let nearest: CursorMotionTelemetrySample | null = null;
	let nearestDistance = Number.POSITIVE_INFINITY;
	for (const sample of samples) {
		const distance = Math.abs(sample.timeMs - timeMs);
		if (distance < nearestDistance) {
			nearest = sample;
			nearestDistance = distance;
		}
	}
	return nearest ? clampCursorMotionPoint(nearest) : null;
}

export function buildCursorMotionSegments(options: {
	startMs: number;
	endMs: number;
	samples: readonly CursorMotionTelemetrySample[];
	path: CursorMotionPath | null | undefined;
}): CursorMotionSegmentDefinition[] {
	const startMs = Math.max(0, Math.round(options.startMs));
	const endMs = Math.max(startMs + 1, Math.round(options.endMs));
	const samples = normalizeMotionSamples(options.samples, startMs, endMs);
	if (samples.length === 0) return [];

	const startPoint = options.path?.sampleAt(startMs) ?? nearestSamplePoint(samples, startMs);
	const endClick = [...samples]
		.reverse()
		.find(
			(sample) =>
				isClickInteractionType(sample.interactionType) && Math.abs(sample.timeMs - endMs) <= 1,
		);
	const endPoint = endClick
		? clampCursorMotionPoint(endClick)
		: (options.path?.sampleAt(endMs) ?? nearestSamplePoint(samples, endMs));
	if (!startPoint || !endPoint) return [];

	const rests = detectCursorMotionRestSpans(samples);
	const anchors: CursorMotionAnchor[] = [
		{ timeMs: startMs, point: clampCursorMotionPoint(startPoint), kind: "manual" },
		{ timeMs: endMs, point: clampCursorMotionPoint(endPoint), kind: endClick ? "click" : "manual" },
	];

	for (const rest of rests) {
		anchors.push(
			{ timeMs: rest.startMs, point: rest.point, kind: "rest" },
			{ timeMs: rest.endMs, point: rest.point, kind: "rest" },
		);
	}
	for (const sample of samples) {
		if (!isClickInteractionType(sample.interactionType)) continue;
		const containingRest = rests.find(
			(rest) => sample.timeMs >= rest.startMs && sample.timeMs <= rest.endMs,
		);
		anchors.push({
			timeMs: sample.timeMs,
			point: containingRest?.point ?? clampCursorMotionPoint(sample),
			kind: "click",
		});
	}

	const normalizedAnchors = normalizeCursorMotionAnchors(anchors).filter(
		(anchor) => anchor.timeMs >= startMs && anchor.timeMs <= endMs,
	);
	const segments: CursorMotionSegmentDefinition[] = [];
	for (let index = 1; index < normalizedAnchors.length; index += 1) {
		const start = normalizedAnchors[index - 1];
		const end = normalizedAnchors[index];
		if (end.timeMs - start.timeMs < MIN_SEGMENT_DURATION_MS) continue;
		segments.push({
			startMs: start.timeMs,
			endMs: end.timeMs,
			startPoint: start.point,
			endPoint: end.point,
			startAnchorKind: start.kind,
			endAnchorKind: end.kind,
			segmentKind: getCursorMotionSegmentKind(start.point, end.point),
		});
	}

	return segments;
}

function lerp(a: number, b: number, progress: number) {
	return a + (b - a) * progress;
}

function easeProgress(progress: number, easing: CursorMotionEasing) {
	const t = clamp(progress, 0, 1);
	switch (easing) {
		case "ease-in":
			return t * t * t;
		case "ease-out":
			return 1 - (1 - t) ** 3;
		case "ease-in-out":
			return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
		default:
			return t;
	}
}

function easeOutBack(progress: number) {
	const c1 = 1.70158;
	const c3 = c1 + 1;
	const t = clamp(progress, 0, 1) - 1;
	return 1 + c3 * t ** 3 + c1 * t ** 2;
}

export function createDefaultCursorMotionControlPoint(
	start: CursorMotionPoint,
	end: CursorMotionPoint,
): CursorMotionPoint {
	const dx = end.cx - start.cx;
	const dy = end.cy - start.cy;
	const distance = Math.hypot(dx, dy);
	const normalX = distance > 0.0001 ? dy / distance : 0;
	const normalY = distance > 0.0001 ? -dx / distance : -1;
	const amplitude = clamp(distance * 0.35, 0.06, 0.18);
	return clampCursorMotionPoint({
		cx: (start.cx + end.cx) / 2 + normalX * amplitude,
		cy: (start.cy + end.cy) / 2 + normalY * amplitude,
	});
}

export function splitCursorMotionRegionAtTime(options: {
	region: CursorMotionRegion;
	splitMs: number;
	splitPoint: CursorMotionPoint;
	startPoint: CursorMotionPoint;
	endPoint: CursorMotionPoint;
	rightId: string;
}): [CursorMotionRegion, CursorMotionRegion] | null {
	const { region, rightId } = options;
	const splitMs = Math.round(options.splitMs);
	if (splitMs <= region.startMs + 1 || splitMs >= region.endMs - 1) return null;
	const splitPoint = clampCursorMotionPoint(options.splitPoint);
	const startPoint = clampCursorMotionPoint(options.startPoint);
	const endPoint = clampCursorMotionPoint(options.endPoint);
	const left: CursorMotionRegion = {
		...region,
		endMs: splitMs,
		endPoint: splitPoint,
		endAnchorKind: "manual",
		segmentKind: getCursorMotionSegmentKind(startPoint, splitPoint),
		controlPoint: createDefaultCursorMotionControlPoint(startPoint, splitPoint),
	};
	const right: CursorMotionRegion = {
		...region,
		id: rightId,
		startMs: splitMs,
		startPoint: splitPoint,
		startAnchorKind: "manual",
		segmentKind: getCursorMotionSegmentKind(splitPoint, endPoint),
		controlPoint: createDefaultCursorMotionControlPoint(splitPoint, endPoint),
	};
	return [left, right];
}

export function applyCursorMotionSettingsToMoveRegions(
	regions: readonly CursorMotionRegion[],
	source: CursorMotionRegion,
): CursorMotionRegion[] {
	return regions.map((region) =>
		region.segmentKind === "hold"
			? region
			: {
					...region,
					preset: source.preset,
					cycles: source.cycles,
					speed: source.speed,
					easing: source.easing,
				},
	);
}

export function sampleCursorMotionRegion(
	region: CursorMotionRegion,
	start: CursorMotionPoint,
	end: CursorMotionPoint,
	timeMs: number,
): CursorMotionPoint {
	const duration = Math.max(1, region.endMs - region.startMs);
	const rawProgress = clamp((timeMs - region.startMs) / duration, 0, 1);
	if (rawProgress === 0) return start;
	if (rawProgress === 1) return end;
	const motionProgress = applyCursorMotionSpeed(rawProgress, region.speed);
	if (motionProgress === 0) return start;
	const progress = easeProgress(motionProgress, region.easing);
	const midpoint = {
		cx: (start.cx + end.cx) / 2,
		cy: (start.cy + end.cy) / 2,
	};
	const offset = {
		cx: region.controlPoint.cx - midpoint.cx,
		cy: region.controlPoint.cy - midpoint.cy,
	};

	if (region.preset === "overshoot") {
		const overshootProgress = easeOutBack(progress);
		const envelope = Math.sin(Math.PI * motionProgress);
		return {
			cx: lerp(start.cx, end.cx, overshootProgress) + offset.cx * envelope * 0.35,
			cy: lerp(start.cy, end.cy, overshootProgress) + offset.cy * envelope * 0.35,
		};
	}

	const base = {
		cx: lerp(start.cx, end.cx, progress),
		cy: lerp(start.cy, end.cy, progress),
	};
	const envelope = Math.sin(Math.PI * motionProgress);
	const cycles = clampCursorMotionCycles(region.cycles);

	switch (region.preset) {
		case "arc":
			return {
				cx: base.cx + offset.cx * envelope,
				cy: base.cy + offset.cy * envelope,
			};
		case "wave": {
			const wave = Math.sin(Math.PI * 2 * cycles * motionProgress) * envelope;
			return {
				cx: base.cx + offset.cx * wave,
				cy: base.cy + offset.cy * wave,
			};
		}
		case "loop": {
			const phase = Math.PI * 2 * cycles * motionProgress;
			const tangentOffset = Math.sin(phase) * envelope;
			const normalOffset = (1 - Math.cos(phase)) * 0.5 * envelope;
			return {
				cx: base.cx + offset.cx * tangentOffset - offset.cy * normalOffset,
				cy: base.cy + offset.cy * tangentOffset + offset.cx * normalOffset,
			};
		}
		default:
			return base;
	}
}

export function findCursorMotionRegionAtTime(
	regions: readonly CursorMotionRegion[],
	timeMs: number,
): CursorMotionRegion | null {
	for (let index = regions.length - 1; index >= 0; index -= 1) {
		const region = regions[index];
		if (timeMs >= region.startMs && timeMs <= region.endMs) {
			return region;
		}
	}
	return null;
}

export function sampleCursorMotionPath(
	path: CursorMotionPath | null | undefined,
	regions: readonly CursorMotionRegion[],
	timeMs: number,
): CursorMotionPoint | null {
	const current = path?.sampleAt(timeMs) ?? null;
	if (!current) return null;

	const region = findCursorMotionRegionAtTime(regions, timeMs);
	if (!region) return current;
	if (region.preset === "recorded") return current;

	const start = region.startPoint ?? path?.sampleAt(region.startMs) ?? null;
	const end = region.endPoint ?? path?.sampleAt(region.endMs) ?? null;
	if (!start || !end) return current;

	return sampleCursorMotionRegion(region, start, end, timeMs);
}

export function buildCursorMotionTrajectory(
	path: CursorMotionPath | null | undefined,
	region: CursorMotionRegion,
	sampleCount = 80,
): CursorMotionPoint[] {
	const start = region.startPoint ?? path?.sampleAt(region.startMs) ?? null;
	const end = region.endPoint ?? path?.sampleAt(region.endMs) ?? null;
	if (!start || !end) return [];

	const count = clamp(Math.round(sampleCount), 2, 240);
	if (region.preset === "recorded") {
		return Array.from({ length: count }, (_, index) => {
			const progress = index / (count - 1);
			return path?.sampleAt(region.startMs + (region.endMs - region.startMs) * progress) ?? null;
		}).filter((point): point is CursorMotionPoint => point !== null);
	}
	return Array.from({ length: count }, (_, index) => {
		const progress = index / (count - 1);
		return sampleCursorMotionRegion(
			region,
			start,
			end,
			region.startMs + (region.endMs - region.startMs) * progress,
		);
	});
}
