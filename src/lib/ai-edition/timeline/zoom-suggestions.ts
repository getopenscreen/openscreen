// Cursor-telemetry-driven auto-zoom. Pure, no DOM/IPC.
//
// Ported from main's `src/components/video-editor/timeline/zoomSuggestionUtils.ts` (the legacy
// editor's "magic wand"), since rewritten as a planner. This is NOT an AI feature: it is a
// deterministic pass over the clicks recorded with a take, which thinks in shots the way an
// editor would. The video opens on the whole screen. Clicks close in time and in space share one
// zoom, which holds while the camera follows the cursor. A zoom never comes straight back after
// leaving. The video ends on the whole screen.
//
// A still pointer is no reason to zoom: at rest it sits far from where the viewer looks, and
// Screen Studio, Cap and Tella all zoom on clicks alone. A take recorded without clicks gets no
// automatic zoom.

import type { CursorTelemetryPoint, ZoomFocus } from "@/components/video-editor/types";
import { zoomTransitionMs } from "@/lib/zoomMath/constants";
import type { AxcutClip } from "../schema";
import { DEFAULT_ZOOM_DEPTH, ZOOM_DEPTH_SCALES, type ZoomDepth } from "./zoom-scale";

/** The video opens on the whole screen: no zoom starts moving in before this. */
export const OPENING_WIDE_MS = 2500;
/** And it ends on it: the last zoom is fully back out this long before the end. */
export const CLOSING_WIDE_MS = 1000;
/**
 * A click this close to the end of the recording is the one that stopped it, on the HUD's
 * Stop button, which the video never shows. Any other click there has a result the video
 * never shows either.
 */
export const STOP_CLICK_GUARD_MS = 1000;
/** Clicks closer than this in time share one zoom, when they fit in it together. */
export const SHOT_MERGE_GAP_MS = 3000;
/** A zoom is fully in this long before its first click... */
export const SHOT_LEAD_MS = 500;
/** ...and holds this long after its last one, to show what the click did. */
export const SHOT_TAIL_MS = 1500;
/** The shortest time a zoom holds, fully in. */
export const MIN_SHOT_HOLD_MS = 1800;
/** The shortest wide shot between two zooms, ramps excluded. Less reads as a yo-yo. */
export const MIN_WIDE_BETWEEN_MS = 1500;
/** The margin kept around the clicks a zoom frames, as a fraction of the frame. */
export const SHOT_FIT_MARGIN = 0.12;
/** The depths a zoom may take, shallowest first: 1.25×, 1.5×, 1.8×. */
const SHOT_DEPTHS: readonly ZoomDepth[] = [1, 2, 3];

export interface AutoZoomSuggestion {
	span: { start: number; end: number };
	focus: ZoomFocus;
	depth: ZoomDepth;
}

/** A zoom already on the timeline: the plan keeps clear of it and never moves it. */
export interface ReservedZoom {
	startMs: number;
	endMs: number;
	/** Its effective scale, which sets how long its ramps last. The default depth's if omitted. */
	scale?: number;
}

function normalizeTelemetrySample(
	sample: CursorTelemetryPoint,
	totalMs: number,
): CursorTelemetryPoint {
	return {
		timeMs: Math.max(0, Math.min(sample.timeMs, totalMs)),
		cx: Math.max(0, Math.min(sample.cx, 1)),
		cy: Math.max(0, Math.min(sample.cy, 1)),
		visible: sample.visible,
		interactionType: sample.interactionType,
	};
}

export function normalizeCursorTelemetry(
	telemetry: CursorTelemetryPoint[],
	totalMs: number,
): CursorTelemetryPoint[] {
	return [...telemetry]
		.filter(
			(sample) =>
				Number.isFinite(sample.timeMs) && Number.isFinite(sample.cx) && Number.isFinite(sample.cy),
		)
		.sort((a, b) => a.timeMs - b.timeMs)
		.map((sample) => normalizeTelemetrySample(sample, totalMs));
}

interface RecordedClick {
	timeMs: number;
	focus: ZoomFocus;
}

/** The recorded interactions that count as a click; `move` and `mouseup` do not. */
const CLICK_INTERACTION_TYPES: ReadonlySet<NonNullable<CursorTelemetryPoint["interactionType"]>> =
	new Set(["click", "double-click", "right-click", "middle-click"]);

/**
 * The clicks a viewer sees (issue #699), at the click's own time and position. A press the
 * cursor hides during is a drag the app took over, a slider or a scrubbed field, not a click.
 */
