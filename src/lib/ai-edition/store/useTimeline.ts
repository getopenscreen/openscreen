// Hook: region mutations for the new editor shell. Wraps the project store
// with typed add/remove/select operations for zoom, skip, annotation, and
// speed regions. Each add creates a 2-second region at the current playhead
// (a reasonable default for the user to then resize).

import { useCallback, useState } from "react";
import type { AnnotationRegion, AnnotationType } from "@/components/video-editor/types";
import { createId } from "../document/ids";
import type { AxcutDocument } from "../schema";
import { useProjectStore } from "./projectStore";

type RegionKind = "zoom" | "skip" | "annotation" | "speed";

// Placeholder duration applied to a freshly-inserted clip whose source asset
// hasn't reported its real duration yet (media drag → drop before the preview
// video fires `loadedmetadata`). The renderer's handleLoadedMetadata
// (NewEditorShell) scans for clips sitting at exactly this value and
// auto-corrects them to the probed duration once metadata arrives, so the
// timeline ruler, progress bar, and sourceEndSec all stay in sync.
export const PLACEHOLDER_DURATION_SEC = 60;

interface RegionHandle {
	kind: RegionKind;
	id: string;
}

type Clip = AxcutDocument["timeline"]["clips"][number];

// Lay clips back-to-back from t=0, preserving each clip's own length. Called
// after any structural change (insert / move / remove) so the timeline never
// has gaps or overlaps between clips.
function resequenceClips(clips: Clip[]): Clip[] {
	let cursor = 0;
	return clips.map((c) => {
		const timelineLen = c.timelineEndSec - c.timelineStartSec;
		const sourceLen = (c.sourceEndSec ?? 0) - c.sourceStartSec;
		const len = Math.max(0.001, timelineLen > 0 ? timelineLen : sourceLen);
		const next = { ...c, timelineStartSec: cursor, timelineEndSec: cursor + len };
		cursor += len;
		return next;
	});
}

