// The decision a `loadedmetadata` event makes, on its own.
//
// The event itself arrives through Preview -> PreviewCanvas -> VirtualPreview and a
// real <video>, which no test environment here can decode, so the component cannot be
// driven end to end. `documentAfterProbedDuration` is the part that decides what gets
// written, and every guard below lives in it: the queue the shell puts this write on
// is what makes them necessary, because it puts real time between the event and the
// write. The queue's own serialization is covered by useSequentialTimelineOps.test.
import { describe, expect, it } from "vitest";
import { type AxcutDocument, createEmptyDocument, documentSchema } from "@/lib/ai-edition/schema";
import { migrateProjectDataToAxcutDocument } from "./migrate";
import { documentAfterProbedDuration } from "./timeline";

const PROJECT = "proj_a";

/** A fresh import: assets on the document, nothing on the timeline yet. */
function emptyTimeline(primaryAssetId: string, assetIds: string[]): AxcutDocument {
	const doc = createEmptyDocument({ projectId: PROJECT, title: "A" });
	return {
		...doc,
		project: { ...doc.project, primaryAssetId },
		assets: assetIds.map((id) => ({
			id,
			kind: "video" as const,
			label: `${id}.mp4`,
			originalPath: `/tmp/${id}.mp4`,
			cameraTrack: null,
		})),
	};
}

/** A v1.7 project: one clip with no source extent, waiting for a real length. */
function legacyWithClip(): AxcutDocument {
	return documentSchema.parse(
		migrateProjectDataToAxcutDocument({
			version: 2,
			videoPath: "C:/rec/screen.webm",
			media: { videoPath: "C:/rec/screen.webm" },
			editor: {
				zoomRegions: [],
				annotationRegions: [],
				trimRegions: [],
				speedRegions: [],
				cameraFullscreenRegions: [],
			},
		} as never),
	);
}

describe("documentAfterProbedDuration", () => {
	it("resolves a missing primary asset before seeding the fallback", () => {
		const doc = emptyTimeline("deleted_asset", ["asset_1", "asset_2"]);
		const next = documentAfterProbedDuration(doc, "asset_1", 30, PROJECT);
		expect(next?.project.primaryAssetId).toBe("asset_1");
		expect(next?.timeline.clips).toHaveLength(1);
		expect(next?.timeline.clips[0]).toMatchObject({
			assetId: "asset_1",
			sourceStartSec: 0,
			sourceEndSec: 30,
		});
		expect(next?.assets[1].durationSec).toBeUndefined();
		expect(doc.project.primaryAssetId).toBe("deleted_asset");
		expect(documentAfterProbedDuration(doc, "asset_2", 30, PROJECT)).toBeNull();
	});

	it("keeps a valid primary asset even when it is not first", () => {
		const doc = emptyTimeline("asset_2", ["asset_1", "asset_2"]);
		expect(documentAfterProbedDuration(doc, "asset_1", 30, PROJECT)).toBeNull();
		const next = documentAfterProbedDuration(doc, "asset_2", 30, PROJECT);
		expect(next?.project.primaryAssetId).toBe("asset_2");
		expect(next?.timeline.clips[0].assetId).toBe("asset_2");
	});

	it("seeds a full-duration clip when the primary asset reports its length", () => {
		const doc = emptyTimeline("asset_1", ["asset_1"]);

		const next = documentAfterProbedDuration(doc, "asset_1", 30, PROJECT);

		expect(next).not.toBeNull();
		expect(next?.assets[0].durationSec).toBe(30);
		expect(next?.timeline.clips).toHaveLength(1);
		expect(next?.timeline.clips[0].timelineStartSec).toBe(0);
		expect(next?.timeline.clips[0].timelineEndSec).toBe(30);
	});

	// The write is queued, so the user can switch projects between the event and this
	// decision. `knownSec` came off the OLD video; applying it to whatever is loaded
	// now writes one recording's length into another project.
	it("writes nothing when the project changed after the event fired", () => {
		const doc = emptyTimeline("asset_1", ["asset_1"]);

		expect(documentAfterProbedDuration(doc, "asset_1", 30, "proj_switched_to")).toBeNull();
		expect(documentAfterProbedDuration(doc, "asset_1", 30, undefined)).toBeNull();
	});

	// `replaceTimeline` pins every clip it builds to the primary asset, and the seed
	// sizes that clip from `knownSec` — so seeding on another asset's event would put
	// one video's length under a different asset's id. The primary's own event seeds it.
	it("does not seed from an asset that is not the one the seed is about", () => {
		const doc = emptyTimeline("asset_1", ["asset_1", "asset_2"]);

		expect(documentAfterProbedDuration(doc, "asset_2", 30, PROJECT)).toBeNull();
		// And the primary still seeds normally on the same document.
		expect(documentAfterProbedDuration(doc, "asset_1", 30, PROJECT)).not.toBeNull();
	});

	it("folds the length into a clip that was waiting for one", () => {
		const doc = legacyWithClip();
		const assetId = doc.assets[0].id;

		const next = documentAfterProbedDuration(doc, assetId, 30, doc.project.id);

		expect(next?.timeline.clips[0].sourceEndSec).toBe(30);
		expect(next?.assets[0].durationSec).toBe(30);
	});

	it("writes nothing when the length is already recorded", () => {
		const doc = legacyWithClip();
		const assetId = doc.assets[0].id;
		const settled = documentAfterProbedDuration(doc, assetId, 30, doc.project.id);

		expect(settled).not.toBeNull();
		expect(
			documentAfterProbedDuration(settled as AxcutDocument, assetId, 30, doc.project.id),
		).toBeNull();
	});

	// Empty is not the same as unseeded — the user can delete their only clip — and
	// `knownSec` is 60 whenever the <video> reports a non-finite duration. Overwriting
	// here traded a real length for the fallback under `history: false`.
	it("keeps a length the asset already carries, and sizes the seed against it", () => {
		const doc = emptyTimeline("asset_1", ["asset_1"]);
		const measured: AxcutDocument = {
			...doc,
			assets: doc.assets.map((a) => ({ ...a, durationSec: 26.517 })),
		};

		const next = documentAfterProbedDuration(measured, "asset_1", 60, PROJECT);

		expect(next?.assets[0].durationSec).toBe(26.517);
		expect(next?.timeline.clips[0].timelineEndSec).toBeCloseTo(26.517, 3);
	});

	it("writes nothing without a document or without assets", () => {
		expect(documentAfterProbedDuration(null, "asset_1", 30, PROJECT)).toBeNull();
		expect(
			documentAfterProbedDuration(emptyTimeline("asset_1", []), "asset_1", 30, PROJECT),
		).toBeNull();
	});
});