function detectClicks(samples: CursorTelemetryPoint[]): RecordedClick[] {
	const clicks: RecordedClick[] = [];
	// A press without its own mouse-up sample has no known release: PipeWire and older sidecars
	// record none, and the Windows and macOS samplers fold a release into the press sample when both
	// land in one tick. A hidden sample on the next sampler tick still identifies a slider press; a
	// much later hidden interval (typing, leaving the display) must not erase a completed click.
	const UNRELEASED_PRESS_GRACE_MS = 150;

	let pendingClick: CursorTelemetryPoint | null = null;
	let hiddenAtMs: number | null = null;
	const finishPress = (released: boolean) => {
		if (!pendingClick) return;
		const hiddenDuringPress =
			hiddenAtMs !== null &&
			(released || hiddenAtMs - pendingClick.timeMs <= UNRELEASED_PRESS_GRACE_MS);
		if (!hiddenDuringPress) {
			clicks.push({
				timeMs: pendingClick.timeMs,
				focus: { cx: pendingClick.cx, cy: pendingClick.cy },
			});
		}
		pendingClick = null;
		hiddenAtMs = null;
	};

	for (const sample of samples) {
		if (sample.interactionType && CLICK_INTERACTION_TYPES.has(sample.interactionType)) {
			finishPress(false);
			pendingClick = sample.visible === false ? null : sample;
		} else if (sample.interactionType === "mouseup") {
			// Sampled after the release: its visibility says nothing about the press.
			finishPress(true);
		} else if (pendingClick && sample.visible === false && hiddenAtMs === null) {
			hiddenAtMs = sample.timeMs;
		}
	}
	finishPress(false);
	return clicks;
}

function visibleClicks(
	samples: CursorTelemetryPoint[],
	totalMs: number,
	ignoreFromMs: number,
): RecordedClick[] {
	return detectClicks(normalizeCursorTelemetry(samples, totalMs)).filter(
		(click) => click.timeMs < ignoreFromMs,
	);
}

/** When the recording stopped: its telemetry runs until the take ends. */
function lastSampleMs(samples: CursorTelemetryPoint[]): number {
	let last = 0;
	for (const sample of samples) {
		if (Number.isFinite(sample.timeMs)) last = Math.max(last, sample.timeMs);
	}
	return last;
}

interface Box {
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
}

interface Shot {
	start: number;
	end: number;
	depth: ZoomDepth;
	/** Where its clicks fall, and how many: the weight when two shots compete. */
	box: Box;
	clicks: number;
	/** Two shots merge only on one clip: a zoom does not hold across a cut. */
	clip?: string;
}

function boxAround(focus: ZoomFocus): Box {
	return { minX: focus.cx, maxX: focus.cx, minY: focus.cy, maxY: focus.cy };
}

function union(a: Box, b: Box): Box {
	return {
		minX: Math.min(a.minX, b.minX),
		maxX: Math.max(a.maxX, b.maxX),
		minY: Math.min(a.minY, b.minY),
		maxY: Math.max(a.maxY, b.maxY),
	};
}

/** The deepest of `SHOT_DEPTHS` that shows the whole box with its margin, or null. */
function fitDepth(box: Box): ZoomDepth | null {
	const size = Math.max(box.maxX - box.minX, box.maxY - box.minY) + 2 * SHOT_FIT_MARGIN;
	let fit: ZoomDepth | null = null;
	for (const depth of SHOT_DEPTHS) {
		if (ZOOM_DEPTH_SCALES[depth] * size <= 1) fit = depth;
	}
	return fit;
}

/**
 * One axis's clicks as timed shots. `wideUntilMs` and `wideFromMs` keep the ends of the video
 * on the whole screen: a zoom starts moving in no earlier than the first and is back out by the
 * second, ramps included. A shot the bounds leave too short a hold, or none of its clicks, is
 * dropped: a zoom arriving after the fact shows nothing.
 */
