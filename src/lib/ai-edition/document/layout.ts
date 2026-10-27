import {
	isLayoutPreset,
	LAYOUT_TRANSITION_SECONDS,
	type LayoutPreset,
	type LayoutRegion,
} from "../../layoutTypes";
import type { AxcutClip, AxcutDocument } from "../schema";
import {
	anchoredToRawSpanSec,
	anchorRegionsWithDerivedMs,
	coalesceRegionsForRuler,
	hasCompleteClipAnchor,
} from "../timeline/timelineMap";
import { createId } from "./ids";

const EPSILON = 0.001;

type LayoutDocument = Pick<AxcutDocument, "timeline" | "legacyEditor" | "layoutRegions">;

export function defaultLayoutPreset(document: Pick<AxcutDocument, "legacyEditor">): LayoutPreset {
	const preset = document.legacyEditor?.webcamLayoutPreset;
	return isLayoutPreset(preset) ? preset : "picture-in-picture";
}

function clipEnd(clip: AxcutClip): number {
	return clip.sourceEndSec ?? clip.sourceStartSec + clip.timelineEndSec - clip.timelineStartSec;
}

function rawRegion(region: LayoutRegion, clips: AxcutClip[]): LayoutRegion | null {
	if (!hasCompleteClipAnchor(region)) return region;
	const span = anchoredToRawSpanSec(region, clips);
	return span ? { ...region, startMs: span.startSec * 1000, endMs: span.endSec * 1000 } : null;
}

/** Complete, non-overlapping source-anchored partition. Missing/new clip windows inherit the
 * document default; existing fragments always travel with their clip, never with the ruler. */
export function materializeLayouts(document: LayoutDocument): LayoutRegion[] {
	const clips = document.timeline.clips;
	const fallback = defaultLayoutPreset(document);
	const stored = document.layoutRegions ?? [];
	const legacy = document.legacyEditor?.cameraFullscreenRegions;
	const oldCamera = Array.isArray(legacy) ? legacy : [];
	const result: LayoutRegion[] = [];
	for (const clip of clips) {
		const start = clip.timelineStartSec * 1000;
		const end = (clip.timelineStartSec + clipEnd(clip) - clip.sourceStartSec) * 1000;
		if (end <= start) continue;
		const regions = stored.flatMap((region) => {
			if (region.clipId && region.clipId !== clip.id) return [];
			const raw = rawRegion(region, clips);
			return raw && raw.endMs > start && raw.startMs < end ? [raw] : [];
		});
		const envelopes = stored.length
			? []
			: oldCamera.flatMap((value: unknown) => {
					if (!value || typeof value !== "object") return [];
					const region = value as Partial<LayoutRegion>;
					if (region.clipId && region.clipId !== clip.id) return [];
					const span = hasCompleteClipAnchor(region)
						? anchoredToRawSpanSec(region, clips)
						: typeof region.startMs === "number" && typeof region.endMs === "number"
							? { startSec: region.startMs / 1000, endSec: region.endMs / 1000 }
							: null;
					if (!span || !Number.isFinite(span.startSec) || !Number.isFinite(span.endSec)) return [];
					const a = Math.max(start, span.startSec * 1000);
					const b = Math.min(end, span.endSec * 1000);
					return b > a
						? [
								{
									sourceStartSec: clip.sourceStartSec + (a - start) / 1000,
									sourceEndSec: clip.sourceStartSec + (b - start) / 1000,
								},
							]
						: [];
				});
		const boundaries = [
			...new Set([
				start,
				end,
				...regions.flatMap((r) => [Math.max(start, r.startMs), Math.min(end, r.endMs)]),
				...envelopes.flatMap((r) => [
					start + (r.sourceStartSec - clip.sourceStartSec) * 1000,
					start + (r.sourceEndSec - clip.sourceStartSec) * 1000,
				]),
			]),
		].sort((a, b) => a - b);
		for (let i = 0; i < boundaries.length - 1; i++) {
			const a = boundaries[i],
				b = boundaries[i + 1];
			if (b - a < EPSILON * 1000) continue;
			const existing = regions.find((r) => r.startMs <= a && r.endMs >= b);
			const inherited =
				[...regions].filter((r) => r.endMs <= a).sort((x, y) => y.endMs - x.endMs)[0] ??
				regions.find((r) => r.startMs >= b);
			const sourceStartSec = clip.sourceStartSec + (a - start) / 1000;
			const sourceEndSec = clip.sourceStartSec + (b - start) / 1000;
			const camera = envelopes.some(
				(r) => r.sourceStartSec <= sourceStartSec && r.sourceEndSec >= sourceEndSec,
			);
			result.push({
				...existing,
				id: existing?.id ?? `layout_${clip.id}_${a}`,
				clipId: clip.id,
				sourceStartSec,
				sourceEndSec,
				startMs: a,
				endMs: b,
				preset: existing?.preset ?? (camera ? "camera-only" : (inherited?.preset ?? fallback)),
				...(camera ? { legacyCamera: { basePreset: fallback, envelopes } } : {}),
			});
		}
	}
	// Legacy imports can have an unprobed, zero-extent clip. Keep their raw envelopes
	// until applyProbedDuration can anchor them; migration must never erase those edits.
	if (!result.length && clips.some((c) => clipEnd(c) <= c.sourceStartSec)) {
		return stored.length
			? stored
			: oldCamera.flatMap((value: unknown) => {
					if (!value || typeof value !== "object") return [];
					const r = value as Partial<LayoutRegion>;
					if (
						typeof r.startMs !== "number" ||
						typeof r.endMs !== "number" ||
						!Number.isFinite(r.startMs) ||
						!Number.isFinite(r.endMs) ||
						r.endMs <= r.startMs
					)
						return [];
					return [
						{
							id: r.id ?? createId("layout"),
							startMs: r.startMs,
							endMs: r.endMs,
							preset: "camera-only" as const,
							legacyCamera: {
								basePreset: fallback,
								envelopes: [{ sourceStartSec: r.startMs / 1000, sourceEndSec: r.endMs / 1000 }],
							},
						},
					];
				});
	}
	return result;
}

