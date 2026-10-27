import { describe, expect, it } from "vitest";
import { computeCameraFullscreenProgress } from "../../zoomMath/cameraFullscreenUtils";
import { createEmptyDocument, documentSchema, migrateRawDocumentToCurrent } from "../schema";
import {
	addLayoutChange,
	layoutRuns,
	legacyCameraRegions,
	materializeLayouts,
	moveLayoutBoundary,
	removeLayoutChange,
	setLayoutPreset,
} from "./layout";
import { duplicateClip, moveClip, removeClip, setClipSourceRange } from "./timeline";

function document() {
	const doc = createEmptyDocument({ title: "Layouts", projectId: "layouts" });
	doc.timeline.clips = [
		{
			id: "a",
			assetId: "asset",
			sourceStartSec: 20,
			sourceEndSec: 30,
			timelineStartSec: 0,
			timelineEndSec: 10,
			wordRefs: [],
			origin: "user",
			reason: "",
		},
		{
			id: "b",
			assetId: "asset",
			sourceStartSec: 100,
			sourceEndSec: 110,
			timelineStartSec: 10,
			timelineEndSec: 20,
			wordRefs: [],
			origin: "user",
			reason: "",
		},
	];
	return doc;
}
const view = (doc: ReturnType<typeof document>) =>
	layoutRuns(doc).map((r) => [r.start, r.end, r.member.preset]);

describe("the continuous layout partition", () => {
	it("stays implicit until a first change, then materialises source-anchored fragments", () => {
		const doc = document();
		expect(doc.layoutRegions).toBeUndefined();
		expect(view(doc)).toEqual([[0, 20, "picture-in-picture"]]);
		const next = addLayoutChange(doc, 5, "camera-only");
		expect(view(next)).toEqual([
			[0, 5, "picture-in-picture"],
			[5, 20, "camera-only"],
		]);
		expect(next.layoutRegions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					clipId: "a",
					sourceStartSec: 25,
					sourceEndSec: 30,
					preset: "camera-only",
				}),
				expect.objectContaining({
					clipId: "b",
					sourceStartSec: 100,
					sourceEndSec: 110,
					preset: "camera-only",
				}),
			]),
		);
		expect(doc.layoutRegions).toBeUndefined();
	});
	it("inserts until the next change, leaving later passages intact", () => {
		let doc = addLayoutChange(document(), 12, "no-webcam");
		doc = addLayoutChange(doc, 5, "dual-frame");
		expect(view(doc)).toEqual([
			[0, 5, "picture-in-picture"],
			[5, 12, "dual-frame"],
			[12, 20, "no-webcam"],
		]);
		expect(addLayoutChange(doc, 20, "camera-only")).toBe(doc);
		expect(addLayoutChange(doc, Number.NaN, "camera-only")).toBe(doc);
	});
	it("moves both sides of a boundary and clamps without moving its other neighbour", () => {
		let doc = addLayoutChange(addLayoutChange(document(), 5, "camera-only"), 12, "no-webcam");
		const id = layoutRuns(doc)[1].ids[0];
		doc = moveLayoutBoundary(doc, id, 8);
		expect(view(doc)).toEqual([
			[0, 8, "picture-in-picture"],
			[8, 12, "camera-only"],
			[12, 20, "no-webcam"],
		]);
		const clamped = moveLayoutBoundary(doc, id, 50);
		expect(layoutRuns(clamped)[1].start).toBeCloseTo(11.999);
		expect(layoutRuns(clamped)[2].start).toBe(12);
	});
	it("deletes a change by extending the previous layout; the initial passage is protected", () => {
		const doc = addLayoutChange(document(), 5, "camera-only");
		const runs = layoutRuns(doc);
		expect(removeLayoutChange(doc, runs[0].ids[0])).toBe(doc);
		const next = removeLayoutChange(doc, runs[1].ids[0]);
		expect(view(next)).toEqual([[0, 20, "picture-in-picture"]]);
		expect(next.layoutRegions).toEqual([]);
	});
	it("merges equal passages, retaining a uniform camera-only choice as the global default", () => {
		const doc = addLayoutChange(document(), 5, "camera-only");
		const next = setLayoutPreset(doc, layoutRuns(doc)[0].ids[0], "camera-only");
		expect(next.layoutRegions).toEqual([]);
		expect(next.legacyEditor?.webcamLayoutPreset).toBe("camera-only");
		expect(view(next)).toEqual([[0, 20, "camera-only"]]);
	});
	it("keeps dispositions with their footage after reorder, duplicate, range edit and removal", () => {
		const doc = addLayoutChange(document(), 5, "camera-only");
		const reordered = moveClip(doc, "b", 0);
		expect(view(reordered)).toEqual([
			[0, 10, "camera-only"],
			[10, 15, "picture-in-picture"],
			[15, 20, "camera-only"],
		]);
		const duplicated = duplicateClip(doc, "a", "user");
		expect(view(duplicated)).toEqual([
			[0, 5, "picture-in-picture"],
			[5, 10, "camera-only"],
			[10, 15, "picture-in-picture"],
			[15, 30, "camera-only"],
		]);
		const trimmed = setClipSourceRange(doc, "a", 24, 28);
		expect(view(trimmed)).toEqual([
			[0, 1, "picture-in-picture"],
			[1, 14, "camera-only"],
		]);
		expect(view(removeClip(doc, "a"))).toEqual([[0, 10, "camera-only"]]);
	});
});

