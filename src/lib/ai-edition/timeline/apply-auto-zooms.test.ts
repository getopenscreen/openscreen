import { describe, expect, it, vi } from "vitest";
import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import { type AxcutDocument, createEmptyDocument } from "../schema";
import {
	appendAutoZoomSuggestions,
	collectAutoZoomSuggestionsForDocument,
	collectAutoZoomSuggestionsForLatestDocument,
} from "./apply-auto-zooms";

// A click at `atMs`, in a take whose pointer moves on until 9.5 s: the click is not its last.
function clickAt(atMs: number, cx: number, cy: number): CursorTelemetryPoint[] {
	return [
		{ timeMs: atMs - 300, cx, cy },
		{ timeMs: atMs, cx, cy, interactionType: "click" },
		{ timeMs: atMs + 300, cx, cy, interactionType: "mouseup" },
		{ timeMs: 9500, cx: 0.5, cy: 0.5 },
	];
}

function documentWithClip(durationSec = 10): AxcutDocument {
	const doc = createEmptyDocument({ projectId: "p1", title: "Recording" });
	return {
		...doc,
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "rec.mp4",
				originalPath: "C:\\recordings\\rec.mp4",
				cameraTrack: null,
				durationSec,
			},
		],
		project: { ...doc.project, primaryAssetId: "asset_1" },
		timeline: {
			...doc.timeline,
			clips: [
				{
					id: "clip_1",
					assetId: "asset_1",
					sourceStartSec: 0,
					sourceEndSec: durationSec,
					timelineStartSec: 0,
					timelineEndSec: durationSec,
					wordRefs: [],
					origin: "system",
					reason: "",
				},
			],
		},
	};
}

describe("collectAutoZoomSuggestionsForDocument", () => {
	it("builds suggestions from the asset's cursor sidecar", async () => {
		const document = documentWithClip();
		const suggestions = await collectAutoZoomSuggestionsForDocument(document, async () =>
			clickAt(4000, 0.4, 0.6),
		);
		expect(suggestions).toEqual([
			{ span: { start: 3500, end: 5500 }, focus: { cx: 0.4, cy: 0.6 }, depth: 3 },
		]);
	});

	it("asks for telemetry on the asset path, not a file URL", async () => {
		const document = documentWithClip();
		const paths: string[] = [];
		await collectAutoZoomSuggestionsForDocument(document, async (videoPath) => {
			paths.push(videoPath);
			return [];
		});
		expect(paths).toEqual(["C:\\recordings\\rec.mp4"]);
	});

	it("returns nothing without a clip window", async () => {
		const document = createEmptyDocument({ projectId: "p1", title: "Empty" });
		const suggestions = await collectAutoZoomSuggestionsForDocument(document, async () =>
			clickAt(4000, 0.5, 0.5),
		);
		expect(suggestions).toEqual([]);
	});

	it("plans every take on the timeline in one pass, so their zooms keep clear of each other", async () => {
		// Two takes back to back: each click's zoom is fine alone, but the pair would zoom out
		// at the cut and straight back in. Planned per take, both would stay.
		const first = documentWithClip();
		const document: AxcutDocument = {
			...first,
			assets: [
				...first.assets,
				{ ...first.assets[0], id: "asset_2", originalPath: "C:\\recordings\\second.mp4" },
			],
			timeline: {
				...first.timeline,
				clips: [
					...first.timeline.clips,
					{
						...first.timeline.clips[0],
						id: "clip_2",
						assetId: "asset_2",
						timelineStartSec: 10,
						timelineEndSec: 20,
					},
				],
			},
		};
		const suggestions = await collectAutoZoomSuggestionsForDocument(document, async (videoPath) =>
			videoPath.endsWith("second.mp4") ? clickAt(1000, 0.5, 0.5) : clickAt(7000, 0.5, 0.5),
		);
		expect(suggestions.map((s) => s.span)).toEqual([{ start: 6500, end: 8500 }]);
	});

	it("keeps clear of the zooms already on the timeline", async () => {
		const document: AxcutDocument = {
			...documentWithClip(),
			zoomRanges: [{ id: "z1", startMs: 3000, endMs: 5000, depth: 3, focus: { cx: 0.5, cy: 0.5 } }],
		};
		const suggestions = await collectAutoZoomSuggestionsForDocument(document, async () =>
			clickAt(6500, 0.4, 0.6),
		);
		expect(suggestions).toEqual([]);
	});
});

describe("appendAutoZoomSuggestions", () => {
	it("leaves the document unchanged when there is nothing to add", () => {
		const document = documentWithClip();
		expect(appendAutoZoomSuggestions(document, [])).toBe(document);
	});

	it("anchors each suggestion onto the clip", () => {
		const document = documentWithClip();
		const next = appendAutoZoomSuggestions(
			document,
			[{ span: { start: 3000, end: 5000 }, focus: { cx: 0.4, cy: 0.6 }, depth: 2 }],
			(prefix) => `${prefix}_fixed`,
		);
		expect(next).not.toBe(document);
		expect(next.zoomRanges).toHaveLength(1);
		expect(next.zoomRanges[0]).toMatchObject({
			startMs: 3000,
			endMs: 5000,
			depth: 2,
			focusMode: "auto",
			clipId: "clip_1",
		});
	});
});

describe("collectAutoZoomSuggestionsForLatestDocument", () => {
	const telemetry: CursorTelemetryPoint[] = [0, 600, 1200, 1800].map((timeMs) => ({
		timeMs,
		cx: 0.5,
		cy: 0.5,
	}));

	it("collects once when the clips stand still", async () => {
		const doc = documentWithClip();
		const getTelemetry = vi.fn(async () => telemetry);

		const out = await collectAutoZoomSuggestionsForLatestDocument(() => doc, getTelemetry);

		expect(out?.document).toBe(doc);
		expect(getTelemetry).toHaveBeenCalledTimes(1);
	});

	// THE case: the telemetry read takes seconds, and the suggestions carry timeline
	// spans that `appendAutoZoomSuggestions` will anchor against whatever the store
	// holds at write time. A trim landing in between makes the first collection
	// describe a timeline that no longer exists.
	it("collects again when the clips moved during the read", async () => {
		const before = documentWithClip();
		const after: AxcutDocument = {
			...before,
			timeline: {
				...before.timeline,
				clips: before.timeline.clips.map((clip) => ({ ...clip, sourceEndSec: 4 })),
			},
		};
		let current = before;
		const getTelemetry = vi.fn(async () => {
			current = after;
			return telemetry;
		});

		const out = await collectAutoZoomSuggestionsForLatestDocument(() => current, getTelemetry);

		expect(out?.document).toBe(after);
		expect(getTelemetry.mock.calls.length).toBeGreaterThan(1);
	});

	it("gives up when the project is gone", async () => {
		const getTelemetry = vi.fn(async () => telemetry);
		expect(await collectAutoZoomSuggestionsForLatestDocument(() => null, getTelemetry)).toBeNull();
		expect(getTelemetry).not.toHaveBeenCalled();
	});
});