export function layoutRuns(document: LayoutDocument) {
	return coalesceRegionsForRuler(materializeLayouts(document));
}

export function layoutAt(document: LayoutDocument, timeSec: number): LayoutPreset {
	const region = layoutRuns(document).find((r) => timeSec >= r.start && timeSec < r.end);
	return region?.member.preset ?? defaultLayoutPreset(document);
}

/** UI hitboxes sample the same source-anchored transition that the native scene describes. */
export function layoutSampleAt(document: LayoutDocument, timeSec: number) {
	return sampleLayoutRegionsAt(
		materializeLayouts(document),
		timeSec,
		defaultLayoutPreset(document),
	);
}

export function sampleLayoutRegionsAt(
	regions: LayoutRegion[],
	timeSec: number,
	fallback: LayoutPreset,
) {
	const region = regions.find((r) => timeSec * 1000 >= r.startMs && timeSec * 1000 < r.endMs);
	const preset = region?.legacyCamera?.basePreset ?? region?.preset ?? fallback;
	const previous =
		region && !region.legacyCamera
			? regions.find((r) => r.clipId === region.clipId && Math.abs(r.endMs - region.startMs) < 1)
			: undefined;
	const duration = region
		? Math.min(LAYOUT_TRANSITION_SECONDS * 1000, (region.endMs - region.startMs) / 2)
		: 0;
	const linear =
		region && previous && !previous.legacyCamera && duration > 0
			? Math.min(1, Math.max(0, (timeSec * 1000 - region.startMs) / duration))
			: 1;
	return {
		preset,
		fromPreset: previous?.legacyCamera ? undefined : previous?.preset,
		progress: linear * linear * (3 - 2 * linear),
	};
}

function writeRuns(document: AxcutDocument, runs: LayoutRegion[]): AxcutDocument {
	const { cameraFullscreenRegions: _old, ...legacy } = document.legacyEditor ?? {};
	const anchored = anchorRegionsWithDerivedMs(runs, document.timeline.clips, () =>
		createId("layout"),
	);
	const next = { ...document, legacyEditor: legacy, layoutRegions: anchored };
	const merged = layoutRuns(next);
	if (merged.length === 1 && !merged[0].member.legacyCamera) {
		return {
			...next,
			layoutRegions: [],
			legacyEditor: { ...legacy, webcamLayoutPreset: merged[0].member.preset },
		};
	}
	return next;
}

function asRegion(run: ReturnType<typeof layoutRuns>[number]): LayoutRegion {
	return {
		id: run.ids[0],
		startMs: run.start * 1000,
		endMs: run.end * 1000,
		preset: run.member.preset,
		...(run.member.legacyCamera ? { legacyCamera: run.member.legacyCamera } : {}),
	};
}

/** Apply from the playhead until the next visible change, atomically splitting the partition. */
export function addLayoutChange(
	document: AxcutDocument,
	timeSec: number,
	preset: LayoutPreset,
): AxcutDocument {
	if (!Number.isFinite(timeSec)) return document;
	const runs = layoutRuns(document);
	const active = runs.findIndex((r) => timeSec >= r.start && timeSec < r.end);
	if (active < 0 || (runs[active].member.preset === preset && !runs[active].member.legacyCamera))
		return document;
	const regions = runs.map(asRegion);
	const old = { ...regions[active], legacyCamera: undefined };
	const startMs = Math.max(old.startMs, Math.round(timeSec * 1000));
	const replacement = { id: createId("layout"), startMs, endMs: old.endMs, preset };
	regions.splice(
		active,
		1,
		...(startMs > old.startMs ? [{ ...old, endMs: startMs }] : []),
		replacement,
	);
	return writeRuns(document, regions);
}

