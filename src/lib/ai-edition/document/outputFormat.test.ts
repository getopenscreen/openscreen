import { describe, expect, it } from "vitest";
import type { AxcutAsset, AxcutClip, AxcutDocument } from "@/lib/ai-edition/schema";
import {
	collectNativeFormats,
	pickOutputDims,
	referenceAssetDims,
	resolveAspectRatioValue,
} from "./outputFormat";

function asset(id: string, width: number, height: number): AxcutAsset {
	return {
		kind: "video",
		id,
		label: id,
		originalPath: `/tmp/${id}.mp4`,
		cameraTrack: null,
		video: { width, height } as AxcutAsset["video"],
	};
}

function clip(id: string, assetId: string): AxcutClip {
	return {
		id,
		assetId,
		sourceStartSec: 0,
		sourceEndSec: 10,
		timelineStartSec: 0,
		timelineEndSec: 10,
		wordRefs: [],
		origin: "user",
		reason: "",
	};
}

function doc(assets: AxcutAsset[], clips: AxcutClip[]): AxcutDocument {
	return {
		schemaVersion: 3,
		project: {
			id: "proj_1",
			title: "Test",
			createdAt: "2026-06-26T10:00:00Z",
			updatedAt: "2026-06-26T10:00:00Z",
			primaryAssetId: assets[0]?.id ?? "asset_1",
		},
		assets,
		transcript: null,
		transcripts: [],
		timeline: {
			clips,
			gaps: [],
			trimRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		annotations: [],
		zoomRanges: [],
		legacyEditor: null,
		agent: { pendingQuestions: [], suggestions: [], lastAppliedOperations: [] },
		preview: { strategy: "seek", revision: 0 },
		export: { preset: "final-balanced", lastJobId: null },
		history: { revisions: [] },
	} as AxcutDocument;
}

describe("collectNativeFormats", () => {
	it("returns one entry when every clip shares a shape — the common case stays a single choice", () => {
		const d = doc(
			[asset("a1", 1920, 1080), asset("a2", 1280, 720)],
			[clip("c1", "a1"), clip("c2", "a2")],
		);
		expect(collectNativeFormats(d)).toEqual([
			{ token: "16:9", ratio: 16 / 9, width: 1920, height: 1080, clipCount: 2 },
		]);
	});

	it("dedups by SHAPE, not pixel size — 1080p and 4K are the same 16:9 entry", () => {
		const d = doc(
			[asset("a1", 1920, 1080), asset("a2", 3840, 2160)],
			[clip("c1", "a1"), clip("c2", "a2")],
		);
		const formats = collectNativeFormats(d);
		expect(formats).toHaveLength(1);
		expect(formats[0].token).toBe("16:9");
		// Representative dims are the largest available, for the menu's size hint.
		expect(formats[0]).toMatchObject({ width: 3840, height: 2160, clipCount: 2 });
	});

	it("enumerates each distinct shape on a mixed timeline, most-used first", () => {
		const d = doc(
			[asset("a1", 1920, 1080), asset("a2", 2160, 3840)],
			[clip("c1", "a1"), clip("c2", "a1"), clip("c3", "a2")],
		);
		expect(collectNativeFormats(d).map((f) => [f.token, f.clipCount])).toEqual([
			["16:9", 2],
			["9:16", 1],
		]);
	});

	it("reduces non-preset shapes to their own token (ultrawide)", () => {
		const d = doc([asset("a1", 2560, 1080)], [clip("c1", "a1")]);
		expect(collectNativeFormats(d)[0].token).toBe("64:27");
	});

	it("ignores clips whose asset is missing or has no probed dimensions", () => {
		const d = doc([asset("a1", 0, 0)], [clip("c1", "a1"), clip("c2", "ghost")]);
		expect(collectNativeFormats(d)).toEqual([]);
	});

	it("counts clips, not assets — two cuts of one recording are one format", () => {
		const d = doc([asset("a1", 1920, 1080)], [clip("c1", "a1"), clip("c2", "a1")]);
		expect(collectNativeFormats(d)).toHaveLength(1);
		expect(collectNativeFormats(d)[0].clipCount).toBe(2);
	});

	it("only considers assets the timeline actually uses", () => {
		const d = doc([asset("a1", 1920, 1080), asset("unused", 1080, 1920)], [clip("c1", "a1")]);
		expect(collectNativeFormats(d).map((f) => f.token)).toEqual(["16:9"]);
	});
});

describe("referenceAssetDims", () => {
	it("picks the largest pixel area among used assets", () => {
		const d = doc(
			[asset("a1", 1280, 720), asset("a2", 3840, 2160)],
			[clip("c1", "a1"), clip("c2", "a2")],
		);
		expect(referenceAssetDims(d)).toEqual({ width: 3840, height: 2160 });
	});

	it("falls back to any asset with dims when no used asset has probed yet", () => {
		const d = doc([asset("a1", 0, 0), asset("a2", 1280, 720)], [clip("c1", "a1")]);
		expect(referenceAssetDims(d)).toEqual({ width: 1280, height: 720 });
	});

	it("falls back to 1920x1080 for a document with no dimensions at all", () => {
		expect(referenceAssetDims(doc([], []))).toEqual({ width: 1920, height: 1080 });
	});
});

describe("pickOutputDims", () => {
	it("derives the short side from the chosen ratio, keeping the reference long side", () => {
		const d = doc([asset("a1", 1920, 1080)], [clip("c1", "a1")]);
		expect(pickOutputDims(d, "16:9")).toEqual({ width: 1920, height: 1080 });
		expect(pickOutputDims(d, "9:16")).toEqual({ width: 1080, height: 1920 });
		expect(pickOutputDims(d, "1:1")).toEqual({ width: 1920, height: 1920 });
	});

	it("accepts a concrete non-preset token picked from the Original section", () => {
		const d = doc([asset("a1", 2560, 1080)], [clip("c1", "a1")]);
		expect(pickOutputDims(d, "64:27")).toEqual({ width: 2560, height: 1080 });
	});

	it("a stored shape no longer moves when a bigger clip of another shape is added", () => {
		const before = doc([asset("a1", 1920, 1080)], [clip("c1", "a1")]);
		const after = doc(
			[asset("a1", 1920, 1080), asset("a2", 2160, 3840)],
			[clip("c1", "a1"), clip("c2", "a2")],
		);
		const shapeOf = (d: AxcutDocument) => {
			const o = pickOutputDims(d, "16:9");
			return o.width / o.height;
		};
		expect(shapeOf(after)).toBeCloseTo(shapeOf(before), 6);
		// Resolution still follows the largest clip — that policy is unchanged.
		expect(pickOutputDims(after, "16:9")).toEqual({ width: 3840, height: 2160 });
	});

	it('legacy "native" still resolves to the reference asset, drift included', () => {
		const portraitWins = doc(
			[asset("a1", 1920, 1080), asset("a2", 2160, 3840)],
			[clip("c1", "a1"), clip("c2", "a2")],
		);
		expect(pickOutputDims(portraitWins, "native")).toEqual({ width: 2160, height: 3840 });
	});
});

describe("resolveAspectRatioValue", () => {
	it('resolves legacy "native" against the document instead of the 16/9 fallback', () => {
		const d = doc([asset("a1", 1080, 1920)], [clip("c1", "a1")]);
		expect(resolveAspectRatioValue(d, "native")).toBeCloseTo(1080 / 1920, 6);
	});

	it('falls back to 16/9 for "native" with no document (preview before load)', () => {
		expect(resolveAspectRatioValue(null, "native")).toBeCloseTo(16 / 9, 6);
	});

	it("passes concrete tokens straight through", () => {
		const d = doc([asset("a1", 1080, 1920)], [clip("c1", "a1")]);
		expect(resolveAspectRatioValue(d, "4:5")).toBeCloseTo(0.8, 6);
		expect(resolveAspectRatioValue(d, "64:27")).toBeCloseTo(64 / 27, 6);
	});
});
