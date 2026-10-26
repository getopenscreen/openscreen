import { describe, expect, it } from "vitest";
import {
	type AxcutDocument,
	type AxcutZoomRegion,
	assetSchema,
	clipSchema,
	createEmptyDocument,
	zoomRegionSchema,
} from "@/lib/ai-edition/schema";
import { cursorStateChanges, cursorStatesBetween, zoomRecordingPaths } from "./recordedCursorTypes";

describe("cursorStateChanges", () => {
	it("keeps the changes only, and reads a sample with no state as the arrow", () => {
		expect(
			cursorStateChanges([
				{ timeMs: 0, cursorType: null },
				{ timeMs: 33, cursorType: "arrow" },
				{ timeMs: 66, cursorType: "text" },
				{ timeMs: 99, cursorType: "text" },
				{ timeMs: 132 },
			]),
		).toEqual([
			{ timeMs: 0, type: "arrow" },
			{ timeMs: 66, type: "text" },
			{ timeMs: 132, type: "arrow" },
		]);
	});
});

describe("cursorStatesBetween", () => {
	const changes = cursorStateChanges([
		{ timeMs: 1000, cursorType: "pointer" },
		{ timeMs: 2000, cursorType: "text" },
		{ timeMs: 3000, cursorType: "resize-ew" },
	]);

	it("counts the state in force at the start and each change up to the end", () => {
		expect(cursorStatesBetween(changes, 1500, 2500)).toEqual(new Set(["pointer", "text"]));
	});

	// A clip trimmed past a state never puts it on screen.
	it("leaves out what comes after the end", () => {
		expect(cursorStatesBetween(changes, 0, 1500)).toEqual(new Set(["arrow", "pointer"]));
		expect(cursorStatesBetween(changes, 3500, 9000)).toEqual(new Set(["resize-ew"]));
	});
});

describe("zoomRecordingPaths", () => {
	/** One clip per take, ten seconds each, laid end to end. */
	function project(takes: string[]): AxcutDocument {
		const assets = takes.map((take) =>
			assetSchema.parse({
				id: `a_${take}`,
				label: "take",
				originalPath: `/recordings/${take}.mp4`,
			}),
		);
		const clips = assets.map((asset, i) =>
			clipSchema.parse({
				id: `c${i}`,
				assetId: asset.id,
				sourceStartSec: 0,
				sourceEndSec: 10,
				timelineStartSec: i * 10,
				timelineEndSec: i * 10 + 10,
				origin: "user",
			}),
		);
		const document = createEmptyDocument({ projectId: "p", title: "t" });
		return { ...document, assets, timeline: { ...document.timeline, clips } };
	}

	const zoom = (id: string, clipId: string, startMs: number, endMs: number): AxcutZoomRegion =>
		zoomRegionSchema.parse({
			id,
			clipId,
			startMs,
			endMs,
			depth: 3,
			focus: { cx: 0.5, cy: 0.5 },
			focusMode: "auto",
		});

	it("names the recording of the clip the zoom is anchored to", () => {
		const document = project(["a", "b"]);
		const regions = [zoom("z", "c0", 0, 5000)];
		expect(zoomRecordingPaths(regions, "z", document)).toEqual(["/recordings/a.mp4"]);
	});

	// The same zoom, cut at the clip junction: one fragment per clip, one pill on the ruler.
	it("names every recording of a zoom cut at a clip junction", () => {
		const document = project(["a", "b"]);
		const pill = [zoom("z1", "c0", 5000, 10000), zoom("z2", "c1", 10000, 15000)];
		expect(zoomRecordingPaths(pill, "z1", document)).toEqual([
			"/recordings/a.mp4",
			"/recordings/b.mp4",
		]);
	});

	// A document migrated before clip anchors only knows the region's raw span.
	it("falls back to the clips an unanchored zoom overlaps", () => {
		const document = project(["a", "b"]);
		const legacy = zoomRegionSchema.parse({
			id: "z",
			startMs: 8000,
			endMs: 12000,
			depth: 3,
			focus: { cx: 0.5, cy: 0.5 },
			focusMode: "auto",
		});
		expect(zoomRecordingPaths([legacy], "z", document)).toEqual([
			"/recordings/a.mp4",
			"/recordings/b.mp4",
		]);
	});

	it("answers nothing for an unknown zoom, or without a document", () => {
		const document = project(["a"]);
		expect(zoomRecordingPaths([], "z", document)).toEqual([]);
		expect(zoomRecordingPaths([zoom("z", "c0", 0, 5000)], "z", null)).toEqual([]);
	});
});
