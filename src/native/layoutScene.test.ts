import { describe, expect, it } from "vitest";
import { addLayoutChange } from "@/lib/ai-edition/document/layout";
import {
	createEmptyDocument,
	documentSchema,
	migrateRawDocumentToCurrent,
} from "@/lib/ai-edition/schema";
import { buildSceneDescription } from "./sceneDescription";

function footage() {
	const doc = createEmptyDocument({ title: "Layouts", projectId: "layouts" });
	doc.assets = [
		{
			id: "asset",
			kind: "video",
			label: "Screen",
			originalPath: "/screen.mp4",
			video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
			cameraTrack: {
				sourcePath: "/camera.mp4",
				startMs: 0,
				offsetMs: 0,
				visible: true,
				width: 1280,
				height: 720,
			},
		},
	];
	doc.timeline.clips = [
		{
			id: "clip",
			assetId: "asset",
			sourceStartSec: 20,
			sourceEndSec: 30,
			timelineStartSec: 0,
			timelineEndSec: 10,
			origin: "user",
			reason: "",
			wordRefs: [],
		},
	];
	return doc;
}

describe("layout scene consumed by preview, MP4 and GIF", () => {
	it("projects passages into source time with full camera and no-webcam geometry", () => {
		const doc = addLayoutChange(addLayoutChange(footage(), 2, "camera-only"), 4, "no-webcam");
		const scene = buildSceneDescription(doc);
		expect(scene.layoutRegions?.map((r) => [r.clipIndex, r.startSec, r.endSec, r.preset])).toEqual([
			[0, 20, 22, "picture-in-picture"],
			[0, 22, 24, "camera-only"],
			[0, 24, 30, "no-webcam"],
		]);
		expect(scene.layoutRegions?.[1].layout.webcamRect).toEqual({ x: 0, y: 0, width: 1, height: 1 });
		expect(scene.layoutRegions?.[1].layout.webcamRadiusFrac).toBe(0);
		expect(scene.layoutRegions?.[2].layout.webcamRect).toBeNull();
		expect(scene.layoutRegions?.[1].transitionStartSec).toBe(22);
		expect(scene.cameraFullscreenRegions).toEqual([]);
	});
	it("does not restart an animation when a trim begins inside the passage", () => {
		const doc = addLayoutChange(footage(), 2, "camera-only");
		doc.timeline.trimRanges = [
			{
				id: "cut",
				assetId: "asset",
				clipId: "clip",
				startSec: 20,
				endSec: 22.5,
				origin: "user",
				reason: "",
			},
		];
		const region = buildSceneDescription(doc).layoutRegions?.find(
			(r) => r.preset === "camera-only",
		);
		expect(region?.startSec).toBe(22.5);
		expect(region?.transitionStartSec).toBe(22);
	});
	it("resolves missing webcams per clip without reserving an empty camera slot", () => {
		const doc = addLayoutChange(footage(), 2, "dual-frame");
		doc.assets[0].cameraTrack = null;
		const scene = buildSceneDescription(doc);
		expect(
			scene.layoutRegions?.every((r) => r.preset === "no-webcam" && r.layout.webcamRect === null),
		).toBe(true);
	});
	it("keeps the migrated camera envelope over its original base layout", () => {
		const old = footage();
		old.legacyEditor = {
			webcamLayoutPreset: "dual-frame",
			cameraFullscreenRegions: [{ id: "full", startMs: 2000, endMs: 8000 }],
		};
		const doc = documentSchema.parse(migrateRawDocumentToCurrent({ ...old, schemaVersion: 7 }));
		const scene = buildSceneDescription(doc);
		expect(scene.cameraFullscreenRegions).toEqual([{ clipIndex: 0, startSec: 22, endSec: 28 }]);
		expect(scene.layoutRegions?.find((r) => r.startSec === 22)?.preset).toBe("dual-frame");
		expect(scene.layoutRegions?.find((r) => r.startSec === 28)?.transitionSec).toBe(0);
	});
	it("resolves reactive webcam scaling for each passage independently", () => {
		const doc = footage();
		doc.legacyEditor = { webcamLayoutPreset: "dual-frame", webcamReactiveZoom: true };
		const scene = buildSceneDescription(addLayoutChange(doc, 2, "picture-in-picture"));
		expect(scene.layoutRegions?.map((r) => r.webcamReactiveZoom)).toEqual([false, true]);
	});
	it("carries both crop and reactive-camera endpoints through top/bottom → PiP → side-by-side", () => {
		const doc = footage();
		doc.legacyEditor = { webcamLayoutPreset: "vertical-stack", webcamReactiveZoom: true };
		const scene = buildSceneDescription(
			addLayoutChange(addLayoutChange(doc, 2, "picture-in-picture"), 4, "dual-frame"),
		);
		const pip = scene.layoutRegions?.[1];
		expect(pip?.fromPreset).toBe("vertical-stack");
		expect(pip?.fromLayout?.screenCover).toBe(true);
		expect(pip?.layout.screenCover).toBe(false);
		expect(pip?.fromWebcamReactiveZoom).toBe(false);
		expect(pip?.webcamReactiveZoom).toBe(true);
		const side = scene.layoutRegions?.[2];
		expect(side?.fromPreset).toBe("picture-in-picture");
		expect(side?.fromWebcamReactiveZoom).toBe(true);
		expect(side?.webcamReactiveZoom).toBe(false);
	});
});
