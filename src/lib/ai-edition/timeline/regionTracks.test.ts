import { describe, expect, it } from "vitest";
import { packRegionRows, regionLaneHeight } from "./regionTracks";

describe("region tracks", () => {
	it("keeps nested and identical spans independently reachable", () => {
		const tracks = packRegionRows([
			{ id: "background", start: 0, end: 67 },
			{ id: "second", start: 35, end: 40 },
			{ id: "third", start: 35, end: 40 },
		]);
		expect(tracks.rowCount).toBe(3);
		expect(new Set(tracks.rowOf.values()).size).toBe(3);
		expect(regionLaneHeight(tracks.rowCount)).toBe(78);
	});

	it("reuses rows for nonoverlapping elements but preserves explicit layers", () => {
		const tracks = packRegionRows([
			{ id: "low", start: 0, end: 2, layer: 1 },
			{ id: "high", start: 0, end: 2, layer: 10 },
			{ id: "later", start: 2, end: 4, layer: 10 },
		]);
		expect(tracks.rowCount).toBe(2);
		expect(tracks.rowOf.get("high")).toBe(0);
		expect(tracks.rowOf.get("later")).toBe(0);
		expect(tracks.rowOf.get("low")).toBe(1);
		expect(tracks.layers).toEqual([10, 1]);
	});

	it("separates adjacent compact pills whose resize handles would overlap", () => {
		const spans = [
			{ id: "a", start: 0, end: 0.1 },
			{ id: "b", start: 0.2, end: 0.3 },
		];
		expect(packRegionRows(spans, 10).rowCount).toBe(2);
		expect(packRegionRows(spans, 200).rowCount).toBe(1);
	});

	it("keeps one empty track for the add-element hint", () => {
		expect(packRegionRows([]).rowCount).toBe(1);
		expect(regionLaneHeight(1)).toBe(24);
	});

	it("matches compositing order for legacy annotations sharing a layer", () => {
		const tracks = packRegionRows([
			{ id: "back", start: 0, end: 67, layer: 1, stackOrder: 0 },
			{ id: "front", start: 35, end: 40, layer: 1, stackOrder: 1 },
			{ id: "later", start: 45, end: 50, layer: 1, stackOrder: 2 },
		]);
		expect(tracks.rowOf.get("front")).toBe(0);
		expect(tracks.rowOf.get("back")).toBe(1);
		expect(tracks.rowOf.get("later")).toBe(0);
	});
});
