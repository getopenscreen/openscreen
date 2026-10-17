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

	it("advances sourceOffsetSec across clips/trims and preserves distinct assetId pills", () => {
		const baseDoc = duplicateClip(createTestMultiVideoDocument(), "clip_1");
		// Add a third video asset so we can test distinct assetId identity
		const doc = documentSchema.parse({
			...baseDoc,
			assets: [
				...baseDoc.assets,
				{
					id: "asset_cam2",
					kind: "video",
					label: "Angle 2",
					originalPath: "/tmp/angle2.mp4",
					durationSec: 20,
				},
			],
		});

		// Span 15s..25s crosses clip_1 (0..20) and clip_2 (20..40)
		const added = executeAgentTool(
			doc,
			"addVideoOverlay",
			JSON.stringify({
				assetId: "asset_demo",
				startSec: 15,
				endSec: 25,
				sourceOffsetSec: 2,
				muted: false,
				gainDb: -6,
			}),
		);
		expect(added.ok).toBe(true);
		const frags = added.document!.videoOverlayRanges ?? [];
		expect(frags).toHaveLength(2);
		expect(frags[0]).toMatchObject({
			startMs: 15000,
			endMs: 20000,
			sourceOffsetSec: 2,
			gainDb: -6,
		});
		expect(frags[1]).toMatchObject({
			startMs: 20000,
			endMs: 25000,
			sourceOffsetSec: 7,
			gainDb: -6,
		});

		// Updating layout + span simultaneously patches all resulting fragments
		const updated = executeAgentTool(
			added.document!,
			"setVideoOverlay",
			JSON.stringify({
				videoOverlayId: frags[0].id,
				startSec: 16,
				endSec: 26,
				layout: "top-bottom",
				gainDb: -3,
			}),
		);
		expect(updated.ok).toBe(true);
		const updatedFrags = updated.document!.videoOverlayRanges ?? [];
		expect(updatedFrags).toHaveLength(2);
		expect(updatedFrags[0]).toMatchObject({ layout: "top-bottom", gainDb: -3, sourceOffsetSec: 2 });
		expect(updatedFrags[1]).toMatchObject({ layout: "top-bottom", gainDb: -3, sourceOffsetSec: 6 });

		// Adjacent overlay with a different assetId does not coalesce with the first one
		const second = executeAgentTool(
			updated.document!,
			"addVideoOverlay",
			JSON.stringify({
				assetId: "asset_cam2",
				startSec: 26,
				endSec: 30,
				layout: "top-bottom",
				muted: false,
				gainDb: -3,
			}),
		);
		expect(second.ok).toBe(true);
		const snap = executeAgentTool(second.document!, "getCurrentDocument", "{}");
		const parsedSnap = JSON.parse(snap.resultJson);
		expect(parsedSnap.videoOverlays).toHaveLength(2);
		expect(parsedSnap.videoOverlays[0].assetId).toBe("asset_demo");
		expect(parsedSnap.videoOverlays[1].assetId).toBe("asset_cam2");
	});
});
