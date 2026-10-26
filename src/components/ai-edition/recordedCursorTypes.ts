import { useEffect, useMemo, useReducer, useState } from "react";
import type { AxcutDocument, AxcutZoomRegion } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { resolveClipSourceEndSec } from "@/lib/ai-edition/timeline/clipDuration";
import { resolveRegionIds } from "@/lib/ai-edition/timeline/timelineMap";
import { nativeBridgeClient } from "@/native";

interface CursorStateChange {
	timeMs: number;
	type: string;
}

/**
 * A recording's cursor states the way the compositor reads them (`CursorTrack::load`): the
 * changes only, and a sample without a state means the arrow.
 */
export function cursorStateChanges(
	samples: ReadonlyArray<{ timeMs: number; cursorType?: string | null }>,
): CursorStateChange[] {
	const changes: CursorStateChange[] = [];
	for (const { timeMs, cursorType } of samples) {
		const type = cursorType || "arrow";
		if (changes.at(-1)?.type !== type) changes.push({ timeMs, type });
	}
	return changes;
}

/** The states on screen from `startMs` to `endMs`: the one in force at the start, then every
 *  change up to the end. */
export function cursorStatesBetween(
	changes: readonly CursorStateChange[],
	startMs: number,
	endMs: number,
): Set<string> {
	const states = new Set<string>();
	let atStart = "arrow";
	for (const { timeMs, type } of changes) {
		if (timeMs > endMs) break;
		if (timeMs <= startMs) atStart = type;
		else states.add(type);
	}
	return states.add(atStart);
}

// A recording's cursor file does not change once written: each is read once per session. A
// recording without one reads as empty, and that answer is kept.
const changesByPath = new Map<string, Promise<CursorStateChange[]>>();
// What each of those answered once it did: whether the recording has any cursor data at all. Kept
// beside the promises so a hook mounted again renders the answer at once, not a frame later.
const hasCursorByPath = new Map<string, boolean>();

function stateChangesOf(videoPath: string): Promise<CursorStateChange[]> {
	let changes = changesByPath.get(videoPath);
	if (!changes) {
		changes = Promise.resolve()
			.then(() => nativeBridgeClient.cursor.getRecordingData(videoPath))
			.then((data) => {
				const read = cursorStateChanges(data.samples);
				hasCursorByPath.set(videoPath, read.length > 0);
				return read;
			})
			// A read that failed (no bridge yet, a file still being written) shows nothing but the
			// arrow for now, and is tried again the next time rather than never.
			.catch(() => {
				changesByPath.delete(videoPath);
				return [];
			});
		changesByPath.set(videoPath, changes);
	}
	return changes;
}

/** Each clip as its recording and the stretch of it the timeline plays, in ms. */
function clipSourceRanges(document: AxcutDocument | null): Array<[string, number, number]> {
	if (!document) return [];
	return document.timeline.clips.flatMap((clip) => {
		const asset = document.assets.find((a) => a.id === clip.assetId);
		if (!asset || asset.kind !== "video") return [];
		const range: [string, number, number] = [
			asset.originalPath,
			clip.sourceStartSec * 1000,
			resolveClipSourceEndSec(clip, asset) * 1000,
		];
		return [range];
	});
}

/** Whether one of `paths` has cursor data: `null` while some are still unread and none has any. */
function cursorDataIn(paths: readonly string[]): boolean | null {
	if (paths.some((path) => hasCursorByPath.get(path))) return true;
	return paths.every((path) => hasCursorByPath.has(path)) ? false : null;
}

/**
 * Whether EVERY recording in `paths` has cursor data, or `null` while some are still unread.
 * One take without a cursor file is enough to answer no: a zoom over it has no track to follow.
 */
export function useRecordingsHaveCursor(paths: readonly string[]): boolean | null {
	// Sorted, so the same set of recordings is one read whatever order the clips name them in.
	const pathsJson = JSON.stringify([...new Set(paths)].sort());
	const read = useRecordingReads(pathsJson);
	return everyCursorDataIn(read);
}

/** Whether every one of `paths` has cursor data: `false` as soon as one answered without it,
 *  `null` while one is unread. An empty list names no recording, and nothing could follow. */