/** Compatibility for old span-based tool calls; new authoring uses change points. */
export function applyLayoutSpan(
	document: AxcutDocument,
	startSec: number,
	endSec: number,
	preset: LayoutPreset,
): AxcutDocument {
	if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) return document;
	const regions = layoutRuns(document).flatMap((run) => {
		const old = asRegion(run);
		const a = Math.max(run.start, startSec),
			b = Math.min(run.end, endSec);
		if (b <= a) return [old];
		return [
			...(a > run.start ? [{ ...old, endMs: a * 1000, legacyCamera: undefined }] : []),
			{ id: createId("layout"), startMs: a * 1000, endMs: b * 1000, preset },
			...(b < run.end
				? [{ ...old, id: createId("layout"), startMs: b * 1000, legacyCamera: undefined }]
				: []),
		];
	});
	return writeRuns(document, regions);
}

export function setLayoutPreset(
	document: AxcutDocument,
	id: string,
	preset: LayoutPreset,
): AxcutDocument {
	const runs = layoutRuns(document);
	const existing = runs.find((r) => r.ids.includes(id));
	if (!existing || (existing.member.preset === preset && !existing.member.legacyCamera))
		return document;
	return writeRuns(
		document,
		runs.map((r) =>
			r.ids.includes(id) ? { ...asRegion(r), preset, legacyCamera: undefined } : asRegion(r),
		),
	);
}

export function moveLayoutBoundary(
	document: AxcutDocument,
	id: string,
	timeSec: number,
): AxcutDocument {
	if (!Number.isFinite(timeSec)) return document;
	const runs = layoutRuns(document);
	const index = runs.findIndex((r) => r.ids.includes(id));
	if (index <= 0) return document;
	const regions = runs.map(asRegion);
	const boundary = Math.round(
		Math.max(runs[index - 1].start + EPSILON, Math.min(runs[index].end - EPSILON, timeSec)) * 1000,
	);
	if (boundary === Math.round(runs[index].start * 1000)) return document;
	regions[index - 1] = { ...regions[index - 1], endMs: boundary, legacyCamera: undefined };
	regions[index] = { ...regions[index], startMs: boundary, legacyCamera: undefined };
	return writeRuns(document, regions);
}

export function removeLayoutChange(document: AxcutDocument, id: string): AxcutDocument {
	const runs = layoutRuns(document);
	const index = runs.findIndex((r) => r.ids.includes(id));
	if (index <= 0) return document;
	const regions = runs.map(asRegion);
	regions[index - 1] = {
		...regions[index - 1],
		endMs: regions[index].endMs,
		legacyCamera: undefined,
	};
	regions.splice(index, 1);
	return writeRuns(document, regions);
}

/** Preserve the old ease-in/hold/ease-out while keeping layouts the only stored authority. */
export function legacyCameraRegions(document: LayoutDocument) {
	const old = document.legacyEditor?.cameraFullscreenRegions;
	if (!document.layoutRegions?.length && Array.isArray(old)) {
		return old.flatMap((value: unknown) => {
			if (!value || typeof value !== "object") return [];
			const r = value as Partial<LayoutRegion>;
			if (
				typeof r.startMs !== "number" ||
				typeof r.endMs !== "number" ||
				!Number.isFinite(r.startMs) ||
				!Number.isFinite(r.endMs)
			)
				return [];
			return [
				{
					id: r.id ?? "legacy-camera",
					startMs: r.startMs,
					endMs: r.endMs,
					...(hasCompleteClipAnchor(r)
						? { clipId: r.clipId, sourceStartSec: r.sourceStartSec, sourceEndSec: r.sourceEndSec }
						: {}),
				},
			];
		});
	}
	const seen = new Set<string>();
	return materializeLayouts(document).flatMap((r) =>
		(r.legacyCamera?.envelopes ?? []).flatMap((e, i) => {
			if (
				r.sourceStartSec !== undefined &&
				r.sourceEndSec !== undefined &&
				(e.sourceEndSec <= r.sourceStartSec || e.sourceStartSec >= r.sourceEndSec)
			)
				return [];
			const key = `${r.clipId}:${e.sourceStartSec}:${e.sourceEndSec}`;
			if (seen.has(key)) return [];
			seen.add(key);
			const clip = document.timeline.clips.find((c) => c.id === r.clipId);
			if (!clip) return [];
			return [
				{
					id: `${r.id}_legacy_${i}`,
					clipId: clip.id,
					...e,
					startMs: (clip.timelineStartSec + e.sourceStartSec - clip.sourceStartSec) * 1000,
					endMs: (clip.timelineStartSec + e.sourceEndSec - clip.sourceStartSec) * 1000,
				},
			];
		}),
	);
}
