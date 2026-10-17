import { describe, expect, it } from "vitest";
import { executeAgentTool } from "../../../../electron/ai-edition/agent-tools";
import { buildSceneDescription } from "../../../native/sceneDescription";
import { createEmptyDocument, documentSchema } from "../schema";
import { clearEditRegions, countEditRegions, duplicateClip, removeRegion } from "./timeline";

function createTestMultiVideoDocument() {
	const base = createEmptyDocument({
		projectId: "proj_vov",
		title: "Multi-video Overlay Test",
		createdAt: "2026-01-01T00:00:00.000Z",
	});
	return documentSchema.parse({
		...base,
		project: { ...base.project, primaryAssetId: "asset_main" },
		assets: [
			{
				id: "asset_main",
				kind: "video",
				label: "Main Screen",
				originalPath: "/tmp/main.mp4",
				durationSec: 20,
				video: { width: 1920, height: 1080, fps: 60, codec: "h264" },
			},
			{
				id: "asset_demo",
				kind: "video",
				label: "Mobile Demo",
				originalPath: "/tmp/mobile.mp4",
				durationSec: 20,
				video: { width: 1080, height: 1920, fps: 60, codec: "h264" },
			},
		],
		timeline: {
			...base.timeline,
			clips: [
				{
					id: "clip_1",
					assetId: "asset_main",
					sourceStartSec: 0,
					sourceEndSec: 20,
					timelineStartSec: 0,
					timelineEndSec: 20,
					origin: "system",
				},
			],
		},
	});
}

describe("multi-video overlay / split-screen regions (issue #1316)", () => {
	it("validates videoOverlayRanges in documentSchema and preserves clip anchors across edits", () => {
		const doc = createTestMultiVideoDocument();
		const added = executeAgentTool(
			doc,
			"addVideoOverlay",
			JSON.stringify({
				assetId: "asset_demo",
				startSec: 2,
				endSec: 8,
				layout: "side-by-side",
				primaryPosition: "left",
				splitRatio: 0.6,
			}),
		);
		expect(added.ok).toBe(true);
		const afterAdd = added.document!;
		expect(afterAdd.videoOverlayRanges).toHaveLength(1);
		expect(afterAdd.videoOverlayRanges?.[0]).toMatchObject({
			assetId: "asset_demo",
			startMs: 2000,
			endMs: 8000,
			clipId: "clip_1",
			sourceStartSec: 2,
			sourceEndSec: 8,
			layout: "side-by-side",
			primaryPosition: "left",
			splitRatio: 0.6,
		});

		const overlayId = afterAdd.videoOverlayRanges![0].id;
		const updated = executeAgentTool(
			afterAdd,
			"setVideoOverlay",
			JSON.stringify({
				videoOverlayId: overlayId,
				layout: "wipe-compare",
				splitRatio: 0.45,
				startSec: 3,
				endSec: 9,
			}),
		);
		expect(updated.ok).toBe(true);
		expect(updated.document?.videoOverlayRanges?.[0]).toMatchObject({
			layout: "wipe-compare",
			splitRatio: 0.45,
			startMs: 3000,
			endMs: 9000,
		});

		// Duplicating the clip also duplicates its anchored videoOverlayRange
		const duplicated = duplicateClip(updated.document!, "clip_1");
		expect(duplicated.videoOverlayRanges).toHaveLength(2);

		// countEditRegions and clearEditRegions include videoOverlayRanges
		expect(countEditRegions(duplicated)).toBe(2);
		const cleared = clearEditRegions(duplicated);
		expect(cleared.videoOverlayRanges).toEqual([]);
	});

	it("projects videoOverlayRanges into SceneDescription and supports removeModifier", () => {
		const doc = createTestMultiVideoDocument();
		const added = executeAgentTool(
			doc,
			"addVideoOverlay",
			JSON.stringify({
				assetId: "asset_demo",
				startSec: 1,
				endSec: 5,
				layout: "pip",
				pipAnchor: "top-right",
				pipScale: 0.25,
			}),
		);
		expect(added.ok).toBe(true);
		const withOverlay = added.document!;

		const scene = buildSceneDescription(withOverlay);
		expect(scene.videoOverlayRegions).toHaveLength(1);
		expect(scene.videoOverlayRegions?.[0]).toMatchObject({
			assetId: "asset_demo",
			sourcePath: "/tmp/mobile.mp4",
			startSec: 1,
			endSec: 5,
			layout: "pip",
			pipAnchor: "top-right",
			pipScale: 0.25,
		});

		const overlayId = withOverlay.videoOverlayRanges![0].id;
		const removedByTool = executeAgentTool(
			withOverlay,
			"removeModifier",
			JSON.stringify({ id: overlayId }),
		);
		expect(removedByTool.ok).toBe(true);
		expect(removedByTool.document?.videoOverlayRanges).toEqual([]);

		const removedDirect = removeRegion(withOverlay, "videoOverlay", overlayId);
		expect(removedDirect.videoOverlayRanges).toEqual([]);
	});
});