function planShots(
	clicks: RecordedClick[],
	totalMs: number,
	wideUntilMs: number,
	wideFromMs: number,
): Shot[] {
	const groups: { times: number[]; box: Box }[] = [];
	for (const click of clicks) {
		const group = groups[groups.length - 1];
		if (group && click.timeMs - group.times[group.times.length - 1] <= SHOT_MERGE_GAP_MS) {
			const box = union(group.box, boxAround(click.focus));
			if (fitDepth(box) !== null) {
				group.times.push(click.timeMs);
				group.box = box;
				continue;
			}
		}
		groups.push({ times: [click.timeMs], box: boxAround(click.focus) });
	}

	const shots: Shot[] = [];
	for (const { times, box } of groups) {
		// A group only grows while it fits, so it always has a depth.
		const depth = fitDepth(box) ?? SHOT_DEPTHS[0];
		const ramp = zoomTransitionMs(ZOOM_DEPTH_SCALES[depth]);
		const earliest = Math.max(0, Math.ceil(wideUntilMs + ramp));
		const latest = Math.min(totalMs, Math.floor(wideFromMs - ramp));
		const first = times[0];
		const last = times[times.length - 1];
		// Near the end of the axis, the zoom arrives earlier rather than holding too briefly.
		const start = Math.max(
			Math.min(Math.round(first - SHOT_LEAD_MS), latest - MIN_SHOT_HOLD_MS),
			earliest,
		);
		const end = Math.min(
			Math.max(Math.round(last + SHOT_TAIL_MS), start + MIN_SHOT_HOLD_MS),
			latest,
		);
		if (end - start < MIN_SHOT_HOLD_MS) continue;
		if (!times.some((time) => time >= start && time <= end)) continue;
		shots.push({ start, end, depth, box, clicks: times.length });
	}
	return shots;
}

/**
 * No yo-yo: between two zooms, a real wide shot or none at all. Two shots too close merge when
 * they share a clip and fit in one zoom together; otherwise the one with fewer clicks goes, the
 * later one on a tie. A zoom already on the timeline never moves: a shot too close to it goes.
 *
 * ponytail: the gap is measured in timeline ms, while the renderer plays ramps on the screen
 * clock, so inside a speed region the real wide shot differs. Map through `screenTimeMs` if a
 * take with speed regions ever shows a yo-yo.
 */
function resolveShots(shots: Shot[], reserved: ReservedZoom[]): Shot[] {
	const plan = [...shots];
	const fixed = reserved.map((zoom) => ({
		start: zoom.startMs,
		end: zoom.endMs,
		scale: zoom.scale ?? ZOOM_DEPTH_SCALES[DEFAULT_ZOOM_DEPTH],
		shot: null,
	}));
	for (;;) {
		const spans = [
			...plan.map((shot) => ({
				start: shot.start,
				end: shot.end,
				scale: ZOOM_DEPTH_SCALES[shot.depth],
				shot,
			})),
			...fixed,
		].sort((a, b) => a.start - b.start);
		// Each span against the one before it that ends latest, ramp included: a long zoom
		// reaches past its neighbours, and two placed zooms may even overlap each other.
		const outOf = (span: (typeof spans)[number]) => span.end + zoomTransitionMs(span.scale);
		let reach: (typeof spans)[number] | undefined;
		let clash: [(typeof spans)[number], (typeof spans)[number]] | undefined;
		for (const span of spans) {
			if (reach && (reach.shot || span.shot)) {
				const wide = span.start - outOf(reach) - zoomTransitionMs(span.scale);
				if (wide < MIN_WIDE_BETWEEN_MS) {
					clash = [reach, span];
					break;
				}
			}
			if (!reach || outOf(span) > outOf(reach)) reach = span;
		}
		if (!clash) return plan;

		const a = clash[0].shot;
		const b = clash[1].shot;
		if (a && b) {
			const box = union(a.box, b.box);
			const depth = a.clip === b.clip ? fitDepth(box) : null;
			if (depth !== null) {
				const merged: Shot = {
					start: a.start,
					end: Math.max(a.end, b.end),
					depth,
					box,
					clicks: a.clicks + b.clicks,
					clip: a.clip,
				};
				plan.splice(plan.indexOf(a), 1, merged);
				plan.splice(plan.indexOf(b), 1);
			} else {
				plan.splice(plan.indexOf(a.clicks >= b.clicks ? b : a), 1);
			}
			continue;
		}
		const shot = a ?? b;
		if (!shot) return plan; // unreachable: a clash always involves a shot
		plan.splice(plan.indexOf(shot), 1);
	}
}

function toSuggestion(shot: Shot): AutoZoomSuggestion {
	return {
		span: { start: shot.start, end: shot.end },
		focus: { cx: (shot.box.minX + shot.box.maxX) / 2, cy: (shot.box.minY + shot.box.maxY) / 2 },
		depth: shot.depth,
	};
}

const byStart = (a: Shot, b: Shot) => a.start - b.start;

/**
 * Plan the zooms of one recording laid on the timeline from 0, straight from its telemetry.
 * `wideUntilMs` and `wideFromMs` are the video's opening and ending, `ignoreClicksFromMs` drops
 * the stop click; all three are on the telemetry's axis and default to no bound. A caller
 * holding an `AxcutDocument` wants `buildAutoZoomSuggestionsForClips`.
 */