export function useTimeline() {
	const document = useProjectStore((s) => s.document);
	const projectId = useProjectStore((s) => s.projectId);
	const currentTimeSec = useProjectStore((s) => s.currentTimeSec);
	const saveDocument = useProjectStore((s) => s.saveDocument);
	const [selection, setSelection] = useState<RegionHandle | null>(null);
	const [clipSelection, setClipSelection] = useState<string | null>(null);

	const hasDoc = document !== null && projectId !== null;

	const addZoom = useCallback(async () => {
		if (!document) return;
		const timeMs = Math.round(currentTimeSec * 1000);
		const next: AxcutDocument = {
			...document,
			zoomRanges: [
				...document.zoomRanges,
				{
					id: createId("zoom"),
					startMs: timeMs,
					endMs: timeMs + 2000,
					depth: 3,
					focus: { cx: 0.5, cy: 0.5 },
					focusMode: "manual" as const,
				},
			] as AxcutDocument["zoomRanges"],
		};
		await saveDocument(next);
	}, [document, currentTimeSec, saveDocument]);

	const addSkip = useCallback(async () => {
		if (!document) return;
		const asset =
			document.assets.find((a) => a.id === document.project.primaryAssetId) ?? document.assets[0];
		if (!asset) return;
		const id = createId("skip");
		const next: AxcutDocument = {
			...document,
			timeline: {
				...document.timeline,
				skipRanges: [
					...document.timeline.skipRanges,
					{
						id,
						assetId: asset.id,
						startSec: currentTimeSec,
						endSec: currentTimeSec + 2,
						reason: "manual",
						origin: "user" as const,
					},
				],
			},
		};
		await saveDocument(next);
	}, [document, currentTimeSec, saveDocument]);

	const addAnnotation = useCallback(async () => {
		if (!document) return;
		const timeMs = Math.round(currentTimeSec * 1000);
		const ann: AnnotationRegion = {
			id: createId("ann"),
			startMs: timeMs,
			endMs: timeMs + 2000,
			type: "text" as AnnotationType,
			content: "New annotation",
			textContent: "New annotation",
			position: { x: 50, y: 50 },
			size: { width: 30, height: 20 },
			style: {
				color: "#ffffff",
				backgroundColor: "transparent",
				fontSize: 32,
				fontFamily: "Inter",
				fontWeight: "bold",
				fontStyle: "normal",
				textDecoration: "none",
				textAlign: "center",
				textAnimation: "none",
			},
			zIndex: document.annotations.length + 1,
		};
		const next: AxcutDocument = {
			...document,
			annotations: [...document.annotations, ann] as unknown as AxcutDocument["annotations"],
		};
		await saveDocument(next);
	}, [document, currentTimeSec, saveDocument]);

	const addSpeed = useCallback(async () => {
		if (!document) return;
		const timeMs = Math.round(currentTimeSec * 1000);
		const legacy = (document.legacyEditor as Record<string, unknown>) ?? {};
		const prev = (legacy.speedRegions as unknown[]) ?? [];
		const next: AxcutDocument = {
			...document,
			legacyEditor: {
				...legacy,
				speedRegions: [
					...prev,
					{
						id: createId("speed"),
						startMs: timeMs,
						endMs: timeMs + 2000,
						speed: 1.5 as const,
					},
				],
			},
		};
		await saveDocument(next);
	}, [document, currentTimeSec, saveDocument]);

	const updateSkipRange = useCallback(
		async (skipId: string, startSec: number, endSec: number) => {
			if (!document) return;
			const clamp = (n: number) => (Number.isFinite(n) ? Math.max(0, n) : 0);
			const s = clamp(startSec);
			const e = clamp(endSec);
			const next: AxcutDocument = {
				...document,
				timeline: {
					...document.timeline,
					skipRanges: document.timeline.skipRanges.map((r) =>
						r.id === skipId ? { ...r, startSec: Math.min(s, e), endSec: Math.max(s, e) } : r,
					),
				},
			};
			await saveDocument(next);
		},
		[document, saveDocument],
	);

	const updateZoomSpan = useCallback(
		async (id: string, startMs: number, endMs: number) => {
			if (!document) return;
			const clampMs = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);
			const s = clampMs(startMs);
			const e = clampMs(endMs);
			const next: AxcutDocument = {
				...document,
				zoomRanges: document.zoomRanges.map((z) =>
					z.id === id ? { ...z, startMs: Math.min(s, e), endMs: Math.max(s, e) } : z,
				) as AxcutDocument["zoomRanges"],
			};
			await saveDocument(next);
		},
		[document, saveDocument],
	);

	const updateAnnotationSpan = useCallback(
		async (id: string, startMs: number, endMs: number) => {
			if (!document) return;
			const clampMs = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);
			const s = clampMs(startMs);
			const e = clampMs(endMs);
			const next: AxcutDocument = {
				...document,
				annotations: document.annotations.map((a) =>
					a.id === id ? { ...a, startMs: Math.min(s, e), endMs: Math.max(s, e) } : a,
				),
			};
			await saveDocument(next);
		},
		[document, saveDocument],
	);

	const updateSpeedSpan = useCallback(
		async (id: string, startMs: number, endMs: number) => {
			if (!document) return;
			const clampMs = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);
			const s = clampMs(startMs);
			const e = clampMs(endMs);
			const legacy = (document.legacyEditor as Record<string, unknown>) ?? {};
			const prev = ((legacy.speedRegions as unknown[]) ?? []) as Array<{
				id: string;
				startMs: number;
				endMs: number;
				speed: number;
			}>;
			const next: AxcutDocument = {
				...document,
				legacyEditor: {
					...legacy,
					speedRegions: prev.map((r) =>
						r.id === id ? { ...r, startMs: Math.min(s, e), endMs: Math.max(s, e) } : r,
					),
				},
			};
			await saveDocument(next);
		},
		[document, saveDocument],
	);

	const removeRegion = useCallback(
		async (kind: RegionKind, id: string) => {
			if (!document) return;
			let next: AxcutDocument;
			if (kind === "zoom") {
				next = {
					...document,
					zoomRanges: document.zoomRanges.filter((z) => z.id !== id) as AxcutDocument["zoomRanges"],
				};
			} else if (kind === "skip") {
				next = {
					...document,
					timeline: {
						...document.timeline,
						skipRanges: document.timeline.skipRanges.filter((s) => s.id !== id),
					},
				};
			} else if (kind === "annotation") {
				next = {
					...document,
					annotations: document.annotations.filter((a) => a.id !== id),
				};
			} else {
				const legacy = (document.legacyEditor as Record<string, unknown>) ?? {};
				const prev = ((legacy.speedRegions as unknown[]) ?? []).filter(
					(s) => (s as { id: string }).id !== id,
				);
				next = {
					...document,
					legacyEditor: { ...legacy, speedRegions: prev },
				};
			}
			await saveDocument(next);
			if (selection?.id === id) setSelection(null);
		},
		[document, selection, saveDocument],
	);

	const selectRegion = useCallback((kind: RegionKind, id: string) => {
		setSelection({ kind, id });
	}, []);

	const clearSelection = useCallback(() => setSelection(null), []);

	const addClipBefore = useCallback(
		async (assetId: string) => {
			if (!document) return;
			const asset = document.assets.find((a) => a.id === assetId);
			if (!asset) return;
			const duration = asset.durationSec ?? PLACEHOLDER_DURATION_SEC;
			const newClip: AxcutDocument["timeline"]["clips"][number] = {
				id: createId("clip"),
				assetId,
				sourceStartSec: 0,
				sourceEndSec: duration,
				timelineStartSec: 0,
				timelineEndSec: duration,
				wordRefs: [],
				origin: "user",
				reason: "Inserted before all clips",
			};
			const shifted = document.timeline.clips.map((c) => ({
				...c,
				timelineStartSec: c.timelineStartSec + duration,
				timelineEndSec: c.timelineEndSec + duration,
			}));
			const next: AxcutDocument = {
				...document,
				timeline: {
					...document.timeline,
					clips: [newClip, ...shifted],
				},
			};
			await saveDocument(next);
		},
		[document, saveDocument],
	);

	const addClipAfter = useCallback(
		async (assetId: string) => {
			if (!document) return;
			const asset = document.assets.find((a) => a.id === assetId);
			if (!asset) return;
			const duration = asset.durationSec ?? PLACEHOLDER_DURATION_SEC;
			const lastEnd = document.timeline.clips.at(-1)?.timelineEndSec ?? 0;
			const newClip: AxcutDocument["timeline"]["clips"][number] = {
				id: createId("clip"),
				assetId,
				sourceStartSec: 0,
				sourceEndSec: duration,
				timelineStartSec: lastEnd,
				timelineEndSec: lastEnd + duration,
				wordRefs: [],
				origin: "user",
				reason: "Inserted after all clips",
			};
			const next: AxcutDocument = {
				...document,
				timeline: {
					...document.timeline,
					clips: [...document.timeline.clips, newClip],
				},
			};
			await saveDocument(next);
		},
		[document, saveDocument],
	);

	const editClip = useCallback(
		async (
			clipId: string,
			patch: Partial<
				Pick<
					AxcutDocument["timeline"]["clips"][number],
					"sourceStartSec" | "sourceEndSec" | "timelineStartSec" | "timelineEndSec"
				>
			>,
		) => {
			if (!document) return;
			// ponytail: clamp negative values and keep end >= start so the schema
			// refine doesn't reject the save. Swap when end < start instead of
			// throwing — a user typing into a number input is expected to be
			// able to type in any order.
			const clamp = (n: number) => (Number.isFinite(n) ? Math.max(0, n) : 0);
			const next: AxcutDocument["timeline"]["clips"][number] = {
				...(document.timeline.clips.find((c) => c.id === clipId) as
					| AxcutDocument["timeline"]["clips"][number]
					| undefined),
			} as AxcutDocument["timeline"]["clips"][number];
			if (!next?.id) return;
			const sStart = clamp(patch.sourceStartSec ?? next.sourceStartSec);
			const sEnd = clamp(patch.sourceEndSec ?? next.sourceEndSec ?? 0);
			const tStart = clamp(patch.timelineStartSec ?? next.timelineStartSec);
			const tEnd = clamp(patch.timelineEndSec ?? next.timelineEndSec);
			const updated: AxcutDocument["timeline"]["clips"][number] = {
				...next,
				sourceStartSec: Math.min(sStart, sEnd),
				sourceEndSec: Math.max(sStart, sEnd),
				timelineStartSec: Math.min(tStart, tEnd),
				timelineEndSec: Math.max(tStart, tEnd),
			};
			const nextDoc: AxcutDocument = {
				...document,
				timeline: {
					...document.timeline,
					clips: document.timeline.clips.map((c) => (c.id === clipId ? updated : c)),
				},
			};
			await saveDocument(nextDoc);
		},
		[document, saveDocument],
	);

	// Axcut-consistent clip trim: only the source range is user-editable (the
	// Edit Clip dialog's draggable track). Changing it changes the clip's
	// effective duration, so every clip is resequenced back-to-back afterward —
	// same invariant as insertClipAt/moveClip/removeClip — instead of leaving
	// downstream clips at their old timeline positions (which would overlap).
	const updateClipSourceRange = useCallback(
		async (clipId: string, sourceStartSec: number, sourceEndSec: number) => {
			if (!document) return;
			const clamp = (n: number) => (Number.isFinite(n) ? Math.max(0, n) : 0);
			const s = clamp(sourceStartSec);
			const e = clamp(sourceEndSec);
			const arr = document.timeline.clips.map((c) =>
				c.id === clipId
					? { ...c, sourceStartSec: Math.min(s, e), sourceEndSec: Math.max(s, e) }
					: c,
			);
			const next: AxcutDocument = {
				...document,
				timeline: { ...document.timeline, clips: resequenceClips(arr) },
			};
			await saveDocument(next);
		},
		[document, saveDocument],
	);

	const splitAndInsert = useCallback(
		async (assetId: string, splitTimeSec: number) => {
			if (!document) return;
			const asset = document.assets.find((a) => a.id === assetId);
			if (!asset) return;
			const duration = asset.durationSec ?? PLACEHOLDER_DURATION_SEC;
			const targetIdx = document.timeline.clips.findIndex(
				(c) => c.timelineStartSec <= splitTimeSec && c.timelineEndSec >= splitTimeSec,
			);
			if (targetIdx === -1) {
				await addClipAfter(assetId);
				return;
			}
			const target = document.timeline.clips[targetIdx];
			const left = {
				id: createId("clip"),
				assetId: target.assetId,
				sourceStartSec: target.sourceStartSec,
				sourceEndSec: splitTimeSec,
				timelineStartSec: target.timelineStartSec,
				timelineEndSec: splitTimeSec,
				wordRefs: [] as string[],
				origin: "user" as const,
				reason: "Split left",
			};
			const insert = {
				id: createId("clip"),
				assetId,
				sourceStartSec: 0,
				sourceEndSec: duration,
				timelineStartSec: splitTimeSec,
				timelineEndSec: splitTimeSec + duration,
				wordRefs: [] as string[],
				origin: "user" as const,
				reason: "Inserted between splits",
			};
			const right = {
				id: createId("clip"),
				assetId: target.assetId,
				sourceStartSec: target.sourceStartSec + splitTimeSec - target.timelineStartSec,
				sourceEndSec: target.sourceEndSec,
				timelineStartSec: splitTimeSec + duration,
				timelineEndSec: target.timelineEndSec + duration,
				wordRefs: [] as string[],
				origin: "user" as const,
				reason: "Split right",
			};
			const nextClips: AxcutDocument["timeline"]["clips"] = [
				...document.timeline.clips.slice(0, targetIdx),
				left,
				insert,
				right as (typeof document.timeline.clips)[number],
				...document.timeline.clips.slice(targetIdx + 1),
			];
			const next: AxcutDocument = {
				...document,
				timeline: { ...document.timeline, clips: nextClips },
			};
			await saveDocument(next);
		},
		[document, saveDocument, addClipAfter],
	);

	// Insert a new full-duration clip for `assetId` at position `index`
	// (0 = before all, clips.length = after all), then resequence.
	const insertClipAt = useCallback(
		async (assetId: string, index: number) => {
			if (!document) return;
			const asset = document.assets.find((a) => a.id === assetId);
			if (!asset) return;
			const duration = asset.durationSec ?? PLACEHOLDER_DURATION_SEC;
			const newClip: Clip = {
				id: createId("clip"),
				assetId,
				sourceStartSec: 0,
				sourceEndSec: duration,
				timelineStartSec: 0,
				timelineEndSec: duration,
				wordRefs: [],
				origin: "user",
				reason: "Inserted from media panel",
			};
			const arr = [...document.timeline.clips];
			const at = Math.max(0, Math.min(arr.length, index));
			arr.splice(at, 0, newClip);
			const next: AxcutDocument = {
				...document,
				timeline: { ...document.timeline, clips: resequenceClips(arr) },
			};
			await saveDocument(next);
			setClipSelection(newClip.id);
		},
		[document, saveDocument],
	);

	// Reorder a clip to a new index, then resequence timeline positions.
	const moveClip = useCallback(
		async (clipId: string, toIndex: number) => {
			if (!document) return;
			const arr = [...document.timeline.clips];
			const from = arr.findIndex((c) => c.id === clipId);
			if (from === -1) return;
			const [moved] = arr.splice(from, 1);
			const at = Math.max(0, Math.min(arr.length, toIndex));
			arr.splice(at, 0, moved);
			const next: AxcutDocument = {
				...document,
				timeline: { ...document.timeline, clips: resequenceClips(arr) },
			};
			await saveDocument(next);
		},
		[document, saveDocument],
	);

	// Duplicate a clip in place (same asset + source range), inserted right
	// after the original, then resequenced. Mirrors Axcut's Ctrl+C/Ctrl+V.
	const duplicateClip = useCallback(
		async (clipId: string) => {
			if (!document) return;
			const arr = [...document.timeline.clips];
			const from = arr.findIndex((c) => c.id === clipId);
			if (from === -1) return;
			const source = arr[from];
			const copy: Clip = {
				...source,
				id: createId("clip"),
				reason: "Duplicated clip",
			};
			arr.splice(from + 1, 0, copy);
			const next: AxcutDocument = {
				...document,
				timeline: { ...document.timeline, clips: resequenceClips(arr) },
			};
			await saveDocument(next);
			setClipSelection(copy.id);
		},
		[document, saveDocument],
	);

	const removeClip = useCallback(
		async (clipId: string) => {
			if (!document) return;
			const arr = document.timeline.clips.filter((c) => c.id !== clipId);
			const next: AxcutDocument = {
				...document,
				timeline: { ...document.timeline, clips: resequenceClips(arr) },
			};
			await saveDocument(next);
			if (clipSelection === clipId) setClipSelection(null);
		},
		[document, clipSelection, saveDocument],
	);

	const selectClip = useCallback((id: string) => setClipSelection(id), []);
	const clearClipSelection = useCallback(() => setClipSelection(null), []);

	const speedRegions = hasDoc
		? (((document.legacyEditor as Record<string, unknown> | null)?.speedRegions as Array<{
				id: string;
				startMs: number;
				endMs: number;
				speed: number;
			}>) ?? [])
		: [];

	return {
		zoomRegions: document?.zoomRanges ?? [],
		skipRanges: document?.timeline.skipRanges ?? [],
		annotationRegions: (document?.annotations ?? []) as unknown as AnnotationRegion[],
		speedRegions,
		clips: document?.timeline.clips ?? [],
		assets: document?.assets ?? [],
		hasDoc,
		selection,
		clipSelection,
		addZoom,
		addSkip,
		addAnnotation,
		addSpeed,
		removeRegion,
		selectRegion,
		clearSelection,
		addClipBefore,
		addClipAfter,
		editClip,
		updateClipSourceRange,
		splitAndInsert,
		insertClipAt,
		moveClip,
		duplicateClip,
		removeClip,
		selectClip,
		clearClipSelection,
		updateSkipRange,
		updateZoomSpan,
		updateAnnotationSpan,
		updateSpeedSpan,
	};
}