describe("v7 Full Camera migration", () => {
	it("preserves layout, every envelope, and the exact historical easing through save/reopen", () => {
		const doc = document();
		const old = [{ id: "old", startMs: 2000, endMs: 8000 }];
		const raw = {
			...doc,
			schemaVersion: 7,
			legacyEditor: {
				webcamLayoutPreset: "dual-frame",
				cameraFullscreenRegions: old,
				webcamMirrored: true,
			},
		};
		const next = documentSchema.parse(migrateRawDocumentToCurrent(raw));
		expect(next.schemaVersion).toBe(9);
		expect(next.legacyEditor?.cameraFullscreenRegions).toBeUndefined();
		expect(next.legacyEditor?.webcamMirrored).toBe(true);
		expect(view(next)).toEqual([
			[0, 2, "dual-frame"],
			[2, 8, "camera-only"],
			[8, 20, "dual-frame"],
		]);
		for (const time of [0, 2000, 2100, 3000, 7000, 7900, 8000, 12000]) {
			expect(computeCameraFullscreenProgress(legacyCameraRegions(next), time)).toBe(
				computeCameraFullscreenProgress(old, time),
			);
		}
		const reopened = documentSchema.parse(
			migrateRawDocumentToCurrent(JSON.parse(JSON.stringify(next))),
		);
		expect(reopened).toEqual(next);
		expect(migrateRawDocumentToCurrent(next)).toBe(next);
	});
	it("keeps overlapping legacy envelopes instead of flattening their easing", () => {
		const doc = document();
		doc.legacyEditor = {
			cameraFullscreenRegions: [
				{ id: "one", startMs: 2000, endMs: 6000 },
				{ id: "two", startMs: 4000, endMs: 8000 },
			],
		};
		const migrated = documentSchema.parse(
			migrateRawDocumentToCurrent({ ...doc, schemaVersion: 7 }),
		);
		expect(legacyCameraRegions(migrated)).toHaveLength(2);
		expect(view(migrated)).toEqual([
			[0, 2, "picture-in-picture"],
			[2, 8, "camera-only"],
			[8, 20, "picture-in-picture"],
		]);
	});
	it("ignores malformed old regions without crashing", () => {
		const doc = document();
		doc.legacyEditor = {
			cameraFullscreenRegions: [null, "bad", { startMs: Number.NaN, endMs: 4 }],
		};
		expect(materializeLayouts(doc).every((r) => r.preset === "picture-in-picture")).toBe(true);
	});
});

it("reopens projects saved by the experimental v8 layouts build without losing their passages", () => {
	const edited = addLayoutChange(document(), 2, "dual-frame");
	const next = documentSchema.parse(migrateRawDocumentToCurrent({ ...edited, schemaVersion: 8 }));
	expect(next.schemaVersion).toBe(9);
	expect(next.layoutRegions).toEqual(edited.layoutRegions);
	expect(next.legacyEditor?.aspectRatio).toBe("16:9");
});
