import { describe, expect, it } from "vitest";
import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import { type AxcutDocument, createEmptyDocument } from "../schema";
import {
	appendAutoZoomSuggestions,
	collectAutoZoomSuggestionsForDocument,
} from "./apply-auto-zooms";

function dwell(
	centerMs: number,
	cx: number,
	cy: number,
	count = 6,
	spanMs = 900,
): CursorTelemetryPoint[] {
	const step = spanMs / (count - 1);
	return Array.from({ length: count }, (_, i) => ({
		timeMs: centerMs - spanMs / 2 + i * step,
		cx,
		cy,
	}));
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
			dwell(4000, 0.4, 0.6),
		);
		expect(suggestions).toHaveLength(1);
		expect(suggestions[0].span.start).toBe(3000);
		expect(suggestions[0].span.end).toBe(5000);
		expect(suggestions[0].focus.cx).toBeCloseTo(0.4, 5);
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
			dwell(1000, 0.5, 0.5),
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
			[{ span: { start: 3000, end: 5000 }, focus: { cx: 0.4, cy: 0.6 } }],
			(prefix) => `${prefix}_fixed`,
		);
		expect(next).not.toBe(document);
		expect(next.zoomRanges).toHaveLength(1);
		expect(next.zoomRanges[0]).toMatchObject({
			startMs: 3000,
			endMs: 5000,
			depth: 3,
			focusMode: "auto",
			clipId: "clip_1",
		});
	});
});