export function buildAutoZoomSuggestions(options: {
	cursorTelemetry: CursorTelemetryPoint[];
	totalMs: number;
	existingRegions: ReservedZoom[];
	wideUntilMs?: number;
	wideFromMs?: number;
	ignoreClicksFromMs?: number;
}): AutoZoomSuggestion[] {
	const { cursorTelemetry, totalMs, existingRegions } = options;
	if (totalMs <= 0 || cursorTelemetry.length === 0) return [];
	const clicks = visibleClicks(cursorTelemetry, totalMs, options.ignoreClicksFromMs ?? Infinity);
	const shots = planShots(
		clicks,
		totalMs,
		options.wideUntilMs ?? -Infinity,
		options.wideFromMs ?? Infinity,
	);
	return resolveShots(shots, existingRegions).sort(byStart).map(toSuggestion);
}

/**
 * The same planner, run over a TIMELINE instead of over a bare media file — and the only entry
 * point a caller holding an `AxcutDocument` should use.
 *
 * Cursor telemetry is recorded against the ORIGINAL media file, so `timeMs` is the asset's
 * SOURCE time (the same axis `cursor-track.ts` maps through `locateSourcePosition`, and the same
 * one trims are stored in). Zoom regions are authored in RAW TIMELINE ms — that is what
 * `anchorRegionsWithDerivedMs` ventilates across the clips. The two axes coincide for exactly
 * one layout: a single clip, starting at 0, covering the whole recording. Two clips over ONE
 * recording make it plain: the second replays source time the first already used, so a click
 * belongs to BOTH, and gets a zoom on each.
 *
 * So each clip reads only the samples inside its own source window, shifted onto the ruler: a
 * raw clip is identity between its source time and its raw-virtual time (see
 * timeline/timelineMap.ts). Shots are planned per clip, since a zoom does not hold across a cut,
 * then settled over the whole timeline at once, every recording included, against the zooms
 * already on it (`existingRegions`, RAW TIMELINE ms). Clips with no telemetry or no probed
 * source window get nothing.
 *
 * The wide opening and ending belong to the whole edit, not to each clip: a cut may land
 * straight on a zoom, but the video's first and last seconds show the whole screen. The stop
 * click belongs to its recording: that recording's last second.
 */
export function buildAutoZoomSuggestionsForClips(options: {
	/** Each recording's samples, in its own SOURCE time, by asset id. */
	telemetryByAssetId: ReadonlyMap<string, CursorTelemetryPoint[]>;
	clips: AxcutClip[];
	existingRegions: ReservedZoom[];
}): AutoZoomSuggestion[] {
	const { telemetryByAssetId, clips, existingRegions } = options;
	if (clips.length === 0) return [];
	const editStartMs = Math.min(...clips.map((clip) => clip.timelineStartSec)) * 1000;
	const editEndMs = Math.max(...clips.map((clip) => clip.timelineEndSec)) * 1000;
	const shots: Shot[] = [];
	for (const clip of clips) {
		const telemetry = telemetryByAssetId.get(clip.assetId);
		const sourceEndSec = clip.sourceEndSec ?? clip.sourceStartSec;
		const windowMs = (sourceEndSec - clip.sourceStartSec) * 1000;
		if (!telemetry?.length || windowMs <= 0) continue;
		const sourceOffsetMs = clip.sourceStartSec * 1000;
		const timelineOffsetMs = clip.timelineStartSec * 1000;
		const clipTelemetry = telemetry
			.filter(
				(sample) => sample.timeMs >= sourceOffsetMs && sample.timeMs <= sourceOffsetMs + windowMs,
			)
			.map((sample) => ({ ...sample, timeMs: sample.timeMs - sourceOffsetMs }));
		const clicks = visibleClicks(
			clipTelemetry,
			windowMs,
			lastSampleMs(telemetry) - STOP_CLICK_GUARD_MS - sourceOffsetMs,
		);
		const clipShots = planShots(
			clicks,
			windowMs,
			editStartMs + OPENING_WIDE_MS - timelineOffsetMs,
			editEndMs - CLOSING_WIDE_MS - timelineOffsetMs,
		);
		for (const shot of clipShots) {
			shots.push({
				...shot,
				start: shot.start + timelineOffsetMs,
				end: shot.end + timelineOffsetMs,
				clip: clip.id,
			});
		}
	}
	return resolveShots(shots, existingRegions).sort(byStart).map(toSuggestion);
}