function everyCursorDataIn(paths: readonly string[]): boolean | null {
	if (paths.length === 0) return false;
	if (paths.some((path) => hasCursorByPath.get(path) === false)) return false;
	return paths.every((path) => hasCursorByPath.get(path) === true) ? true : null;
}

/**
 * Reads every recording in `paths` once per session and asks for a re-render as each answer
 * lands. Returns the deduplicated paths it read, which is what the caller's answer is about.
 */
function useRecordingReads(pathsJson: string): string[] {
	const paths = useMemo(() => JSON.parse(pathsJson) as string[], [pathsJson]);
	// The answer is read off the cache on every render, so it always belongs to the current
	// recordings; each read finishing only asks for another render.
	const [, refresh] = useReducer((n: number) => n + 1, 0);
	useEffect(() => {
		let cancelled = false;
		for (const path of paths) {
			void stateChangesOf(path).then(() => {
				if (!cancelled) refresh();
			});
		}
		return () => {
			cancelled = true;
		};
	}, [paths]);
	return paths;
}

/**
 * Whether any recording the timeline plays has cursor data, or `null` while they are read. A take
 * recorded with the system cursor has it baked into the pixels and no cursor file, so every cursor
 * setting would change nothing: the editor leaves them out.
 */
export function useHasRecordedCursor(): boolean | null {
	// A string, so the recordings are read again when one is swapped, not on every other edit.
	const pathsJson = useProjectStore((s) =>
		JSON.stringify([...new Set(clipSourceRanges(s.document).map(([path]) => path))]),
	);
	const paths = useRecordingReads(pathsJson);
	return cursorDataIn(paths);
}

/**
 * The recordings a zoom region plays over, one path per distinct video file.
 *
 * A region cut at a clip junction is stored as one fragment per clip, so a zoom that runs from
 * one take onto another names both. A region migrated without a clip anchor only knows its raw
 * span, and the clips it overlaps are its recordings instead. Empty when nothing can be resolved
 * (never saved without clips; a fragment whose clip is gone is not rendered either).
 */
export function zoomRecordingPaths(
	regions: AxcutZoomRegion[],
	id: string,
	document: AxcutDocument | null,
): string[] {
	if (!document) return [];
	const fragments = new Set(resolveRegionIds(regions, id, 0.001));
	const clips = new Map(document.timeline.clips.map((clip) => [clip.id, clip]));
	const paths = new Set<string>();
	for (const region of regions) {
		if (!fragments.has(region.id)) continue;
		const covered = region.clipId
			? [clips.get(region.clipId)]
			: document.timeline.clips.filter(
					(clip) =>
						clip.timelineStartSec * 1000 < region.endMs &&
						clip.timelineEndSec * 1000 > region.startMs,
				);
		for (const clip of covered) {
			if (!clip) continue;
			const asset = document.assets.find((candidate) => candidate.id === clip.assetId);
			if (asset?.kind === "video" && asset.originalPath) paths.add(asset.originalPath);
		}
	}
	return [...paths];
}

/**
 * Every cursor state the timeline's clips put on screen, or `null` while their recordings are
 * read. The cursor pane offers to redraw these and nothing else: a choice about a cursor the
 * video never shows would change nothing.
 *
 * ponytail: a state seen only inside a cut still counts; subtract the cuts if that ever leaves a
 * choice that changes nothing.
 */
export function useRecordedCursorTypes(): ReadonlySet<string> | null {
	// A string, so the recordings are read again when a clip changes, not on every other edit.
	const rangesJson = useProjectStore((s) => JSON.stringify(clipSourceRanges(s.document)));
	const [types, setTypes] = useState<ReadonlySet<string> | null>(null);
	useEffect(() => {
		let cancelled = false;
		const ranges = JSON.parse(rangesJson) as Array<[string, number, number]>;
		void Promise.all(
			ranges.map(async ([videoPath, startMs, endMs]) =>
				cursorStatesBetween(await stateChangesOf(videoPath), startMs, endMs),
			),
		).then((perClip) => {
			if (!cancelled) setTypes(new Set(perClip.flatMap((states) => [...states])));
		});
		return () => {
			cancelled = true;
		};
	}, [rangesJson]);
	return types;
}
