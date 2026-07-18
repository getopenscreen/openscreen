export const CURSOR_MOTION_PRESETS = ["straight", "arc", "wave", "loop", "overshoot"] as const;

export type CursorMotionPreset = (typeof CURSOR_MOTION_PRESETS)[number];

export const CURSOR_MOTION_EASINGS = ["linear", "ease-in-out", "ease-in", "ease-out"] as const;

export type CursorMotionEasing = (typeof CURSOR_MOTION_EASINGS)[number];

export interface CursorMotionPoint {
	cx: number;
	cy: number;
}

export interface CursorMotionRegion {
	id: string;
	startMs: number;
	endMs: number;
	startPoint?: CursorMotionPoint;
	endPoint?: CursorMotionPoint;
	preset: CursorMotionPreset;
	controlPoint: CursorMotionPoint;
	cycles: number;
	easing: CursorMotionEasing;
}

export interface CursorMotionPath {
	sampleAt(timeMs: number): CursorMotionPoint | null;
}

const MIN_CYCLES = 1;
const MAX_CYCLES = 6;

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}

export function clampCursorMotionPoint(point: CursorMotionPoint): CursorMotionPoint {
	return {
		cx: clamp(Number.isFinite(point.cx) ? point.cx : 0.5, 0, 1),
		cy: clamp(Number.isFinite(point.cy) ? point.cy : 0.5, 0, 1),
	};
}

export function clampCursorMotionCycles(cycles: number) {
	return clamp(Math.round(Number.isFinite(cycles) ? cycles : 1), MIN_CYCLES, MAX_CYCLES);
}

export function isCursorMotionPreset(value: unknown): value is CursorMotionPreset {
	return CURSOR_MOTION_PRESETS.includes(value as CursorMotionPreset);
}

export function isCursorMotionEasing(value: unknown): value is CursorMotionEasing {
	return CURSOR_MOTION_EASINGS.includes(value as CursorMotionEasing);
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
	const progress = easeProgress(rawProgress, region.easing);
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
		const envelope = Math.sin(Math.PI * rawProgress);
		return {
			cx: lerp(start.cx, end.cx, overshootProgress) + offset.cx * envelope * 0.35,
			cy: lerp(start.cy, end.cy, overshootProgress) + offset.cy * envelope * 0.35,
		};
	}

	const base = {
		cx: lerp(start.cx, end.cx, progress),
		cy: lerp(start.cy, end.cy, progress),
	};
	const envelope = Math.sin(Math.PI * rawProgress);
	const cycles = clampCursorMotionCycles(region.cycles);

	switch (region.preset) {
		case "arc":
			return {
				cx: base.cx + offset.cx * envelope,
				cy: base.cy + offset.cy * envelope,
			};
		case "wave": {
			const wave = Math.sin(Math.PI * 2 * cycles * rawProgress) * envelope;
			return {
				cx: base.cx + offset.cx * wave,
				cy: base.cy + offset.cy * wave,
			};
		}
		case "loop": {
			const phase = Math.PI * 2 * cycles * rawProgress;
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
