import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	type AxcutAnnotationRegion,
	type AxcutDocument,
	createEmptyDocument,
	documentSchema,
} from "../../src/lib/ai-edition/schema";
import { ZOOM_DEPTH_SCALES } from "../../src/lib/ai-edition/timeline/zoom-scale";
import { zoomScaleLimit } from "../../src/native/sceneDescription";
import {
	type AgentToolOptions,
	addZoomArgs,
	executeAgentTool,
	isMutatingTool,
	MUTATING_TOOL_NAMES,
	shaderEffectCheckLookup,
	shaderEffectToCheck,
} from "./agent-tools";
import { measureTextInShippedFonts } from "./text-measure";

/** ponytail: every fixture in this file starts from the SAME instant.
 *  `createEmptyDocument` reads the wall clock when a caller hands it no
 *  `createdAt`, so two documents built by two calls carry different
 *  `createdAt`/`updatedAt` whenever the calls straddle a millisecond — and any
 *  assertion that compares two of them is a coin flip on a loaded runner. That
 *  already failed a PR touching none of this code. No test here reads the value,
 *  so pinning it costs nothing and makes every document in the file comparable. */
const FIXTURE_CREATED_AT = "2026-01-01T00:00:00.000Z";

/** Where an annotation's box is centred, in frame percentages. */
function centreOf(region: Pick<AxcutAnnotationRegion, "position" | "size"> | undefined) {
	if (!region) return undefined;
	return {
		x: region.position.x + region.size.width / 2,
		y: region.position.y + region.size.height / 2,
	};
}

function fixtureDocument(): AxcutDocument {
	const base = createEmptyDocument({
		title: "Test",
		projectId: "proj_1",
		createdAt: FIXTURE_CREATED_AT,
	});
	return documentSchema.parse({
		...base,
		project: { ...base.project, primaryAssetId: "asset_1" },
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "Recording",
				originalPath: "C:/videos/rec.mp4",
				durationSec: 60,
			},
		],
		transcripts: [
			{
				assetId: "asset_1",
				language: "en",
				segments: [
					{ id: "seg_1", kind: "speech", startSec: 0, endSec: 5, text: "Hello", wordIds: [] },
					{ id: "seg_2", kind: "silence", startSec: 5, endSec: 8, text: "", wordIds: [] },
				],
				words: [],
			},
		],
		timeline: {
			...base.timeline,
			clips: [
				{
					id: "clip_1",
					assetId: "asset_1",
					sourceStartSec: 0,
					sourceEndSec: 30,
					timelineStartSec: 0,
					timelineEndSec: 30,
					wordRefs: [],
					origin: "user",
					reason: "",
				},
				{
					id: "clip_2",
					assetId: "asset_1",
					sourceStartSec: 30,
					sourceEndSec: 60,
					timelineStartSec: 30,
					timelineEndSec: 60,
					wordRefs: [],
					origin: "user",
					reason: "",
				},
			],
			trimRanges: [
				{
					id: "trim_1",
					assetId: "asset_1",
					startSec: 10,
					endSec: 12,
					reason: "",
					origin: "user",
				},
			],
		},
	});
}

/** One clip whose end is NOT a round number — the real recording length that
 * made the clamp visible (24.703979 s of source, stored as 24 704 ms). */
function shortSingleClip(): AxcutDocument {
	const base = createEmptyDocument({
		title: "Short",
		projectId: "proj_short",
		createdAt: FIXTURE_CREATED_AT,
	});
	return documentSchema.parse({
		...base,
		project: { ...base.project, primaryAssetId: "asset_1" },
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "Recording",
				originalPath: "C:/videos/rec.mp4",
				durationSec: 24.703979,
			},
		],
		timeline: {
			...base.timeline,
			clips: [
				{
					id: "clip_1",
					assetId: "asset_1",
					sourceStartSec: 0,
					sourceEndSec: 24.703979,
					timelineStartSec: 0,
					timelineEndSec: 24.703979,
					wordRefs: [],
					origin: "user",
					reason: "",
				},
			],
		},
	});
}

/** The same document with a webcam linked to its asset. Two projects that
 * differ ONLY here were indistinguishable to the model before `hasCameraTrack`
 * reached the snapshot. */
function withCameraTrack(document: AxcutDocument): AxcutDocument {
	return documentSchema.parse({
		...document,
		assets: document.assets.map((a) => ({
			...a,
			cameraTrack: { sourcePath: "C:/videos/cam.mp4", startMs: 0, offsetMs: 0, visible: true },
		})),
	});
}

/** A zoom carrying BOTH depth and customScale — the state `migrate.ts` leaves a
 * v1.7 project in, where the depth is inert at render. */
function zoomWithCustomScale(document: AxcutDocument, customScale: number): AxcutDocument {
	return documentSchema.parse({
		...document,
		zoomRanges: [
			{
				id: "zoom_1",
				startMs: 2_000,
				endMs: 6_000,
				clipId: "clip_1",
				sourceStartSec: 2,
				sourceEndSec: 6,
				depth: 3,
				focus: { cx: 0.5, cy: 0.5 },
				focusMode: "manual",
				customScale,
				source: "manual",
			},
		],
	});
}

describe("the mutating-tool table", () => {
	it("names every write and nothing else", () => {
		// ponytail: this used to read the `name`/`mutating` pairs off
		// AGENT_TOOL_SPECS, ~300 lines of JSON schema whose comment claimed it was
		// "sent verbatim to the provider" and which had not reached a provider in a
		// release. The names are now pinned where they are actually built — see
		// deep-agent/service.test.ts, which ties TOOL_DESCRIPTIONS, buildTools and
		// this executor's switch to one another. What is left here is the one thing
		// the specs carried that production still needs: which tools write.
		expect([...MUTATING_TOOL_NAMES].sort()).toEqual(
			[
				"addAnnotation",
				"addAudio",
				"addCameraFullscreen",
				"addEffect",
				"addSpeed",
				"addTrim",
				"addTrims",
				"addZoom",
				"addZooms",
				"addAutoZooms",
				"duplicateClip",
				"insertClip",
				"moveClip",
				"removeClip",
				"removeModifier",
				"removeTrim",
				"removeWords",
				"replaceTimeline",
				"setAnnotation",
				"setAspectRatio",
				"setAudio",
				"setCameraFullscreen",
				"setClipRange",
				"setEffect",
				"setEffectDefinition",
				"setEditorSettings",
				"setSpeed",
				"setTrim",
				"setWordText",
				"setZoom",
				"setCaptionSettings",
				"putCaptionTranslation",
				"removeCaptionTranslation",
				"setVocabulary",
			].sort(),
		);
		expect(isMutatingTool("getCurrentDocument")).toBe(false);
		expect(isMutatingTool("getTranscript")).toBe(false);
		expect(isMutatingTool("replaceTimeline")).toBe(true);
		expect(isMutatingTool("addZoom")).toBe(true);
		expect(isMutatingTool("setAnnotation")).toBe(true);
		expect(isMutatingTool("removeTrim")).toBe(true);
		expect(isMutatingTool("removeModifier")).toBe(true);
		expect(isMutatingTool("removeClip")).toBe(true);
		expect(isMutatingTool("nope")).toBe(false);
	});
});

describe("executeAgentTool", () => {
	it("getCurrentDocument returns a compact snapshot with ids and times", () => {
		const result = executeAgentTool(fixtureDocument(), "getCurrentDocument", "");
		expect(result.ok).toBe(true);
		const snapshot = JSON.parse(result.resultJson);
		expect(snapshot.primaryAssetId).toBe("asset_1");
		expect(snapshot.clips.map((c: { id: string }) => c.id)).toEqual(["clip_1", "clip_2"]);
		expect(snapshot.trimRanges[0].id).toBe("trim_1");
		expect(snapshot.hasTranscript).toBe(true);
		expect(result.document).toBeUndefined();
	});

	it("getTranscript returns segments for the primary asset by default", () => {
		const result = executeAgentTool(fixtureDocument(), "getTranscript", "{}");
		expect(result.ok).toBe(true);
		const payload = JSON.parse(result.resultJson);
		expect(payload.assetId).toBe("asset_1");
		expect(payload.segments).toHaveLength(2);
		expect(payload.segments[1].kind).toBe("silence");
	});

	it("getTranscript returns a long transcript whole, word for word", () => {
		// The regression test for a `.slice(0, 800)` that used to sit here. On the
		// production path a segment is one WORD, so the cap cut a half-hour
		// recording at roughly its fifth minute and reported nothing — the model
		// trimmed the silences it could see and called the job done. 4000 words is
		// about half an hour of speech.
		const base = fixtureDocument();
		const segments = Array.from({ length: 4000 }, (_, i) => ({
			id: `seg_${i}`,
			kind: "speech" as const,
			startSec: i * 0.45,
			endSec: i * 0.45 + 0.4,
			text: `mot${i}`,
			wordIds: [],
		}));
		const doc = {
			...base,
			transcript: null,
			transcripts: [{ ...base.transcripts[0], segments }],
		};

		const result = executeAgentTool(doc, "getTranscript", "{}");
		expect(result.ok).toBe(true);
		const payload = JSON.parse(result.resultJson);
		expect(payload.segments).toHaveLength(4000);
		// The last word matters more than the count: a cap keeps the head and
		// drops the tail, so the tail is what proves it is gone.
		expect(payload.segments.at(-1).text).toBe("mot3999");
	});

	it("getTranscript fails cleanly when no transcript exists", () => {
		const doc = { ...fixtureDocument(), transcripts: [], transcript: null };
		const result = executeAgentTool(doc, "getTranscript", "{}");
		expect(result.ok).toBe(false);
		expect(JSON.parse(result.resultJson).error).toMatch(/No transcript/);
	});

	it("addTrim appends an agent-origin skip range and normalizes reversed bounds", () => {
		const result = executeAgentTool(
			fixtureDocument(),
			"addTrim",
			JSON.stringify({ startSec: 22, endSec: 20, reason: "silence" }),
		);
		expect(result.ok).toBe(true);
		expect(result.document).toBeDefined();
		const added = result.document?.timeline.trimRanges.at(-1);
		expect(added?.startSec).toBe(20);
		expect(added?.endSec).toBe(22);
		expect(added?.origin).toBe("agent");
		expect(result.summary).toMatch(/added trim 0:20\.0 – 0:22\.0/);
	});

	it("addTrims lands exactly what the same calls one at a time would", () => {
		// The property the batch tools exist to have: they save round trips and
		// change nothing else. If this ever diverges, the batch has grown a second
		// implementation of the rules and the two will drift.
		const ranges = [
			{ startSec: 1, endSec: 2, reason: "silence" },
			{ startSec: 40, endSec: 41, reason: "silence" },
			{ startSec: 5, endSec: 4, reason: "silence" }, // reversed on purpose
		];

		let oneAtATime = fixtureDocument();
		for (const range of ranges) {
			const step = executeAgentTool(oneAtATime, "addTrim", JSON.stringify(range));
			expect(step.ok).toBe(true);
			oneAtATime = step.document as AxcutDocument;
		}

		const batch = executeAgentTool(fixtureDocument(), "addTrims", JSON.stringify({ ranges }));
		expect(batch.ok).toBe(true);

		const shape = (doc: AxcutDocument) =>
			doc.timeline.trimRanges.map((t) => ({
				startSec: t.startSec,
				endSec: t.endSec,
				reason: t.reason,
				origin: t.origin,
				clipId: t.clipId,
			}));
		expect(shape(batch.document as AxcutDocument)).toEqual(shape(oneAtATime));
	});

	it("addTrims applies the good ranges and refuses the bad one by itself", () => {
		// `replaceTimeline`, the repo's other array-taking tool, refuses in one
		// block. That is right for rebuilding a timeline and ruinous here: one bad
		// bound must not cost the other nine, and the model must be able to see
		// WHICH one without re-reading the document.
		const result = executeAgentTool(
			fixtureDocument(),
			"addTrims",
			JSON.stringify({
				ranges: [
					{ startSec: 1, endSec: 2 },
					{ startSec: 25, endSec: 35 }, // spans both clips of asset_1 — ambiguous
					{ startSec: 40, endSec: 41 },
				],
			}),
		);

		expect(result.ok).toBe(true);
		const payload = JSON.parse(result.resultJson);
		expect(payload.requested).toBe(3);
		expect(payload.appliedCount).toBe(2);
		expect(payload.refusedCount).toBe(1);
		expect(payload.refused).toHaveLength(1);
		expect(payload.refused[0].index).toBe(1);
		// The refusal keeps the unitary wording, which names the clips and the fix.
		expect(payload.refused[0].error).toMatch(/clipId/);
		expect(payload.applied.map((a: { index: number }) => a.index)).toEqual([0, 2]);
		// The fixture starts with one trim; two more landed.
		expect(result.document?.timeline.trimRanges).toHaveLength(3);
		expect(result.summary).toMatch(/added 2 trims, 1 refused/);
	});

	it("addTrims refuses a MALFORMED range by itself, not the whole call", () => {
		// The batch schema advertises the element shape without enforcing it, so a
		// bad entry reaches the unitary executor and is refused at its index. If it
		// were enforced at the container, one typo would cost every other cut —
		// which is precisely what `applyBatch` says it exists to prevent.
		const result = executeAgentTool(
			fixtureDocument(),
			"addTrims",
			JSON.stringify({
				ranges: [{ startSec: 1, endSec: 2 }, { startSec: "oops" }, { startSec: 40, endSec: 41 }],
			}),
		);

		expect(result.ok).toBe(true);
		const payload = JSON.parse(result.resultJson);
		expect(payload.appliedCount).toBe(2);
		expect(payload.refused).toEqual([{ index: 1, error: expect.stringMatching(/endSec/) }]);
		expect(result.document?.timeline.trimRanges).toHaveLength(3);
	});

	it("addZooms refuses a MALFORMED region by itself, not the whole call", () => {
		const result = executeAgentTool(
			fixtureDocument(),
			"addZooms",
			JSON.stringify({
				regions: [
					{ startSec: 1, endSec: 3, depth: 9 }, // depth is an ordinal 1–6
					{ startSec: 10, endSec: 12 },
				],
			}),
		);

		expect(result.ok).toBe(true);
		const payload = JSON.parse(result.resultJson);
		expect(payload.appliedCount).toBe(1);
		expect(payload.refused[0].index).toBe(0);
		expect(result.document?.zoomRanges).toHaveLength(1);
	});

	it("addTrims still refuses a batch that is not a non-empty list", () => {
		for (const args of ['{"ranges":[]}', '{"ranges":"1-2"}', "{}"]) {
			const result = executeAgentTool(fixtureDocument(), "addTrims", args);
			expect(result.ok).toBe(false);
			expect(result.document).toBeUndefined();
		}
	});

	it("addTrims reports a whole-batch refusal as a failure, not an empty success", () => {
		const result = executeAgentTool(
			fixtureDocument(),
			"addTrims",
			JSON.stringify({
				ranges: [
					{ startSec: 1, endSec: 2, assetId: "asset_missing" },
					{ startSec: 3, endSec: 4, assetId: "asset_missing" },
				],
			}),
		);
		expect(result.ok).toBe(false);
		expect(result.document).toBeUndefined();
		const error = JSON.parse(result.resultJson).error;
		expect(error).toMatch(/\[0\]/);
		expect(error).toMatch(/\[1\]/);
		expect(error).toMatch(/Nothing was modified/);
	});

	it("addZooms lands the reachable regions and names the one covering no clip", () => {
		const result = executeAgentTool(
			fixtureDocument(),
			"addZooms",
			JSON.stringify({
				regions: [
					{ startSec: 1, endSec: 3, depth: 2 },
					{ startSec: 400, endSec: 402 }, // past the end of the timeline
					{ startSec: 10, endSec: 12, depth: 4 },
				],
			}),
		);

		expect(result.ok).toBe(true);
		const payload = JSON.parse(result.resultJson);
		expect(payload.appliedCount).toBe(2);
		expect(payload.refused[0].index).toBe(1);
		// Each applied entry still carries what the unitary tool reports, so the
		// model can quote the rendered scale instead of the depth ordinal.
		expect(payload.applied[0].renderedScale).toBe(ZOOM_DEPTH_SCALES[2]);
		expect(payload.applied[1].renderedScale).toBe(ZOOM_DEPTH_SCALES[4]);
		expect(result.document?.zoomRanges).toHaveLength(2);
	});

	it("addZooms leaves overlapping regions overlapping, exactly as one-at-a-time does", () => {
		// A deliberate non-decision, pinned so it stays deliberate.
		//
		// `timelineMap.ts` forbids a moved zoom from overlapping another zoom,
		// but only the `set*` path clamps (via `replacePillSpan`) —
		// no `add*` does, in the agent OR in the UI. So two overlapping addZoom
		// calls already produce an overlapping document today. Deconflicting
		// inside the batch would make `addZooms` mean something its unitary
		// sibling does not, and the model would get different results depending on
		// how it chose to group its calls. The batch saves round trips; it does
		// not quietly hold different rules. The bench still flags the overlap
		// (`editorial.ts` zoomIssues), which is where that argument belongs.
		const regions = [
			{ startSec: 1, endSec: 6 },
			{ startSec: 4, endSec: 9 },
		];

		let oneAtATime = fixtureDocument();
		for (const region of regions) {
			oneAtATime = executeAgentTool(oneAtATime, "addZoom", JSON.stringify(region))
				.document as AxcutDocument;
		}
		const batch = executeAgentTool(fixtureDocument(), "addZooms", JSON.stringify({ regions }));

		const spans = (doc: AxcutDocument) =>
			doc.zoomRanges.map((z) => ({ startMs: z.startMs, endMs: z.endMs, depth: z.depth }));
		expect(spans(batch.document as AxcutDocument)).toEqual(spans(oneAtATime));
		expect(batch.document?.zoomRanges).toHaveLength(2);
	});

	it("addTrim rejects unknown assets", () => {
		const result = executeAgentTool(
			fixtureDocument(),
			"addTrim",
			JSON.stringify({ startSec: 0, endSec: 1, assetId: "asset_missing" }),
		);
		expect(result.ok).toBe(false);
		expect(result.document).toBeUndefined();
	});

	it("setTrim moves an existing range and errors on unknown ids", () => {
		const ok = executeAgentTool(
			fixtureDocument(),
			"setTrim",
			JSON.stringify({ trimRangeId: "trim_1", startSec: 14, endSec: 18 }),
		);
		expect(ok.ok).toBe(true);
		expect(ok.document?.timeline.trimRanges[0]).toMatchObject({ startSec: 14, endSec: 18 });

		const missing = executeAgentTool(
			fixtureDocument(),
			"setTrim",
			JSON.stringify({ trimRangeId: "trim_x", startSec: 0, endSec: 1 }),
		);
		expect(missing.ok).toBe(false);
	});

	it("setClipRange trims the clip and resequences downstream clips", () => {
		const result = executeAgentTool(
			fixtureDocument(),
			"setClipRange",
			JSON.stringify({ clipId: "clip_1", sourceStartSec: 0, sourceEndSec: 10 }),
		);
		expect(result.ok).toBe(true);
		const clips = result.document?.timeline.clips ?? [];
		expect(clips[0]).toMatchObject({
			sourceEndSec: 10,
			timelineStartSec: 0,
			timelineEndSec: 10,
		});
		// Downstream clip reflows to start where the trimmed clip now ends.
		expect(clips[1]).toMatchObject({ timelineStartSec: 10, timelineEndSec: 40 });
	});

	it("setClipRange clamps/drops anchored pills and refreshes the reflowed ones' ms cache", () => {
		const doc = fixtureDocument();
		const withZooms: AxcutDocument = {
			...doc,
			zoomRanges: [
				// On clip_1 (window becomes [0,10]): one inside survives, one past the new end is dropped.
				{
					id: "z_in",
					startMs: 5000,
					endMs: 8000,
					clipId: "clip_1",
					sourceStartSec: 5,
					sourceEndSec: 8,
					depth: 3,
					focus: { cx: 0.5, cy: 0.5 },
				},
				{
					id: "z_out",
					startMs: 15000,
					endMs: 20000,
					clipId: "clip_1",
					sourceStartSec: 15,
					sourceEndSec: 20,
					depth: 3,
					focus: { cx: 0.5, cy: 0.5 },
				},
				// On clip_2 (reflows 30→10): unchanged window, but its derived ms must follow the shift.
				{
					id: "z_shift",
					startMs: 40000,
					endMs: 45000,
					clipId: "clip_2",
					sourceStartSec: 40,
					sourceEndSec: 45,
					depth: 3,
					focus: { cx: 0.5, cy: 0.5 },
				},
			] as unknown as AxcutDocument["zoomRanges"],
		};
		const result = executeAgentTool(
			withZooms,
			"setClipRange",
			JSON.stringify({ clipId: "clip_1", sourceStartSec: 0, sourceEndSec: 10 }),
		);
		expect(result.ok).toBe(true);
		const zooms = result.document?.zoomRanges ?? [];
		expect([...zooms.map((z) => z.id)].sort()).toEqual(["z_in", "z_shift"]);
		expect(zooms.find((z) => z.id === "z_in")).toMatchObject({
			sourceStartSec: 5,
			sourceEndSec: 8,
			startMs: 5000,
			endMs: 8000,
		});
		// clip_2 moved from tl 30 to tl 10, so z_shift's raw ms drops by 20s.
		expect(zooms.find((z) => z.id === "z_shift")).toMatchObject({ startMs: 20000, endMs: 25000 });
	});

	it("replaceTimeline rebuilds clips and inverse skip ranges", () => {
		const doc = fixtureDocument();
		// Test the rebuild path: strip user-placed clips first so the tool
		// is allowed to operate (it refuses when origin:user clips are present).
		const stripped: AxcutDocument = {
			...doc,
			timeline: { ...doc.timeline, clips: [] },
		};
		const result = executeAgentTool(
			stripped,
			"replaceTimeline",
			JSON.stringify({
				intervals: [
					{ startSec: 0, endSec: 10 },
					{ startSec: 20, endSec: 30 },
				],
				reason: "cut silences",
			}),
		);
		expect(result.ok).toBe(true);
		const timeline = result.document?.timeline;
		expect(timeline?.clips).toHaveLength(2);
		expect(timeline?.trimRanges.map((s) => [s.startSec, s.endSec])).toEqual([
			[10, 20],
			[30, 60],
		]);
		expect(result.summary).toMatch(/2 intervals/);
	});

	it("replaceTimeline refuses to shorten a clip out of existence", () => {
		const result = executeAgentTool(
			fixtureDocument(),
			"replaceTimeline",
			JSON.stringify({
				intervals: [{ startSec: 0, endSec: 30 }],
				reason: "remove silences",
			}),
		);
		expect(result.ok).toBe(false);
		const payload = JSON.parse(result.resultJson) as { error: string; lostClipIds: string[] };
		expect(payload.lostClipIds).toEqual(["clip_2"]);
		expect(payload.error).toMatch(/clip_2/);
		expect(payload.error).toMatch(/addTrim/);
		expect(result.document).toBeUndefined();
	});

	it("rejects malformed JSON arguments and unknown tools", () => {
		expect(executeAgentTool(fixtureDocument(), "addTrim", "{not json").ok).toBe(false);
		expect(executeAgentTool(fixtureDocument(), "flyToTheMoon", "{}").ok).toBe(false);
	});

	it("addZoom adds a schema-valid zoom in virtual-ms and normalizes bounds", () => {
		const result = executeAgentTool(
			fixtureDocument(),
			"addZoom",
			JSON.stringify({ startSec: 12, endSec: 8, depth: 4, focus: { cx: 0.3, cy: 0.7 } }),
		);
		expect(result.ok).toBe(true);
		const zoom = result.document?.zoomRanges.at(-1);
		expect(zoom).toMatchObject({
			startMs: 8000,
			endMs: 12000,
			depth: 4,
			focus: { cx: 0.3, cy: 0.7 },
		});
		// The produced document must round-trip through the schema.
		expect(() => documentSchema.parse(result.document)).not.toThrow();
	});

	it("setZoom patches only the fields passed", () => {
		const withZoom = executeAgentTool(
			fixtureDocument(),
			"addZoom",
			JSON.stringify({ startSec: 2, endSec: 4 }),
		).document as AxcutDocument;
		const id = withZoom.zoomRanges[0].id;
		const result = executeAgentTool(withZoom, "setZoom", JSON.stringify({ zoomId: id, depth: 6 }));
		expect(result.ok).toBe(true);
		expect(result.document?.zoomRanges[0]).toMatchObject({ startMs: 2000, endMs: 4000, depth: 6 });
		expect(executeAgentTool(withZoom, "setZoom", JSON.stringify({ zoomId: "nope" })).ok).toBe(
			false,
		);
	});

	it("sets a zoom's 3D camera, reports it, and takes it back off with none", () => {
		const added = executeAgentTool(
			fixtureDocument(),
			"addZoom",
			JSON.stringify({ startSec: 2, endSec: 4, rotationPreset: "orbit" }),
		);
		expect(added.ok).toBe(true);
		const withZoom = added.document as AxcutDocument;
		expect(withZoom.zoomRanges[0]).toMatchObject({ rotationPreset: "orbit" });
		expect(JSON.parse(added.resultJson)).toMatchObject({ rotationPreset: "orbit" });
		expect(() => documentSchema.parse(withZoom)).not.toThrow();

		const id = withZoom.zoomRanges[0].id;
		const turned = executeAgentTool(
			withZoom,
			"setZoom",
			JSON.stringify({ zoomId: id, rotationPreset: "left" }),
		).document as AxcutDocument;
		expect(turned.zoomRanges[0]).toMatchObject({ rotationPreset: "left", depth: 3 });

		const flat = executeAgentTool(
			turned,
			"setZoom",
			JSON.stringify({ zoomId: id, rotationPreset: "none" }),
		).document as AxcutDocument;
		expect(flat.zoomRanges[0]).not.toHaveProperty("rotationPreset");

		// Left out, it stays as it was; an unknown camera is refused.
		const deeper = executeAgentTool(turned, "setZoom", JSON.stringify({ zoomId: id, depth: 5 }));
		expect(deeper.document?.zoomRanges[0]).toMatchObject({ rotationPreset: "left", depth: 5 });
		expect(
			executeAgentTool(withZoom, "setZoom", JSON.stringify({ zoomId: id, rotationPreset: "up" }))
				.ok,
		).toBe(false);
	});

	it("addZoom without a camera stays flat", () => {
		const result = executeAgentTool(
			fixtureDocument(),
			"addZoom",
			JSON.stringify({ startSec: 2, endSec: 4 }),
		);
		expect(result.document?.zoomRanges[0]).not.toHaveProperty("rotationPreset");
		expect(JSON.parse(result.resultJson)).not.toHaveProperty("rotationPreset");
	});

	it("addSpeed writes a legacyEditor speed region the snapshot exposes", () => {
		const result = executeAgentTool(
			fixtureDocument(),
			"addSpeed",
			JSON.stringify({ startSec: 5, endSec: 9, speed: 2 }),
		);
		expect(result.ok).toBe(true);
		const legacy = result.document?.legacyEditor as Record<string, unknown>;
		const regions = legacy.speedRegions as Array<{ startMs: number; endMs: number; speed: number }>;
		expect(regions.at(-1)).toMatchObject({ startMs: 5000, endMs: 9000, speed: 2 });
		expect(() => documentSchema.parse(result.document)).not.toThrow();
	});

	it("refuses a speed outside the range every reader plays", () => {
		for (const speed of [100, 0.1]) {
			const result = executeAgentTool(
				fixtureDocument(),
				"addSpeed",
				JSON.stringify({ startSec: 5, endSec: 9, speed }),
			);
			expect(result.ok).toBe(false);
		}
	});

	it("addAnnotation adds a schema-valid text annotation", () => {
		const result = executeAgentTool(
			fixtureDocument(),
			"addAnnotation",
			JSON.stringify({ startSec: 1, endSec: 3, text: "Look here", x: 20, y: 80 }),
		);
		expect(result.ok).toBe(true);
		const ann = result.document?.annotations.at(-1);
		expect(ann).toMatchObject({
			startMs: 1000,
			endMs: 3000,
			type: "text",
			textContent: "Look here",
			// On the output frame, as the editor places text: padding and zooms never move it.
			space: "frame",
		});
		// x/y are the text's centre, and the box is fitted to the text around it.
		expect(centreOf(ann)).toEqual({ x: expect.closeTo(20, 5), y: expect.closeTo(80, 5) });
		expect(() => documentSchema.parse(result.document)).not.toThrow();
	});

	it("addAnnotation centres the text on a dark plate by default, and keeps it in frame", () => {
		const centred = executeAgentTool(
			fixtureDocument(),
			"addAnnotation",
			JSON.stringify({ startSec: 1, endSec: 3, text: "Hi" }),
		).document?.annotations.at(-1);
		expect(centred).toMatchObject({ style: { backgroundColor: "rgba(0, 0, 0, 0.7)" } });
		expect(centreOf(centred)).toEqual({ x: expect.closeTo(50, 5), y: expect.closeTo(50, 5) });
		const corner = executeAgentTool(
			fixtureDocument(),
			"addAnnotation",
			JSON.stringify({ startSec: 1, endSec: 3, text: "Hi", x: 100, y: 0 }),
		).document?.annotations.at(-1);
		expect(corner?.position.y).toBe(0);
		expect((corner?.position.x ?? 0) + (corner?.size.width ?? 0)).toBeCloseTo(100, 5);
	});

	it("addAnnotation takes the look the editor's inspector offers", () => {
		const add = (look: Record<string, unknown>) =>
			executeAgentTool(
				fixtureDocument(),
				"addAnnotation",
				JSON.stringify({ startSec: 1, endSec: 3, text: "Palettes in one click", ...look }),
			).document?.annotations.at(-1);
		const plain = add({});
		const title = add({
			fontSize: 72,
			color: "#ffcc00",
			background: "none",
			bold: false,
			animation: "typewriter",
		});
		expect(title?.style).toMatchObject({
			fontSize: 72,
			color: "#ffcc00",
			backgroundColor: "transparent",
			fontWeight: "normal",
			textAnimation: "typewriter",
		});
		// Bigger text, bigger box: the box is the text's.
		expect(title?.size.width).toBeGreaterThan(plain?.size.width ?? 0);
	});

	it("setAnnotation moves the text, restyles it and refits its box around its centre", () => {
		const added = executeAgentTool(
			fixtureDocument(),
			"addAnnotation",
			JSON.stringify({ startSec: 1, endSec: 3, text: "Hi", x: 30, y: 30 }),
		);
		const id = JSON.parse(added.resultJson).annotationId;
		const moved = executeAgentTool(
			added.document as AxcutDocument,
			"setAnnotation",
			JSON.stringify({ annotationId: id, x: 70, y: 85, animation: "pop" }),
		).document?.annotations.find((a) => a.id === id);
		expect(centreOf(moved)).toEqual({ x: expect.closeTo(70, 5), y: expect.closeTo(85, 5) });
		expect(moved?.style.textAnimation).toBe("pop");

		const retexted = executeAgentTool(
			added.document as AxcutDocument,
			"setAnnotation",
			JSON.stringify({ annotationId: id, text: "A much longer callout than before" }),
		).document?.annotations.find((a) => a.id === id);
		expect(retexted?.size.width).toBeGreaterThan(moved?.size.width ?? 0);
		expect(centreOf(retexted)).toEqual({ x: expect.closeTo(30, 5), y: expect.closeTo(30, 5) });
	});

	it("setAspectRatio sets the video's shape, keeping frame text where it was", () => {
		const added = executeAgentTool(
			fixtureDocument(),
			"addAnnotation",
			JSON.stringify({ startSec: 1, endSec: 3, text: "Centred", x: 50, y: 50 }),
		);
		const result = executeAgentTool(
			added.document as AxcutDocument,
			"setAspectRatio",
			JSON.stringify({ aspectRatio: "9:16" }),
		);
		expect(result.ok).toBe(true);
		expect(JSON.parse(result.resultJson)).toMatchObject({ aspectRatio: "9:16" });
		expect(
			(result.document?.legacyEditor as { aspectRatio?: string } | undefined)?.aspectRatio,
		).toBe("9:16");
		expect(centreOf(result.document?.annotations.at(-1))).toEqual({
			x: expect.closeTo(50, 5),
			y: expect.closeTo(50, 5),
		});
		expect(
			executeAgentTool(fixtureDocument(), "setAspectRatio", JSON.stringify({ aspectRatio: "7:3" }))
				.ok,
		).toBe(false);
	});

	it("fits a title to its words in the shipped font, in 16:9 and once switched to 9:16", () => {
		// The e2e pass's turn: a bold Inter title at 64 px, then the vertical format. Measured with
		// the estimate Node used to fall back on, the box held 554 px of text for 587 px of words,
		// and the 9:16 export showed "Demo" with "OpenScreen" wrapped out of the box.
		vi.stubEnv("OPENSCREEN_FONTS_DIR", path.resolve(__dirname, "../../public/fonts"));
		try {
			/** The room the box leaves its words, inside the plate, against their measured width. */
			const room = (ann: AxcutAnnotationRegion | undefined, aspect: number) => {
				if (!ann) throw new Error("no annotation");
				const box = (ann.size.width / 100) * 1080 * aspect - 0.4 * ann.style.fontSize;
				return box - measureTextInShippedFonts(ann.content ?? "", ann.style).width;
			};
			let document = executeAgentTool(
				fixtureDocument(),
				"setAspectRatio",
				JSON.stringify({ aspectRatio: "16:9" }),
			).document as AxcutDocument;
			const added = executeAgentTool(
				document,
				"addAnnotation",
				JSON.stringify({ startSec: 1, endSec: 4, text: "Demo OpenScreen", fontSize: 64, x: 50 }),
			);
			const id = JSON.parse(added.resultJson).annotationId;
			document = added.document as AxcutDocument;
			const wide = document.annotations.find((a) => a.id === id);
			expect(wide?.style.fontSize).toBe(64);
			expect(room(wide, 16 / 9)).toBeGreaterThan(0);

			document = executeAgentTool(
				document,
				"setAspectRatio",
				JSON.stringify({ aspectRatio: "9:16" }),
			).document as AxcutDocument;
			const tall = document.annotations.find((a) => a.id === id);
			expect(room(tall, 9 / 16)).toBeGreaterThan(0);
			expect(tall?.size.width).toBeLessThanOrEqual(100);
			// 64 px of Inter bold does not fit a portrait frame's width: brought down just enough.
			expect(tall?.style.fontSize).toBeLessThan(64);
			expect(tall?.style.fontSize).toBeGreaterThan(55);
			expect(centreOf(tall)).toEqual({ x: expect.closeTo(50, 5), y: expect.closeTo(50, 5) });

			// Added straight into the portrait frame, the same title fits too.
			const direct = executeAgentTool(
				document,
				"addAnnotation",
				JSON.stringify({ startSec: 5, endSec: 6, text: "Demo OpenScreen", fontSize: 64 }),
			).document?.annotations.at(-1);
			expect(room(direct, 9 / 16)).toBeGreaterThan(0);
			expect(direct?.size.width).toBeLessThanOrEqual(100);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("refuses a set that would run into another region, instead of landing it elsewhere", () => {
		let document = fixtureDocument();
		const add = (name: string, args: Record<string, unknown>) => {
			const result = executeAgentTool(document, name, JSON.stringify(args));
			document = result.document as AxcutDocument;
			return result;
		};
		const first = add("addAnnotation", { startSec: 1, endSec: 2, text: "One" });
		add("addAnnotation", { startSec: 6, endSec: 8, text: "Two" });
		const firstId = JSON.parse(first.resultJson).annotationId;
		const blocked = executeAgentTool(
			document,
			"setAnnotation",
			JSON.stringify({ annotationId: firstId, startSec: 7, endSec: 9 }),
		);
		expect(blocked.ok).toBe(false);
		expect(blocked.document).toBeUndefined();
		expect(blocked.resultJson).toMatch(/NOT changed.*6\.0|NOT changed/);

		// The same rule for every kind of effect.
		const zoom = add("addZoom", { startSec: 1, endSec: 2, depth: 2 });
		add("addZoom", { startSec: 6, endSec: 8, depth: 4 });
		const zoomId = JSON.parse(zoom.resultJson).zoomId;
		const zoomBlocked = executeAgentTool(
			document,
			"setZoom",
			JSON.stringify({ zoomId, startSec: 7, endSec: 9 }),
		);
		expect(zoomBlocked.ok).toBe(false);
		// A span clear of it still moves.
		expect(
			executeAgentTool(document, "setZoom", JSON.stringify({ zoomId, startSec: 3, endSec: 4 })).ok,
		).toBe(true);

		// A look-alike is in the way too: the drag would stop against it (#1133), so a set is
		// refused rather than landed short of where it was asked.
		add("addZoom", { startSec: 12, endSec: 14, depth: 2 });
		expect(
			executeAgentTool(document, "setZoom", JSON.stringify({ zoomId, startSec: 13, endSec: 15 }))
				.ok,
		).toBe(false);
		add("addSpeed", { startSec: 20, endSec: 22, speed: 2 });
		add("addSpeed", { startSec: 24, endSec: 26, speed: 2 });
		const speedId = (
			(document.legacyEditor as Record<string, unknown>).speedRegions as Array<{
				id: string;
				startMs: number;
			}>
		).find((r) => r.startMs === 20_000)?.id;
		const speedBlocked = executeAgentTool(
			document,
			"setSpeed",
			JSON.stringify({ speedId, startSec: 23, endSec: 25 }),
		);
		expect(speedBlocked.ok).toBe(false);
		expect(speedBlocked.resultJson).toMatch(/cannot overlap/);
	});

	it("snapshot exposes clips/trims/effects as virtual-time groups with a time-base note", () => {
		const withEffects = executeAgentTool(
			fixtureDocument(),
			"addZoom",
			JSON.stringify({ startSec: 3, endSec: 6, depth: 2 }),
		).document as AxcutDocument;
		const snapshot = JSON.parse(executeAgentTool(withEffects, "getCurrentDocument", "").resultJson);
		expect(snapshot.timeBaseNote).toMatch(/virtual/);
		expect(snapshot.zoomRanges[0]).toMatchObject({ startSec: 3, endSec: 6, depth: 2 });
		expect(snapshot.trimRanges[0].id).toBe("trim_1");
		// counts-only fields are gone in favour of the labelled effect lists.
		expect(snapshot.zoomRangeCount).toBeUndefined();
		expect(snapshot.annotationCount).toBeUndefined();
	});

	it("addCameraFullscreen / setCameraFullscreen write a region the snapshot exposes", () => {
		const added = executeAgentTool(
			withCameraTrack(fixtureDocument()),
			"addCameraFullscreen",
			JSON.stringify({ startSec: 9, endSec: 5 }),
		);
		expect(added.ok).toBe(true);
		const legacy = added.document?.legacyEditor as Record<string, unknown>;
		const region = (
			legacy.cameraFullscreenRegions as Array<{ id: string; startMs: number; endMs: number }>
		).at(-1);
		// bounds normalised (start ≤ end).
		expect(region).toMatchObject({ startMs: 5000, endMs: 9000 });
		expect(() => documentSchema.parse(added.document)).not.toThrow();

		const snapshot = JSON.parse(
			executeAgentTool(added.document as AxcutDocument, "getCurrentDocument", "").resultJson,
		);
		expect(snapshot.cameraFullscreenRegions[0]).toMatchObject({ startSec: 5, endSec: 9 });
		expect(snapshot.timeBaseNote).toMatch(/cameraFullscreen/i);

		const moved = executeAgentTool(
			added.document as AxcutDocument,
			"setCameraFullscreen",
			JSON.stringify({ cameraFullscreenId: region?.id, startSec: 1, endSec: 2 }),
		);
		expect(moved.ok).toBe(true);
		const movedRegion = (
			(moved.document?.legacyEditor as Record<string, unknown>).cameraFullscreenRegions as Array<{
				startMs: number;
				endMs: number;
			}>
		)[0];
		expect(movedRegion).toMatchObject({ startMs: 1000, endMs: 2000 });
		expect(
			executeAgentTool(
				withCameraTrack(fixtureDocument()),
				"setCameraFullscreen",
				JSON.stringify({ cameraFullscreenId: "nope" }),
			).ok,
		).toBe(false);
	});

	it("removeTrim deletes a trim by id (and rejects an unknown one)", () => {
		const result = executeAgentTool(
			fixtureDocument(),
			"removeTrim",
			JSON.stringify({ trimRangeId: "trim_1" }),
		);
		expect(result.ok).toBe(true);
		expect(result.document?.timeline.trimRanges).toHaveLength(0);
		expect(() => documentSchema.parse(result.document)).not.toThrow();
		expect(
			executeAgentTool(fixtureDocument(), "removeTrim", JSON.stringify({ trimRangeId: "nope" })).ok,
		).toBe(false);
	});

	it("removeModifier resolves the kind from the id across zoom / speed / annotation / full-camera", () => {
		const withZoom = executeAgentTool(
			fixtureDocument(),
			"addZoom",
			JSON.stringify({ startSec: 2, endSec: 4 }),
		).document as AxcutDocument;
		const zoomId = withZoom.zoomRanges[0].id;
		const removed = executeAgentTool(withZoom, "removeModifier", JSON.stringify({ id: zoomId }));
		expect(removed.ok).toBe(true);
		expect(JSON.parse(removed.resultJson)).toMatchObject({
			kind: "zoom",
			removed: zoomId,
			removedIds: [zoomId],
		});
		expect(removed.document?.zoomRanges).toHaveLength(0);

		const withSpeed = executeAgentTool(
			fixtureDocument(),
			"addSpeed",
			JSON.stringify({ startSec: 2, endSec: 4, speed: 2 }),
		).document as AxcutDocument;
		const speedId = (
			(withSpeed.legacyEditor as Record<string, unknown>).speedRegions as Array<{ id: string }>
		)[0].id;
		const removedSpeed = executeAgentTool(
			withSpeed,
			"removeModifier",
			JSON.stringify({ id: speedId }),
		);
		expect(JSON.parse(removedSpeed.resultJson)).toMatchObject({
			kind: "speed",
			removed: speedId,
			removedIds: [speedId],
		});
		expect(
			(removedSpeed.document?.legacyEditor as Record<string, unknown>).speedRegions,
		).toHaveLength(0);

		// A trim id is NOT a modifier — the error steers to removeTrim.
		const wrong = executeAgentTool(
			fixtureDocument(),
			"removeModifier",
			JSON.stringify({ id: "trim_1" }),
		);
		expect(wrong.ok).toBe(false);
		expect(wrong.resultJson).toMatch(/removeTrim/);
	});

	it("removeModifier reports every touching modifier row removed with the pill", () => {
		const added = executeAgentTool(
			fixtureDocument(),
			"addZooms",
			JSON.stringify({
				regions: [
					{ startSec: 0, endSec: 10, depth: 3 },
					{ startSec: 10, endSec: 20, depth: 3 },
					{ startSec: 20, endSec: 30, depth: 3 },
				],
			}),
		);
		expect(added.ok).toBe(true);
		const ids = (JSON.parse(added.resultJson).applied as Array<{ zoomId: string }>).map(
			(entry) => entry.zoomId,
		);
		expect(ids).toHaveLength(3);

		const removed = executeAgentTool(
			added.document as AxcutDocument,
			"removeModifier",
			JSON.stringify({ id: ids[0] }),
		);

		expect(removed.ok).toBe(true);
		expect(removed.document?.zoomRanges).toHaveLength(0);
		expect(JSON.parse(removed.resultJson)).toMatchObject({
			removed: ids[0],
			removedIds: ids,
			kind: "zoom",
		});
	});

	it("addZoom reports the CLAMPED span, not the one it was asked for", () => {
		// ponytail: the exact shape of D-HONEST. Ventilation trims the span to the
		// clip; the tool used to echo back 20–40 while the document held 20–24.704
		// and answer ok:true, so the model reported a zoom that does not exist as
		// asked. The oracle `diffMatches` was written for precisely this.
		const doc = shortSingleClip();
		const result = executeAgentTool(doc, "addZoom", JSON.stringify({ startSec: 20, endSec: 40 }));
		expect(result.ok).toBe(true);
		const payload = JSON.parse(result.resultJson);
		expect(payload.startSec).toBe(20);
		expect(payload.endSec).toBeCloseTo(24.704, 3);
		expect(payload.clamped).toBe(true);
		expect(payload.requestedEndSec).toBe(40);
		// And the document agrees with the report, which is the whole point.
		const stored = result.document?.zoomRanges.at(-1);
		expect(stored?.endMs).toBe(24_704);
		expect(payload.ids).toEqual([stored?.id]);
		expect(result.summary).toMatch(/clamped from/);
	});

	it("addZoom refuses a span that covers no clip instead of storing a dead region", () => {
		const result = executeAgentTool(
			shortSingleClip(),
			"addZoom",
			JSON.stringify({ startSec: 90, endSec: 95 }),
		);
		expect(result.ok).toBe(false);
		expect(result.document).toBeUndefined();
		const payload = JSON.parse(result.resultJson) as { error: string };
		// The refusal has to be actionable: without the real extent the model can
		// only retry blindly, and there is no timeout anywhere on this path.
		expect(payload.error).toMatch(/covers no clip/);
		expect(payload.error).toMatch(/0\.0–24\.7 s/);
	});

	it("addZoom reports BOTH ids when the span straddles two clips", () => {
		// `anchorRawRegionsToClips` keeps the region's id for the first fragment
		// and mints a fresh one for each extra clip. The result used to name one
		// id and one span for a write that produced two regions.
		const result = executeAgentTool(
			fixtureDocument(),
			"addZoom",
			JSON.stringify({ startSec: 25, endSec: 35 }),
		);
		expect(result.ok).toBe(true);
		const payload = JSON.parse(result.resultJson);
		expect(payload.ids).toHaveLength(2);
		expect(payload.fragments).toBe(2);
		const stored = new Set((result.document?.zoomRanges ?? []).map((z) => z.id));
		for (const id of payload.ids as string[]) expect(stored.has(id)).toBe(true);
		expect(result.summary).toMatch(/split across 2 clips/);
	});

	it("setClipRange names the modifiers its trim destroyed", () => {
		// Before: "trimmed clip to 0:00.0 – 0:03.0" while a zoom ceased to exist,
		// with nothing in the result to contradict "the zoom is preserved".
		const doc = fixtureDocument();
		const withZoom = executeAgentTool(doc, "addZoom", JSON.stringify({ startSec: 5, endSec: 8 }))
			.document as AxcutDocument;
		const zoomId = withZoom.zoomRanges[0].id;

		const result = executeAgentTool(
			withZoom,
			"setClipRange",
			JSON.stringify({ clipId: "clip_1", sourceStartSec: 0, sourceEndSec: 3 }),
		);
		expect(result.ok).toBe(true);
		const payload = JSON.parse(result.resultJson);
		expect(payload.droppedModifierIds).toEqual([zoomId]);
		expect(result.document?.zoomRanges.map((z) => z.id)).not.toContain(zoomId);
		expect(result.summary).toContain(zoomId);
	});

	it("setClipRange says nothing about casualties when there are none", () => {
		const result = executeAgentTool(
			fixtureDocument(),
			"setClipRange",
			JSON.stringify({ clipId: "clip_1", sourceStartSec: 0, sourceEndSec: 20 }),
		);
		const payload = JSON.parse(result.resultJson);
		expect(payload.droppedModifierIds).toEqual([]);
		expect(payload.droppedTrimIds).toEqual([]);
		expect(result.summary).not.toContain("dropped");
	});

	it("removeClip names the modifiers that went with the clip", () => {
		const doc = fixtureDocument();
		const withZoom = executeAgentTool(doc, "addZoom", JSON.stringify({ startSec: 5, endSec: 8 }))
			.document as AxcutDocument;
		const zoomId = withZoom.zoomRanges[0].id;

		const result = executeAgentTool(withZoom, "removeClip", JSON.stringify({ clipId: "clip_1" }));
		expect(result.ok).toBe(true);
		expect(JSON.parse(result.resultJson).droppedModifierIds).toEqual([zoomId]);
		expect(result.summary).toContain(zoomId);
	});

	it("removeClip deletes a clip and reflows the survivor (rejects an unknown id)", () => {
		const result = executeAgentTool(
			fixtureDocument(),
			"removeClip",
			JSON.stringify({ clipId: "clip_1" }),
		);
		expect(result.ok).toBe(true);
		expect(result.document?.timeline.clips.map((c) => c.id)).toEqual(["clip_2"]);
		// clip_2 slides to the front of the timeline.
		expect(result.document?.timeline.clips[0]).toMatchObject({
			timelineStartSec: 0,
			timelineEndSec: 30,
		});
		expect(() => documentSchema.parse(result.document)).not.toThrow();
		expect(
			executeAgentTool(fixtureDocument(), "removeClip", JSON.stringify({ clipId: "nope" })).ok,
		).toBe(false);
	});
});

// ─── What the snapshot says the project IS ─────────────────────────────────
//
// A projection's omissions are claims. Two of them were being read as facts:
// an absent `cameraTrack` made a project with a webcam and one without
// indistinguishable, and a bare `depth` made an ordinal look like a factor.
describe("documentSnapshotForModel", () => {
	interface Snapshot {
		autoFocusAll: boolean;
		hasAnyCamera: boolean;
		zoomNote: string;
		assets: Array<{ hasCameraTrack: boolean; cameraVisible: boolean }>;
		zoomRanges: Array<{
			depth: number;
			renderedScale: number;
			customScale?: number;
			depthIsOverridden?: boolean;
			focusMode: string;
			source: string;
		}>;
	}

	function snapshotOf(document: AxcutDocument): Snapshot {
		return JSON.parse(executeAgentTool(document, "getCurrentDocument", "").resultJson) as Snapshot;
	}

	it("reports a zoom's rendered scale, not just its ordinal depth", () => {
		const snapshot = snapshotOf(
			documentSchema.parse({
				...fixtureDocument(),
				zoomRanges: [
					{
						id: "zoom_1",
						startMs: 2_000,
						endMs: 6_000,
						clipId: "clip_1",
						sourceStartSec: 2,
						sourceEndSec: 6,
						depth: 3,
						focus: { cx: 0.5, cy: 0.5 },
					},
				],
			}),
		);
		// Both assertions on purpose: the literal is what the pill on screen reads,
		// and the table cross-check makes this fail if someone edits the mapping
		// without meaning to. The prompt used to promise ~2.0× for this zoom.
		expect(snapshot.zoomRanges[0].renderedScale).toBe(1.8);
		expect(snapshot.zoomRanges[0].renderedScale).toBe(ZOOM_DEPTH_SCALES[3]);
		expect(snapshot.zoomRanges[0].depth).toBe(3);
		expect(snapshot.zoomRanges[0].depthIsOverridden).toBeUndefined();
		expect(snapshot.zoomRanges[0].focusMode).toBe("manual");
		expect(snapshot.zoomRanges[0].source).toBe("manual");
		expect(snapshot.zoomNote).toMatch(/3=1\.80×/);
	});

	it("flags a customScale that makes the depth inert", () => {
		const snapshot = snapshotOf(zoomWithCustomScale(fixtureDocument(), 1.1));
		expect(snapshot.zoomRanges[0].renderedScale).toBe(1.1);
		expect(snapshot.zoomRanges[0].customScale).toBe(1.1);
		expect(snapshot.zoomRanges[0].depthIsOverridden).toBe(true);
		// depth 6 would render 5.0×; the model must not read it as the strength.
		expect(snapshot.zoomRanges[0].depth).toBe(3);
	});

	it("clamps a customScale the schema accepts but the renderer will not", () => {
		// `zoomRegionSchema` only asks for a positive number, so 12 is a legal
		// document. The preview clamps to 5.0; reporting 12 would be a third scale.
		const snapshot = snapshotOf(zoomWithCustomScale(fixtureDocument(), 12));
		expect(snapshot.zoomRanges[0].renderedScale).toBe(5);
	});

	it("reports the EFFECTIVE focus mode when the global Auto-Focus is on", () => {
		// `autoFocusAll` overrides every region's own mode at render
		// (sceneDescription.ts) and greys out the per-region control. Echoing the
		// stored "manual" would tell the model its focus point is being honoured
		// while the camera follows the cursor.
		const base = zoomWithCustomScale(fixtureDocument(), 1.1);
		const snapshot = snapshotOf(
			documentSchema.parse({ ...base, legacyEditor: { autoFocusAll: true } }),
		);
		expect(snapshot.autoFocusAll).toBe(true);
		expect(snapshot.zoomRanges[0].focusMode).toBe("auto");
		expect(snapshotOf(base).autoFocusAll).toBe(false);
		expect(snapshotOf(base).zoomRanges[0].focusMode).toBe("manual");
	});

	it("says whether each asset carries a webcam, and whether any clip does", () => {
		const bare = snapshotOf(fixtureDocument());
		expect(bare.assets[0].hasCameraTrack).toBe(false);
		expect(bare.assets[0].cameraVisible).toBe(false);
		expect(bare.hasAnyCamera).toBe(false);

		const withCam = snapshotOf(withCameraTrack(fixtureDocument()));
		expect(withCam.assets[0].hasCameraTrack).toBe(true);
		expect(withCam.assets[0].cameraVisible).toBe(true);
		expect(withCam.hasAnyCamera).toBe(true);
	});

	it("hasAnyCamera follows the placed clips, not merely the assets present", () => {
		// An imported-but-unused asset with a webcam does not put a webcam on the
		// timeline, and answering "yes" there is the same false confidence in the
		// other direction.
		const document = withCameraTrack(fixtureDocument());
		const unplaced = documentSchema.parse({
			...document,
			timeline: { ...document.timeline, clips: [], trimRanges: [] },
		});
		expect(snapshotOf(unplaced).assets[0].hasCameraTrack).toBe(true);
		expect(snapshotOf(unplaced).hasAnyCamera).toBe(false);
	});
});

describe("zoom strength is written, not just stored", () => {
	it("addZoom reports the scale the viewer will see", () => {
		const result = executeAgentTool(
			fixtureDocument(),
			"addZoom",
			JSON.stringify({ startSec: 2, endSec: 6, depth: 3 }),
		);
		expect(result.ok).toBe(true);
		expect(JSON.parse(result.resultJson).renderedScale).toBe(1.8);
		expect(result.summary).toContain("1.80×");
	});

	it("setZoom{depth} on a customScale zoom clears the override instead of no-op'ing", () => {
		// The defect this closes: the write was accepted, the depth was stored, the
		// result echoed it, and the frame stayed at 1.10× — a change every layer
		// believed had happened.
		const result = executeAgentTool(
			zoomWithCustomScale(fixtureDocument(), 1.1),
			"setZoom",
			JSON.stringify({ zoomId: "zoom_1", depth: 6 }),
		);
		expect(result.ok).toBe(true);
		const after = result.document as AxcutDocument;
		expect(after.zoomRanges[0].customScale).toBeUndefined();
		expect(after.zoomRanges[0].depth).toBe(6);
		const payload = JSON.parse(result.resultJson);
		expect(payload.renderedScale).toBe(ZOOM_DEPTH_SCALES[6]);
		expect(payload.clearedCustomScale).toBe(true);
		expect(result.summary).toMatch(/custom scale/i);
	});

	it("leaves customScale alone when the write does not touch the depth", () => {
		// Dropping a fine-tuned value is destructive; it is only justified by an
		// explicit request to change the strength.
		const result = executeAgentTool(
			zoomWithCustomScale(fixtureDocument(), 1.1),
			"setZoom",
			JSON.stringify({ zoomId: "zoom_1", startSec: 3, endSec: 7 }),
		);
		expect(result.ok).toBe(true);
		const after = result.document as AxcutDocument;
		expect(after.zoomRanges[0].customScale).toBe(1.1);
		expect(JSON.parse(result.resultJson).clearedCustomScale).toBeUndefined();
		expect(JSON.parse(result.resultJson).renderedScale).toBe(1.1);
	});
});

describe("a full-camera region needs a camera", () => {
	it("is refused on footage with no linked webcam", () => {
		const result = executeAgentTool(
			fixtureDocument(),
			"addCameraFullscreen",
			JSON.stringify({ startSec: 0, endSec: 5 }),
		);
		expect(result.ok).toBe(false);
		expect(result.document).toBeUndefined();
		const error = JSON.parse(result.resultJson).error as string;
		expect(error).toMatch(/no webcam/i);
		// Actionable, and specific about WHICH kind of nothing: no camera anywhere
		// is a fact about the recording the model should relay, not retry.
		expect(error).toMatch(/hasCameraTrack/);
		expect(error).toMatch(/no asset in this project/i);
	});

	it("is allowed on footage that carries one", () => {
		const result = executeAgentTool(
			withCameraTrack(fixtureDocument()),
			"addCameraFullscreen",
			JSON.stringify({ startSec: 0, endSec: 5 }),
		);
		expect(result.ok).toBe(true);
		const legacy = result.document?.legacyEditor as Record<string, unknown>;
		expect(legacy.cameraFullscreenRegions).toHaveLength(1);
	});

	it("refuses to MOVE a region onto footage with no webcam", () => {
		// clip_2 comes from a second asset with no camera. Placing is guarded and
		// moving was not, which would have re-opened the hole one tool over.
		const document = withCameraTrack(fixtureDocument());
		const mixed = documentSchema.parse({
			...document,
			assets: [
				document.assets[0],
				{
					id: "asset_2",
					kind: "video",
					label: "Screen only",
					originalPath: "C:/videos/screen.mp4",
					durationSec: 60,
				},
			],
			timeline: {
				...document.timeline,
				clips: document.timeline.clips.map((c) =>
					c.id === "clip_2" ? { ...c, assetId: "asset_2" } : c,
				),
			},
		});
		const added = executeAgentTool(
			mixed,
			"addCameraFullscreen",
			JSON.stringify({ startSec: 0, endSec: 5 }),
		);
		expect(added.ok).toBe(true);
		const regionId = (
			(added.document?.legacyEditor as Record<string, unknown>).cameraFullscreenRegions as Array<{
				id: string;
			}>
		)[0].id;
		const moved = executeAgentTool(
			added.document as AxcutDocument,
			"setCameraFullscreen",
			JSON.stringify({ cameraFullscreenId: regionId, startSec: 40, endSec: 45 }),
		);
		expect(moved.ok).toBe(false);
		// Other clips DO carry a camera here, so the advice differs from the
		// no-camera-anywhere case above.
		expect(JSON.parse(moved.resultJson).error).toMatch(/other clips/i);
	});
});

// ── D-DESTRUCT ──────────────────────────────────────────────────────────────
//
// "Swap the two clips: put the demo first." There was no tool for it — while
// the system prompt promised one — so the model reached for `replaceTimeline`
// with [30-60], [0-30]. That call sorted the intervals (so the swap never
// happened), merged them (so two clips became one), re-minted the ids, deleted
// the user's 12–17 s cut, re-anchored the effects onto whatever had slid under
// them, and returned `ok: true`. The model then reported that the trim was
// preserved. Every layer of that is fixed separately below.
describe("replaceTimeline refuses what it would destroy", () => {
	/** The workbench's `twoClipsWithTrim`: clips placed by the AGENT, which is
	 *  exactly what the old `origin === "user"` guard could not see. */
	function twoAgentClipsWithTrim(): AxcutDocument {
		const base = createEmptyDocument({
			title: "Two clips",
			projectId: "proj_two",
			createdAt: FIXTURE_CREATED_AT,
		});
		return documentSchema.parse({
			...base,
			project: { ...base.project, primaryAssetId: "asset_1" },
			assets: [
				{
					id: "asset_1",
					kind: "video",
					label: "Recording",
					originalPath: "C:/videos/rec.mp4",
					durationSec: 60,
				},
			],
			timeline: {
				...base.timeline,
				clips: [
					{
						id: "clip_1",
						assetId: "asset_1",
						sourceStartSec: 0,
						sourceEndSec: 30,
						timelineStartSec: 0,
						timelineEndSec: 30,
						wordRefs: [],
						origin: "agent",
						reason: "intro",
					},
					{
						id: "clip_2",
						assetId: "asset_1",
						sourceStartSec: 30,
						sourceEndSec: 60,
						timelineStartSec: 30,
						timelineEndSec: 60,
						wordRefs: [],
						origin: "agent",
						reason: "demo",
					},
				],
				trimRanges: [
					{
						id: "trim_1",
						assetId: "asset_1",
						startSec: 12,
						endSec: 17,
						reason: "silence",
						origin: "agent",
					},
				],
			},
		});
	}

	const swapArgs = JSON.stringify({
		intervals: [
			{ startSec: 30, endSec: 60 },
			{ startSec: 0, endSec: 30 },
		],
		reason: "swap",
	});

	it("refuses the swap the workbench measured, and says which tool does it", () => {
		const result = executeAgentTool(twoAgentClipsWithTrim(), "replaceTimeline", swapArgs);
		expect(result.ok).toBe(false);
		expect(result.document).toBeUndefined();
		const payload = JSON.parse(result.resultJson) as {
			error: string;
			code: string;
			reorderRequested: boolean;
			lostClipIds: string[];
		};
		expect(payload.code).toBe("would_destroy");
		expect(payload.reorderRequested).toBe(true);
		expect(payload.error).toMatch(/moveClip/);
		// It is refused for the RIGHT reason: nothing would be lost any more (the
		// pure layer preserves both clips and the cut now), but the swap the user
		// asked for still cannot happen, so answering `ok` would be a lie of a
		// different kind — the tool would report success on a no-op.
		expect(payload.lostClipIds).toEqual([]);
		expect(payload.error).toMatch(/ascending order/);
	});

	it("the guard no longer depends on origin, so it cannot disarm itself", () => {
		// `buildTimelineFromIntervals` stamps its own origin on everything it
		// produces, so ONE legitimate agent rebuild used to turn every clip into
		// `origin: "agent"` and switch the old guard off for the rest of the
		// project's life. Here both clips are already `agent` and it still refuses.
		const first = executeAgentTool(twoAgentClipsWithTrim(), "replaceTimeline", swapArgs);
		expect(first.ok).toBe(false);
		const second = executeAgentTool(twoAgentClipsWithTrim(), "replaceTimeline", swapArgs);
		expect(second.ok).toBe(false);
	});

	it("does not refuse a rebuild with nothing to lose", () => {
		const empty = documentSchema.parse({
			...twoAgentClipsWithTrim(),
			timeline: { ...twoAgentClipsWithTrim().timeline, clips: [], trimRanges: [] },
		});
		const result = executeAgentTool(
			empty,
			"replaceTimeline",
			JSON.stringify({
				intervals: [
					{ startSec: 0, endSec: 10 },
					{ startSec: 20, endSec: 30 },
				],
				reason: "rebuild",
			}),
		);
		expect(result.ok).toBe(true);
		expect(result.document?.timeline.clips).toHaveLength(2);
	});

	it("names what survived instead of reporting two bare counts", () => {
		const result = executeAgentTool(
			twoAgentClipsWithTrim(),
			"replaceTimeline",
			JSON.stringify({
				intervals: [
					{ startSec: 0, endSec: 30 },
					{ startSec: 30, endSec: 60 },
				],
				reason: "identity",
			}),
		);
		expect(result.ok).toBe(true);
		const payload = JSON.parse(result.resultJson) as { preservedClipIds: string[] };
		expect(payload.preservedClipIds).toEqual(["clip_1", "clip_2"]);
		expect(result.document?.timeline.trimRanges.map((t) => t.id)).toEqual(["trim_1"]);
	});
});

describe("moveClip — the tool the prompt used to promise", () => {
	function twoClips(): AxcutDocument {
		const base = createEmptyDocument({
			title: "Two clips",
			projectId: "proj_move",
			createdAt: FIXTURE_CREATED_AT,
		});
		return documentSchema.parse({
			...base,
			project: { ...base.project, primaryAssetId: "asset_1" },
			assets: [
				{
					id: "asset_1",
					kind: "video",
					label: "Recording",
					originalPath: "C:/videos/rec.mp4",
					durationSec: 60,
				},
			],
			timeline: {
				...base.timeline,
				clips: [
					{
						id: "clip_1",
						assetId: "asset_1",
						sourceStartSec: 0,
						sourceEndSec: 30,
						timelineStartSec: 0,
						timelineEndSec: 30,
						wordRefs: [],
						origin: "user",
						reason: "intro",
					},
					{
						id: "clip_2",
						assetId: "asset_1",
						sourceStartSec: 30,
						sourceEndSec: 60,
						timelineStartSec: 30,
						timelineEndSec: 60,
						wordRefs: [],
						origin: "user",
						reason: "demo",
					},
				],
				trimRanges: [
					{
						id: "trim_1",
						assetId: "asset_1",
						startSec: 12,
						endSec: 17,
						reason: "silence",
						origin: "user",
					},
				],
			},
			zoomRanges: [
				{
					id: "zoom_demo",
					startMs: 40_000,
					endMs: 45_000,
					depth: 3,
					focus: { cx: 0.5, cy: 0.5 },
					clipId: "clip_2",
					sourceStartSec: 40,
					sourceEndSec: 45,
				},
			],
		});
	}

	it("performs the swap, keeping ids, trims and the anchored zoom", () => {
		const result = executeAgentTool(
			twoClips(),
			"moveClip",
			JSON.stringify({ clipId: "clip_2", beforeClipId: "clip_1" }),
		);
		expect(result.ok).toBe(true);
		const after = result.document as AxcutDocument;
		expect(after.timeline.clips.map((c) => c.id)).toEqual(["clip_2", "clip_1"]);
		// Order changed; content did not.
		expect(after.timeline.clips[0]).toMatchObject({ sourceStartSec: 30, sourceEndSec: 60 });
		expect(after.timeline.trimRanges.map((t) => t.id)).toEqual(["trim_1"]);
		expect(after.zoomRanges[0]).toMatchObject({
			id: "zoom_demo",
			clipId: "clip_2",
			sourceStartSec: 40,
			sourceEndSec: 45,
		});
		// clip_2 now starts the timeline, so the zoom's derived ms follow it.
		expect(after.zoomRanges[0]).toMatchObject({ startMs: 10_000, endMs: 15_000 });
	});

	it("keeps the clip's provenance and its label", () => {
		// `moveClip` stamps whatever origin it is handed. Passing "agent" would
		// relabel a user's clip as the agent's — and, before the guard stopped
		// reading `origin`, would have been a way to disarm it.
		const result = executeAgentTool(
			twoClips(),
			"moveClip",
			JSON.stringify({ clipId: "clip_2", beforeClipId: "clip_1" }),
		);
		expect(result.document?.timeline.clips[0]).toMatchObject({
			origin: "user",
			reason: "demo",
		});
	});

	it("moves a clip last when beforeClipId is null, and when it is omitted", () => {
		for (const args of [
			JSON.stringify({ clipId: "clip_1", beforeClipId: null }),
			JSON.stringify({ clipId: "clip_1" }),
		]) {
			const result = executeAgentTool(twoClips(), "moveClip", args);
			expect(result.ok).toBe(true);
			expect(result.document?.timeline.clips.map((c) => c.id)).toEqual(["clip_2", "clip_1"]);
		}
	});

	it("refuses an unknown id with the roster instead of throwing", () => {
		// `moveClip` in the document layer THROWS on an unknown clip, and the tool
		// loop has no try/catch of its own — an escape would kill the turn.
		const missing = executeAgentTool(
			twoClips(),
			"moveClip",
			JSON.stringify({ clipId: "clip_nope", beforeClipId: "clip_1" }),
		);
		expect(missing.ok).toBe(false);
		expect(JSON.parse(missing.resultJson).error).toMatch(/clip_1 \(intro\)/);

		const badTarget = executeAgentTool(
			twoClips(),
			"moveClip",
			JSON.stringify({ clipId: "clip_1", beforeClipId: "clip_nope" }),
		);
		expect(badTarget.ok).toBe(false);
		expect(badTarget.document).toBeUndefined();

		const itself = executeAgentTool(
			twoClips(),
			"moveClip",
			JSON.stringify({ clipId: "clip_1", beforeClipId: "clip_1" }),
		);
		expect(itself.ok).toBe(false);
	});

	it("gives the model the label and index it needs to aim", () => {
		// Without `reason` in the snapshot, "put the demo first" is unanswerable:
		// both clips are 30 s of the same asset and differ only by a label the
		// projection was not sending.
		const snapshot = JSON.parse(
			executeAgentTool(twoClips(), "getCurrentDocument", "").resultJson,
		) as { clips: Array<{ id: string; index: number; reason: string; origin: string }> };
		expect(snapshot.clips[1]).toMatchObject({ id: "clip_2", index: 1, reason: "demo" });
		expect(snapshot.clips[0].origin).toBe("user");
	});
});

// ── D-CONSENT ───────────────────────────────────────────────────────────────
//
// Settings offers "Agent edits — when off, the agent must ask before changing
// the timeline". `chat-service.ts` computed `editsAllowed` and then did
// `void editsAllowed;`. The flag reached nothing: not the tools, not the prompt.
describe("allowAgentEdits=false refuses every write", () => {
	it("refuses a write with a payload that tells the model what to do instead", () => {
		const result = executeAgentTool(
			fixtureDocument(),
			"addTrim",
			JSON.stringify({ startSec: 5, endSec: 8, reason: "silence" }),
			{ editsAllowed: false },
		);
		expect(result.ok).toBe(false);
		expect(result.document).toBeUndefined();
		expect(result.summary).toBeUndefined();
		const payload = JSON.parse(result.resultJson) as {
			code: string;
			tool: string;
			requestedArgs: { startSec: number };
			howToProceed: string;
		};
		expect(payload.code).toBe("consent_required");
		expect(payload.tool).toBe("addTrim");
		// The args come back so the model can quote the edit it is asking for.
		expect(payload.requestedArgs.startSec).toBe(5);
		// And it is told not to loop: there is no timeout on the product path.
		expect(payload.howToProceed).toMatch(/do NOT retry/i);
		expect(payload.howToProceed).toMatch(/ask the user/i);
	});

	it("refuses ALL of them — no write escapes by being added later", () => {
		const document = fixtureDocument();
		for (const name of MUTATING_TOOL_NAMES) {
			const result = executeAgentTool(document, name, "{}", { editsAllowed: false });
			expect(result.ok, `${name} was allowed through`).toBe(false);
			expect(result.document, `${name} mutated`).toBeUndefined();
			expect(JSON.parse(result.resultJson).code, `${name} failed for another reason`).toBe(
				"consent_required",
			);
		}
	});

	it("leaves the read tools alone — the model must be able to describe the edit", () => {
		for (const name of ["getCurrentDocument", "getTranscript"]) {
			const result = executeAgentTool(fixtureDocument(), name, "{}", { editsAllowed: false });
			expect(result.ok, name).toBe(true);
		}
	});

	it("changes nothing when the flag is absent or true", () => {
		const args = JSON.stringify({ startSec: 5, endSec: 8, reason: "silence" });
		expect(executeAgentTool(fixtureDocument(), "addTrim", args).ok).toBe(true);
		expect(executeAgentTool(fixtureDocument(), "addTrim", args, {}).ok).toBe(true);
		expect(executeAgentTool(fixtureDocument(), "addTrim", args, { editsAllowed: true }).ok).toBe(
			true,
		);
	});
});

// ─── D-TELEM: recorded cursor telemetry reaches the model ────────────────────
//
// The app records where the pointer went and the compositor loads the sidecar,
// but nothing carried a sample to the agent: `grep -rniE "cursor|telemetry"
// electron/ai-edition/` returned nothing at all. Asked what pointer data the
// project held, the model answered from an empty sandbox and reported, in good
// faith, that there was none. These tests hold the two halves of the fix: the
// snapshot says whether there IS data, and the tool returns the digest — with
// "we could not look" kept strictly apart from "there is none".

function samplesWithDwell(atSec: number, holdSec: number, cx: number, cy: number) {
	const step = 33;
	const out: Array<{ timeMs: number; cx: number; cy: number; interactionType: "move" | "click" }> =
		[];
	const startMs = (atSec - holdSec / 2) * 1000;
	const stopMs = startMs + holdSec * 1000;
	let drift = 0;
	for (let timeMs = 0; timeMs <= (atSec + holdSec) * 1000 + 2000; timeMs += step) {
		if (timeMs >= startMs && timeMs <= stopMs) {
			out.push({ timeMs, cx, cy, interactionType: timeMs === startMs ? "click" : "move" });
		} else {
			drift = (drift + 0.05) % 1;
			out.push({ timeMs, cx: drift, cy: drift, interactionType: "move" });
		}
	}
	return out;
}

describe("cursor telemetry in the snapshot", () => {
	it("reports null — not false — when nothing checked", () => {
		// THE distinction. `false` is a claim about the user's project; `null` is a
		// claim about us. Collapsing them is precisely how the model came to
		// announce that a recording with 597 samples had no pointer data.
		const snapshot = JSON.parse(
			executeAgentTool(fixtureDocument(), "getCurrentDocument", "{}").resultJson,
		);
		expect(snapshot.assets[0].hasCursorTelemetry).toBeNull();
		expect(snapshot.cursorNote).toMatch(/null/);
	});

	it("reports true / false once the runtime has looked", () => {
		const present = JSON.parse(
			executeAgentTool(fixtureDocument(), "getCurrentDocument", "{}", {
				cursorTelemetry: { availableByAssetId: { asset_1: true } },
			}).resultJson,
		);
		expect(present.assets[0].hasCursorTelemetry).toBe(true);

		const absent = JSON.parse(
			executeAgentTool(fixtureDocument(), "getCurrentDocument", "{}", {
				cursorTelemetry: { availableByAssetId: { asset_1: false } },
			}).resultJson,
		);
		expect(absent.assets[0].hasCursorTelemetry).toBe(false);
	});

	it("reports null for an asset the probe could not answer for", () => {
		// A probe that throws leaves its asset OUT of the map rather than in it as
		// `false` — our failure must not become a statement about their project.
		const snapshot = JSON.parse(
			executeAgentTool(fixtureDocument(), "getCurrentDocument", "{}", {
				cursorTelemetry: { availableByAssetId: {} },
			}).resultJson,
		);
		expect(snapshot.assets[0].hasCursorTelemetry).toBeNull();
	});
});

describe("getCursorTrack", () => {
	it("returns real samples, downsampled — not an interpretation of them", () => {
		const samples = samplesWithDwell(10, 1.4, 0.66, 0.33);
		const result = executeAgentTool(fixtureDocument(), "getCursorTrack", "{}", {
			cursorTelemetry: { load: { status: "ok", assetId: "asset_1", samples } },
		});
		const payload = JSON.parse(result.resultJson);

		expect(result.ok).toBe(true);
		expect(payload.available).toBe(true);
		expect(payload.sampleCount).toBe(samples.length);
		expect(payload.points.length).toBeGreaterThan(0);
		// Downsampling drops rows, it never invents them: every point returned has
		// to exist in the input at the same instant and the same place.
		for (const point of payload.points as Array<{ atSec: number; cx: number; cy: number }>) {
			const origin = samples.find((s) => Math.abs(s.timeMs / 1000 - point.atSec) < 0.01);
			expect(origin).toBeTruthy();
			expect(point.cx).toBeCloseTo(origin?.cx ?? -1, 2);
			expect(point.cy).toBeCloseTo(origin?.cy ?? -1, 2);
		}
		// The stationary stretch is present as points, not as a verdict about it:
		// nothing in the payload names a dwell, a hold or a focus.
		const during = (payload.points as Array<{ atSec: number }>).filter(
			(p) => p.atSec >= 10 && p.atSec <= 11.4,
		);
		expect(during.length).toBeGreaterThan(0);
		expect(result.resultJson).not.toContain("holdSec");
		expect(result.resultJson).not.toContain("moments");

		// clip_1 is source 0–30 at ruler 0–30, so source and virtual coincide on every
		// point. The envelope says so ONCE and the per-point field is left off — 28% of
		// the payload was the timestamp restated next to itself. The model still knows
		// which coordinate addZoom takes, it is just not told on every row.
		expect(payload.virtualEqualsSource).toBe(true);
		expect(payload.points.every((p: { virtualSec?: number }) => p.virtualSec === undefined)).toBe(
			true,
		);
		expect(result.resultJson).not.toContain('virtualSec":');
	});

	it("reports a hidden click and the return to visibility through the tool payload", () => {
		const samples = [
			{ timeMs: 0, cx: 0.5, cy: 0.5, visible: true, interactionType: "move" },
			{ timeMs: 50, cx: 0.5, cy: 0.5, visible: false, interactionType: "click" },
			{ timeMs: 100, cx: 0.5, cy: 0.5, visible: true, interactionType: "move" },
			{ timeMs: 1000, cx: 0.5, cy: 0.5, visible: true, interactionType: "move" },
		];
		const result = executeAgentTool(fixtureDocument(), "getCursorTrack", "{}", {
			cursorTelemetry: { load: { status: "ok", assetId: "asset_1", samples } },
		});
		const payload = JSON.parse(result.resultJson);

		expect(result.ok).toBe(true);
		expect(payload.points).toContainEqual({
			atSec: 0.05,
			cx: 0.5,
			cy: 0.5,
			kind: "click",
			visible: false,
		});
		expect(payload.points).toContainEqual({ atSec: 0.1, cx: 0.5, cy: 0.5 });
	});

	it("says 'no-sidecar' when the asset was checked and has none", () => {
		const result = executeAgentTool(fixtureDocument(), "getCursorTrack", "{}", {
			cursorTelemetry: { load: { status: "no-sidecar", assetId: "asset_1" } },
		});
		const payload = JSON.parse(result.resultJson);

		// `ok: true`: the question was answered. Marking it a failure would push a
		// model with no timeout above it into retrying a verdict that cannot change.
		expect(result.ok).toBe(true);
		expect(payload.available).toBe(false);
		expect(payload.reason).toBe("no-sidecar");
		expect(payload.note).toMatch(/fact about the asset/i);
	});

	it("says 'unavailable' — never 'no-sidecar' — when no reader is wired", () => {
		// The regression that would recreate the defect quietly: a runtime with no
		// reader reporting an absence of data instead of an absence of access.
		const result = executeAgentTool(fixtureDocument(), "getCursorTrack", "{}");
		const payload = JSON.parse(result.resultJson);

		expect(payload.available).toBe(false);
		expect(payload.reason).toBe("unavailable");
		expect(payload.reason).not.toBe("no-sidecar");
		expect(payload.note).toMatch(/report the limit as yours|limit as yours/i);
	});

	it("rejects an unknown asset instead of digesting someone else's samples", () => {
		const result = executeAgentTool(
			fixtureDocument(),
			"getCursorTrack",
			JSON.stringify({ assetId: "asset_nope" }),
			{ cursorTelemetry: { load: { status: "ok", assetId: "asset_nope", samples: [] } } },
		);
		expect(result.ok).toBe(false);
		expect(result.resultJson).toContain("Unknown asset");
	});

	it("is a read: it survives allowAgentEdits=false and mutates nothing", () => {
		// Consent gates writes. A model that may not edit must still be able to
		// describe the edit it is proposing, which means reading the telemetry it
		// would base that proposal on.
		const result = executeAgentTool(fixtureDocument(), "getCursorTrack", "{}", {
			editsAllowed: false,
			cursorTelemetry: {
				load: { status: "ok", assetId: "asset_1", samples: samplesWithDwell(5, 1, 0.5, 0.5) },
			},
		});
		expect(result.ok).toBe(true);
		expect(result.document).toBeUndefined();
		expect(JSON.parse(result.resultJson).available).toBe(true);
		expect(isMutatingTool("getCursorTrack")).toBe(false);
	});
});

// ─── D-ANCHOR: a zoom's focus is something a result can be held to ──────────
//
// `focus` was the one argument of a zoom write that no result ever mentioned. A
// span covering no clip is refused, a depth off the table is refused, and the
// span that actually landed is reported — but a focus ON the pointer and a focus
// half a frame away from it produced byte-identical results, so nothing
// downstream could tell the two apart. These tests hold both halves: the
// measurement is present and correct where the runtime can make it, and ABSENT
// everywhere it would be a claim the runtime has no standing to make.

/** A pointer parked at one place over a source window, sampled at 10 Hz — the
 *  shape a zoom's focus is usually aimed at, and the one whose spread is 0 so a
 *  test can assert the reported position exactly. */
function parkedSamples(fromSec: number, toSec: number, cx: number, cy: number) {
	const out: Array<{ timeMs: number; cx: number; cy: number }> = [];
	for (let ms = Math.round(fromSec * 1000); ms <= Math.round(toSec * 1000); ms += 100) {
		out.push({ timeMs: ms, cx, cy });
	}
	return out;
}

function withTrack(
	samples: Array<{ timeMs: number; cx: number; cy: number }>,
	assetId = "asset_1",
) {
	return { cursorTelemetry: { load: { status: "ok" as const, assetId, samples } } };
}

/** Two recordings, laid back to back. Their clips cover DIFFERENT ruler spans
 *  from IDENTICAL source windows, which is what makes reading one asset's track
 *  as if it described the other silently plausible. */
function twoAssetDocument(): AxcutDocument {
	const base = createEmptyDocument({
		title: "Two",
		projectId: "proj_two",
		createdAt: FIXTURE_CREATED_AT,
	});
	return documentSchema.parse({
		...base,
		project: { ...base.project, primaryAssetId: "asset_1" },
		assets: [
			{ id: "asset_1", kind: "video", label: "Screen", originalPath: "C:/a.mp4", durationSec: 10 },
			{ id: "asset_2", kind: "video", label: "B-roll", originalPath: "C:/b.mp4", durationSec: 10 },
		],
		timeline: {
			...base.timeline,
			clips: [
				{
					id: "clip_a",
					assetId: "asset_1",
					sourceStartSec: 0,
					sourceEndSec: 10,
					timelineStartSec: 0,
					timelineEndSec: 10,
					wordRefs: [],
					origin: "user",
					reason: "",
				},
				{
					id: "clip_b",
					assetId: "asset_2",
					sourceStartSec: 0,
					sourceEndSec: 10,
					timelineStartSec: 10,
					timelineEndSec: 20,
					wordRefs: [],
					origin: "user",
					reason: "",
				},
			],
		},
	});
}

/** Zoom ids are fresh uuids, so two runs of the same write differ in the one
 *  place that carries no meaning. Everything else must match byte for byte. */
function withoutIds(document: AxcutDocument | undefined): string {
	return JSON.stringify(document).replace(/zoom_[0-9a-f-]+/g, "zoom_x");
}

describe("addZoom answers for the focus it was given", () => {
	it("reports where the pointer really was, beside the focus it received", () => {
		// The samples outside the span are the other half of the assertion: a
		// report that averaged the whole track would land nowhere near (0.8, 0.7).
		const samples = [...parkedSamples(2, 6, 0.8, 0.7), ...parkedSamples(20, 25, 0.1, 0.2)];
		const result = executeAgentTool(
			fixtureDocument(),
			"addZoom",
			JSON.stringify({ startSec: 2, endSec: 6, focus: { cx: 0.2, cy: 0.1 } }),
			withTrack(samples),
		);
		const anchor = JSON.parse(result.resultJson).cursorAnchor;

		expect(result.ok).toBe(true);
		expect(anchor.available).toBe(true);
		expect(anchor.focus).toEqual({ cx: 0.2, cy: 0.1 });
		expect(anchor.cursor).toEqual({ cx: 0.8, cy: 0.7 });
		expect(anchor.offset).toBeCloseTo(Math.hypot(0.6, 0.6), 3);
		// A parked pointer has nowhere to stray: `spread` is what tells a reader
		// whether the single position above stands for anything.
		expect(anchor.spread).toBe(0);
		expect(anchor.samples).toBe(41);
	});

	it("echoes the default focus a call never set", () => {
		// The case a caller cannot reconstruct from its own arguments: it sent no
		// focus, so it has no record that it asked for the centre of the frame.
		const result = executeAgentTool(
			fixtureDocument(),
			"addZoom",
			JSON.stringify({ startSec: 2, endSec: 6 }),
			withTrack(parkedSamples(2, 6, 0.8, 0.7)),
		);
		const anchor = JSON.parse(result.resultJson).cursorAnchor;

		expect(anchor.focus).toEqual({ cx: 0.5, cy: 0.5 });
		expect(anchor.cursor).not.toEqual(anchor.focus);
	});

	it("reports; it does not place — the document is identical either way", () => {
		// THE invariant. This is a reporting change: a zoom written by a runtime
		// that can read telemetry and one written by a runtime that cannot must be
		// the same zoom, in the same place, described to the user the same way.
		const args = JSON.stringify({ startSec: 2, endSec: 6, focus: { cx: 0.2, cy: 0.1 } });
		// ponytail: ONE base for both runs. The invariant is about the same document
		// written by two runtimes, and comparing the outputs of two separate
		// `fixtureDocument()` calls was never that claim. (The wall-clock stamps that
		// made the two-call form flake are pinned at `FIXTURE_CREATED_AT` now — the
		// argument for one base is the invariant, not the flake.)
		const base = fixtureDocument();
		const blind = executeAgentTool(base, "addZoom", args);
		const seeing = executeAgentTool(
			base,
			"addZoom",
			args,
			withTrack(parkedSamples(2, 6, 0.8, 0.7)),
		);

		expect(withoutIds(seeing.document)).toEqual(withoutIds(blind.document));
		expect(seeing.summary).toEqual(blind.summary);
		// …and the ONLY difference is in the report.
		expect(seeing.resultJson).toContain("cursorAnchor");
		expect(blind.resultJson).not.toContain("cursorAnchor");
	});

	it("measures the span that LANDED, not the span that was asked for", () => {
		// CLAMP. `addZoom {20,40}` on a 24.70 s clip stores 20–24.704. Measuring the
		// requested window would let 152 samples the zoom never covers outvote the
		// 48 it does, and answer (0.1, 0.1) for a pointer that sat at (0.9, 0.9)
		// throughout the zoom.
		const samples = [...parkedSamples(20, 24.7, 0.9, 0.9), ...parkedSamples(24.8, 40, 0.1, 0.1)];
		const result = executeAgentTool(
			shortSingleClip(),
			"addZoom",
			JSON.stringify({ startSec: 20, endSec: 40 }),
			withTrack(samples),
		);
		const payload = JSON.parse(result.resultJson);

		expect(payload.clamped).toBe(true);
		expect(payload.cursorAnchor.cursor).toEqual({ cx: 0.9, cy: 0.9 });
		expect(payload.cursorAnchor.samples).toBe(48);
	});

	it("spans every fragment when a zoom is split across two clips", () => {
		// FRAGMENTATION. Two fragments, two source windows, one answer: reporting
		// only the first would describe half the zoom and say nothing about it.
		const samples = [
			...parkedSamples(25, 29.9, 0.7, 0.3),
			...parkedSamples(30, 35, 0.7, 0.3),
			...parkedSamples(36, 40, 0.1, 0.9),
		];
		const result = executeAgentTool(
			fixtureDocument(),
			"addZoom",
			JSON.stringify({ startSec: 25, endSec: 35 }),
			withTrack(samples),
		);
		const payload = JSON.parse(result.resultJson);

		expect(payload.fragments).toBe(2);
		// 50 from the first fragment and 51 from the second: the first alone would
		// be 50, and the decoy after the zoom ends would drag the position off
		// (0.7, 0.3) if the window were the ruler span rather than the anchors.
		expect(payload.cursorAnchor.samples).toBe(101);
		expect(payload.cursorAnchor.cursor).toEqual({ cx: 0.7, cy: 0.3 });
	});

	it("has no window to report on when nothing was placed", () => {
		// NOTHING PLACED. The span covers no clip, so the write is refused and
		// there is no landed window to measure — the refusal must not grow a
		// measurement of a zoom that does not exist.
		const telemetry = withTrack(parkedSamples(0, 30, 0.8, 0.7));
		const nowhere = executeAgentTool(
			fixtureDocument(),
			"addZoom",
			JSON.stringify({ startSec: 90, endSec: 95 }),
			telemetry,
		);
		expect(nowhere.ok).toBe(false);
		expect(nowhere.resultJson).toContain("covers no clip");
		expect(nowhere.resultJson).not.toContain("cursorAnchor");

		// Same telemetry, a span that does cover a clip: the field is there.
		const somewhere = executeAgentTool(
			fixtureDocument(),
			"addZoom",
			JSON.stringify({ startSec: 2, endSec: 6 }),
			telemetry,
		);
		expect(somewhere.resultJson).toContain("cursorAnchor");
	});

	it("stays silent when the runtime could not look, and never calls that an absence", () => {
		// Blindness is not evidence. A runtime with no reader wired, and an asset
		// whose sidecar was checked and is genuinely missing, both leave the field
		// OFF — an absent field claims nothing, while a present one saying "no
		// cursor here" would put our limit into the answer as their fact.
		const args = JSON.stringify({ startSec: 2, endSec: 6 });
		const blind = [
			undefined,
			{ cursorTelemetry: {} },
			{ cursorTelemetry: { load: { status: "unavailable" as const, assetId: "asset_1" } } },
			{ cursorTelemetry: { load: { status: "no-sidecar" as const, assetId: "asset_1" } } },
		];
		for (const options of blind) {
			const result = executeAgentTool(fixtureDocument(), "addZoom", args, options);
			expect(result.ok).toBe(true);
			expect(result.resultJson).not.toContain("cursorAnchor");
			expect(result.resultJson).not.toMatch(/cursor|pointer|telemetry/i);
		}
		// The control: the same call, on a runtime that could read the track.
		expect(
			executeAgentTool(fixtureDocument(), "addZoom", args, withTrack(parkedSamples(2, 6, 0.8, 0.7)))
				.resultJson,
		).toContain("cursorAnchor");
	});

	it("says the SPAN carries no sample, not that the recording carries none", () => {
		// The track was read and it simply does not reach here — a finding about
		// this window, and the note has to keep it that size.
		const result = executeAgentTool(
			fixtureDocument(),
			"addZoom",
			JSON.stringify({ startSec: 20, endSec: 25 }),
			withTrack(parkedSamples(0, 5, 0.8, 0.7)),
		);
		const anchor = JSON.parse(result.resultJson).cursorAnchor;

		expect(anchor.available).toBe(false);
		expect(anchor.reason).toBe("no-samples");
		expect(anchor.note).toMatch(/fact about this span/i);
		expect(anchor.note).not.toMatch(/no cursor data|has no cursor|no pointer data/i);

		// One sample inside the span is enough to turn it into a measurement: the
		// reason is about coverage, never about the recording.
		const covered = executeAgentTool(
			fixtureDocument(),
			"addZoom",
			JSON.stringify({ startSec: 20, endSec: 25 }),
			withTrack([...parkedSamples(0, 5, 0.8, 0.7), { timeMs: 22_000, cx: 0.4, cy: 0.6 }]),
		);
		expect(JSON.parse(covered.resultJson).cursorAnchor).toMatchObject({
			available: true,
			cursor: { cx: 0.4, cy: 0.6 },
			samples: 1,
		});
	});

	it("will not read a position off frames a trim cuts out of playback", () => {
		// The fixture trims source 10–12. Those instants are recorded and never
		// seen, so a focus argued from them would describe a frame no viewer
		// reaches — the same untruth as reporting the span that was requested
		// instead of the one that was stored.
		const samples = [...parkedSamples(10, 12, 0.9, 0.1), ...parkedSamples(12.1, 14, 0.3, 0.6)];
		const result = executeAgentTool(
			fixtureDocument(),
			"addZoom",
			JSON.stringify({ startSec: 10, endSec: 14 }),
			withTrack(samples),
		);
		const anchor = JSON.parse(result.resultJson).cursorAnchor;

		expect(anchor.cursor).toEqual({ cx: 0.3, cy: 0.6 });
		expect(anchor.samples).toBe(20);

		// And when the trim takes ALL of them, that is said rather than averaged in.
		const allCut = executeAgentTool(
			fixtureDocument(),
			"addZoom",
			JSON.stringify({ startSec: 10, endSec: 12 }),
			withTrack(parkedSamples(10, 12, 0.9, 0.1)),
		);
		expect(JSON.parse(allCut.resultJson).cursorAnchor).toMatchObject({
			available: false,
			reason: "trimmed-out",
		});
	});

	it("never measures a zoom against another recording's track", () => {
		// Both clips draw source 0–10 from their own asset, so asset_1's samples
		// fit asset_2's window arithmetically and would be read as a plausible
		// answer about footage they do not describe. Silence is the only honest
		// reply, and it is not a claim that asset_2 has no telemetry.
		const telemetry = withTrack(parkedSamples(0, 10, 0.8, 0.7), "asset_1");
		const otherAsset = executeAgentTool(
			twoAssetDocument(),
			"addZoom",
			JSON.stringify({ startSec: 12, endSec: 18 }),
			telemetry,
		);
		expect(otherAsset.ok).toBe(true);
		expect(otherAsset.resultJson).not.toContain("cursorAnchor");

		const ownAsset = executeAgentTool(
			twoAssetDocument(),
			"addZoom",
			JSON.stringify({ startSec: 2, endSec: 8 }),
			telemetry,
		);
		expect(JSON.parse(ownAsset.resultJson).cursorAnchor).toMatchObject({
			available: true,
			cursor: { cx: 0.8, cy: 0.7 },
		});
	});

	it("gives every region of a batch its own answer", () => {
		const result = executeAgentTool(
			fixtureDocument(),
			"addZooms",
			JSON.stringify({
				regions: [
					{ startSec: 2, endSec: 6 },
					{ startSec: 20, endSec: 24 },
				],
			}),
			withTrack(parkedSamples(2, 6, 0.8, 0.7)),
		);
		const applied = JSON.parse(result.resultJson).applied;

		expect(applied[0].cursorAnchor).toMatchObject({
			available: true,
			cursor: { cx: 0.8, cy: 0.7 },
		});
		// One measured, one not: a batch answer that leaned on the first region
		// would describe the second with a position taken from somewhere else.
		expect(applied[1].cursorAnchor).toMatchObject({ available: false, reason: "no-samples" });
	});
});

describe("setZoom answers for the focus it kept", () => {
	function seededZoom(): { document: AxcutDocument; zoomId: string } {
		const document = executeAgentTool(
			fixtureDocument(),
			"addZoom",
			JSON.stringify({ startSec: 2, endSec: 6, focus: { cx: 0.2, cy: 0.1 } }),
		).document as AxcutDocument;
		return { document, zoomId: document.zoomRanges[0].id };
	}

	it("measures the moved span against the focus the call did not touch", () => {
		// Reshaping a zoom is mostly a question about where it now points, and the
		// focus is read back off the document rather than off the arguments —
		// exactly as `renderedScale` already is.
		const { document, zoomId } = seededZoom();
		const result = executeAgentTool(
			document,
			"setZoom",
			JSON.stringify({ zoomId, startSec: 20, endSec: 24 }),
			withTrack(parkedSamples(20, 24, 0.55, 0.45)),
		);
		const anchor = JSON.parse(result.resultJson).cursorAnchor;

		expect(anchor.focus).toEqual({ cx: 0.2, cy: 0.1 });
		expect(anchor.cursor).toEqual({ cx: 0.55, cy: 0.45 });
	});

	it("says nothing about the pointer when no track was read", () => {
		const { document, zoomId } = seededZoom();
		const result = executeAgentTool(
			document,
			"setZoom",
			JSON.stringify({ zoomId, startSec: 20, endSec: 24 }),
		);
		expect(result.ok).toBe(true);
		expect(result.resultJson).not.toContain("cursorAnchor");
	});
});

// Issue #350 / #560 — the audio tools. #561 landed the timeline audio without any
// agent surface, so these cover both that the model can see it and that it cannot
// invent an asset to place.
describe("addAudio / setAudio", () => {
	/** The fixture plus one imported audio asset. */
	function withAudioAsset(durationSec: number | null = 30): AxcutDocument {
		const doc = fixtureDocument();
		return documentSchema.parse({
			...doc,
			assets: [
				...doc.assets,
				{
					id: "audio_1",
					kind: "audio",
					label: "bed.mp3",
					originalPath: "C:/audio/bed.mp3",
					...(durationSec == null ? {} : { durationSec }),
				},
			],
		});
	}

	const place = (doc: AxcutDocument, args: Record<string, unknown>) =>
		executeAgentTool(doc, "addAudio", JSON.stringify(args));

	it("reports imported audio in the snapshot, with the asset kind beside it", () => {
		// Without `kind` the model sees an asset it cannot explain and tries to place it
		// as footage; without `audioTracks` it cannot see the lanes at all.
		const placed = place(withAudioAsset(), {
			assetId: "audio_1",
			startSec: 2,
			endSec: 6,
			kind: "voiceover",
		});
		expect(placed.ok).toBe(true);
		const snapshot = executeAgentTool(placed.document as AxcutDocument, "getCurrentDocument", "");
		const parsed = JSON.parse(snapshot.resultJson);
		expect(parsed.assets.find((a: { id: string }) => a.id === "audio_1").kind).toBe("audio");
		expect(parsed.audioTracks).toHaveLength(1);
		expect(parsed.audioTracks[0]).toMatchObject({
			assetId: "audio_1",
			kind: "voiceover",
			startSec: 2,
			endSec: 6,
		});
	});

	it("anchors the placed track to the clip under it", () => {
		const result = place(withAudioAsset(), { assetId: "audio_1", startSec: 2, endSec: 6 });
		expect(result.ok).toBe(true);
		const track = (result.document as AxcutDocument).audioTracks[0];
		// The anchor is what makes it travel with its clip; a bare startMs/endMs would not.
		expect(track.clipId).toBe("clip_1");
		expect(track.origin).toBe("agent");
	});

	it("plays the whole file when endSec is omitted", () => {
		const result = place(withAudioAsset(20), { assetId: "audio_1", startSec: 0, offsetSec: 5 });
		expect(result.ok).toBe(true);
		const track = (result.document as AxcutDocument).audioTracks[0];
		// 20s file from an in-point of 5s = 15s of span, so the model never computes it.
		expect(track.endMs - track.startMs).toBe(15_000);
	});

	it("refuses an offset at or past the end of a known file", () => {
		// Otherwise the omitted-end fallback mints a 0.1s track that plays silence, and
		// the model reports it as having placed audio.
		const result = place(withAudioAsset(20), { assetId: "audio_1", startSec: 0, offsetSec: 20 });
		expect(result.ok).toBe(false);
		expect(result.resultJson).toContain("offsetSec");
	});

	it("allows any offset while the duration is unknown", () => {
		// A failed probe leaves no duration; refusing on that would block a legitimate call.
		expect(place(withAudioAsset(null), { assetId: "audio_1", startSec: 0, offsetSec: 99 }).ok).toBe(
			true,
		);
	});

	it("refuses an unknown asset and names the audio the project actually has", () => {
		const result = place(withAudioAsset(), { assetId: "nope", startSec: 0, endSec: 4 });
		expect(result.ok).toBe(false);
		expect(result.resultJson).toContain("audio_1");
	});

	it("refuses a video asset, pointing at the tool that does place footage", () => {
		const result = place(withAudioAsset(), { assetId: "asset_1", startSec: 0, endSec: 4 });
		expect(result.ok).toBe(false);
		expect(result.resultJson).toContain("insertClip");
	});

	it("setAudio re-levels and re-lanes the track it names", () => {
		const placed = place(withAudioAsset(), { assetId: "audio_1", startSec: 2, endSec: 6 });
		const id = JSON.parse(placed.resultJson).audioId;
		const result = executeAgentTool(
			placed.document as AxcutDocument,
			"setAudio",
			JSON.stringify({ audioId: id, gainDb: -6, kind: "voiceover" }),
		);
		expect(result.ok).toBe(true);
		expect((result.document as AxcutDocument).audioTracks[0]).toMatchObject({
			gainDb: -6,
			kind: "voiceover",
		});
	});

	it("fades a track in and out, reads the fades back, and refuses one past the inspector's cap", () => {
		const placed = place(withAudioAsset(), {
			assetId: "audio_1",
			startSec: 2,
			endSec: 6,
			fadeInMs: 800,
		});
		expect(placed.document?.audioTracks[0]).toMatchObject({ fadeInMs: 800, fadeOutMs: 0 });
		const id = JSON.parse(placed.resultJson).audioId;
		const faded = executeAgentTool(
			placed.document as AxcutDocument,
			"setAudio",
			JSON.stringify({ audioId: id, fadeOutMs: 1500 }),
		);
		expect(JSON.parse(faded.resultJson)).toMatchObject({ fadeInMs: 800, fadeOutMs: 1500 });
		const snapshot = JSON.parse(
			executeAgentTool(faded.document as AxcutDocument, "getCurrentDocument", "").resultJson,
		);
		expect(snapshot.audioTracks[0]).toMatchObject({ fadeInMs: 800, fadeOutMs: 1500 });
		expect(
			executeAgentTool(
				placed.document as AxcutDocument,
				"setAudio",
				JSON.stringify({ audioId: id, fadeInMs: 5001 }),
			).ok,
		).toBe(false);
	});

	it("setAudio applies the same offset guard as addAudio", () => {
		const placed = place(withAudioAsset(20), { assetId: "audio_1", startSec: 2, endSec: 6 });
		const id = JSON.parse(placed.resultJson).audioId;
		const result = executeAgentTool(
			placed.document as AxcutDocument,
			"setAudio",
			JSON.stringify({ audioId: id, offsetSec: 25 }),
		);
		expect(result.ok).toBe(false);
	});

	it("removeModifier deletes an audio track by id, like every other kind", () => {
		const placed = place(withAudioAsset(), { assetId: "audio_1", startSec: 2, endSec: 6 });
		const id = JSON.parse(placed.resultJson).audioId;
		const result = executeAgentTool(
			placed.document as AxcutDocument,
			"removeModifier",
			JSON.stringify({ id }),
		);
		expect(result.ok).toBe(true);
		expect((result.document as AxcutDocument).audioTracks).toEqual([]);
	});
});

// ─── Correcting a word from the chat ─────────────────────────────
// The model could READ the transcript and CUT it, and that was all. Asked to fix a
// misheard name it had exactly one tool that touched a word — addTrim — which removes the
// audio with it. These two close that: one read that hands out word ids, one write that
// changes text and nothing else.

/** A transcript with real words, one of them already corrected by the user. */
function documentWithWords(): AxcutDocument {
	const base = fixtureDocument();
	return {
		...base,
		transcripts: [
			{
				assetId: "asset_1",
				language: "en",
				segments: [
					{
						id: "seg_1",
						kind: "speech",
						startSec: 0,
						endSec: 3,
						text: "I use Cuber Nettes",
						wordIds: ["word_1", "word_2", "word_3"],
					},
				],
				words: [
					{ id: "word_1", segmentId: "seg_1", startSec: 0, endSec: 1, text: "I" },
					{ id: "word_2", segmentId: "seg_1", startSec: 1, endSec: 2, text: "use" },
					{
						id: "word_3",
						segmentId: "seg_1",
						startSec: 2,
						endSec: 3,
						text: "Cuber Nettes",
					},
				],
			},
		],
	};
}

function run(document: AxcutDocument, name: string, args: unknown) {
	return executeAgentTool(document, name, JSON.stringify(args), { editsAllowed: true });
}

describe("getTranscriptWords", () => {
	it("hands out the ids setWordText takes", () => {
		const result = run(documentWithWords(), "getTranscriptWords", {});
		const payload = JSON.parse(result.resultJson) as {
			words: Array<{ id: string; text: string }>;
			total: number;
		};
		expect(result.ok).toBe(true);
		expect(payload.total).toBe(3);
		expect(payload.words.map((w) => w.id)).toEqual(["word_1", "word_2", "word_3"]);
	});

	// A half-hour transcript is ~70k tokens. Fixing one name should cost one phrase.
	it("returns only the words touching the span it is given", () => {
		const result = run(documentWithWords(), "getTranscriptWords", { startSec: 2, endSec: 3 });
		const payload = JSON.parse(result.resultJson) as {
			words: Array<{ id: string }>;
			total: number;
		};
		// Touching counts: `word_2` ends exactly where the span begins. Inclusive on
		// purpose — a word with no duration at all (one the user typed in) sits on a
		// single point, and a strict overlap would drop it from every span it meets.
		expect(payload.words.map((w) => w.id)).toEqual(["word_2", "word_3"]);
		// `total` still reports the whole transcript, so a filtered read never reads as
		// the entire thing.
		expect(payload.total).toBe(3);
	});

	it("says nothing about provenance for a plainly transcribed word", () => {
		const result = run(documentWithWords(), "getTranscriptWords", {});
		const payload = JSON.parse(result.resultJson) as { words: Array<Record<string, unknown>> };
		expect(payload.words[0]).not.toHaveProperty("source");
		expect(payload.words[0]).not.toHaveProperty("originalText");
	});

	it("names what the transcriber had heard, once a word is corrected", () => {
		const corrected = run(documentWithWords(), "setWordText", {
			wordId: "word_3",
			text: "Kubernetes",
		});
		const result = run(corrected.document as AxcutDocument, "getTranscriptWords", {});
		const payload = JSON.parse(result.resultJson) as {
			words: Array<{ id: string; source?: string; originalText?: string }>;
		};
		expect(payload.words.find((w) => w.id === "word_3")).toMatchObject({
			source: "user",
			originalText: "Cuber Nettes",
		});
	});

	it("refuses an asset with no transcript instead of answering with nothing", () => {
		const result = run({ ...fixtureDocument(), transcripts: [] }, "getTranscriptWords", {});
		expect(result.ok).toBe(false);
		expect(result.resultJson).toContain("No transcript");
	});
});

describe("removeWords", () => {
	function repeatedWordDocument(): AxcutDocument {
		const base = fixtureDocument();
		return {
			...base,
			transcripts: [
				{
					...base.transcripts[0],
					words: [
						{ id: "filler", segmentId: "seg_1", startSec: 1, endSec: 1.2, text: "like" },
						{ id: "meaningful", segmentId: "seg_1", startSec: 3, endSec: 3.2, text: "like" },
					],
				},
			],
		};
	}

	it("cuts only the selected occurrence and reports the trim actually stored", () => {
		const before = repeatedWordDocument();
		const read = run(before, "getTranscriptWords", {});
		expect(JSON.parse(read.resultJson).words.map((word: { id: string }) => word.id)).toEqual([
			"filler",
			"meaningful",
		]);
		const result = run(before, "removeWords", { wordIds: ["filler"] });
		expect(result.ok).toBe(true);
		const next = result.document as AxcutDocument;
		const trim = next.timeline.trimRanges.at(-1);
		expect(trim).toMatchObject({ assetId: "asset_1", clipId: "clip_1", origin: "agent" });
		expect(trim?.endSec).toBeLessThan(3); // the second "like" still plays
		expect(next.transcripts).toEqual(before.transcripts);
		expect(next.timeline.clips).toEqual(before.timeline.clips);
		const payload = JSON.parse(result.resultJson);
		expect(payload).toMatchObject({
			requested: 1,
			removedCount: 1,
			removed: [
				{
					wordId: "filler",
					text: "like",
					assetId: "asset_1",
					clipId: "clip_1",
					wordStartSec: 1,
					wordEndSec: 1.2,
					trimRangeId: trim?.id,
					startSec: trim?.startSec,
					endSec: trim?.endSec,
				},
			],
		});
		expect(next.timeline.trimRanges).toHaveLength(before.timeline.trimRanges.length + 1);
	});

	it("cuts consecutive words as one span, gaps included, and the others apart", () => {
		const base = fixtureDocument();
		const before: AxcutDocument = {
			...base,
			transcripts: [
				{
					...base.transcripts[0],
					words: [
						{ id: "word_1", segmentId: "seg_1", startSec: 1, endSec: 1.2, text: "so" },
						{ id: "word_2", segmentId: "seg_1", startSec: 1.4, endSec: 1.5, text: "I" },
						{ id: "word_3", segmentId: "seg_1", startSec: 1.6, endSec: 1.9, text: "mean" },
						{ id: "word_4", segmentId: "seg_1", startSec: 2.2, endSec: 2.4, text: "the" },
						{ id: "word_5", segmentId: "seg_1", startSec: 3, endSec: 3.2, text: "um" },
					],
				},
			],
		};
		const result = run(before, "removeWords", { wordIds: ["word_3", "word_5", "word_2"] });
		expect(result.ok).toBe(true);
		const added = result.document?.timeline.trimRanges.slice(before.timeline.trimRanges.length);
		expect(added?.map(({ startSec, endSec }) => [startSec, endSec])).toEqual([
			[1.4, 1.9],
			[3, 3.2],
		]);
		const removed = JSON.parse(result.resultJson).removed;
		expect(removed.map((word: { wordId: string }) => word.wordId)).toEqual([
			"word_2",
			"word_3",
			"word_5",
		]);
		expect(removed[1].trimRangeId).toBe(removed[0].trimRangeId);
		expect(removed[2].trimRangeId).not.toBe(removed[0].trimRangeId);
	});

	it("refuses a duplicated or already-cut word without cutting anything", () => {
		const before = repeatedWordDocument();
		const duplicated = run(before, "removeWords", { wordIds: ["filler", "filler"] });
		expect(duplicated.ok).toBe(false);
		expect(duplicated.document).toBeUndefined();
		const cut = run(before, "removeWords", { wordIds: ["filler"] }).document as AxcutDocument;
		const again = run(cut, "removeWords", { wordIds: ["meaningful", "filler"] });
		expect(again.ok).toBe(false);
		expect(again.document).toBeUndefined();
		expect(again.resultJson).toContain("already cut");
	});

	it("preserves addTrim warnings when removing a filler cuts a zoom transition", () => {
		const before = repeatedWordDocument();
		before.timeline.trimRanges = [];
		const zoomed = run(before, "addZoom", { startSec: 2, endSec: 3, depth: 3 }).document;
		expect(zoomed).toBeDefined();
		if (!zoomed) throw new Error("Zoom fixture failed");
		const directTrim = run(zoomed, "addTrim", {
			assetId: "asset_1",
			clipId: "clip_1",
			startSec: 1,
			endSec: 1.2,
		});
		const expected = JSON.parse(directTrim.resultJson).cutTransitions;
		expect(expected.length).toBeGreaterThan(0);
		const removed = run(zoomed, "removeWords", { assetId: "asset_1", wordIds: ["filler"] });
		expect(removed.ok).toBe(true);
		expect(JSON.parse(removed.resultJson).cutTransitions).toEqual(expected);
	});

	it("refuses an invalid ID atomically, including when another ID is valid", () => {
		const before = repeatedWordDocument();
		const result = run(before, "removeWords", { wordIds: ["filler", "missing"] });
		expect(result.ok).toBe(false);
		expect(result.document).toBeUndefined();
		expect(result.resultJson).toContain("Unknown transcript word ID: missing");
		expect(before.timeline.trimRanges).toHaveLength(1);
	});

	it("resolves a word ID to its own asset and clip, not the primary asset", () => {
		const before = repeatedWordDocument();
		before.assets.push({ ...before.assets[0], id: "asset_2" });
		before.timeline.clips.push({
			...before.timeline.clips[0],
			id: "clip_3",
			assetId: "asset_2",
		});
		before.transcripts.push({
			...before.transcripts[0],
			assetId: "asset_2",
			words: [{ id: "other_filler", segmentId: "seg_1", startSec: 4, endSec: 4.2, text: "um" }],
		});
		const result = run(before, "removeWords", { wordIds: ["other_filler"] });
		expect(result.ok).toBe(true);
		expect(result.document?.timeline.trimRanges.at(-1)).toMatchObject({
			assetId: "asset_2",
			clipId: "clip_3",
		});
		expect(JSON.parse(result.resultJson).removed[0]).toMatchObject({
			assetId: "asset_2",
			clipId: "clip_3",
		});
	});

	it("qualifies normally numbered word IDs by the asset read from the transcript", () => {
		const before = repeatedWordDocument();
		before.transcripts[0].words[0].id = "word_1";
		before.assets.push({ ...before.assets[0], id: "asset_2" });
		before.timeline.clips.push({ ...before.timeline.clips[0], id: "clip_3", assetId: "asset_2" });
		before.transcripts.push({
			...before.transcripts[0],
			assetId: "asset_2",
			words: [{ id: "word_1", segmentId: "seg_1", startSec: 4, endSec: 4.2, text: "um" }],
		});
		const read = JSON.parse(run(before, "getTranscriptWords", { assetId: "asset_2" }).resultJson);
		expect(read.words[0].id).toBe("word_1");
		const result = run(before, "removeWords", {
			assetId: "asset_2",
			wordIds: [read.words[0].id],
		});
		expect(result.ok).toBe(true);
		expect(result.document?.timeline.trimRanges.at(-1)).toMatchObject({
			assetId: "asset_2",
			clipId: "clip_3",
		});
		expect(
			result.document?.timeline.trimRanges.filter((trim) => trim.assetId === "asset_1"),
		).toEqual(before.timeline.trimRanges);
		expect(result.document?.transcripts).toEqual(before.transcripts);
		const ambiguous = run(before, "removeWords", { wordIds: ["word_1"] });
		expect(ambiguous.ok).toBe(false);
		expect(ambiguous.document).toBeUndefined();
		const unknownAsset = run(before, "removeWords", {
			assetId: "missing_asset",
			wordIds: ["word_1"],
		});
		expect(unknownAsset.ok).toBe(false);
		expect(unknownAsset.document).toBeUndefined();
	});

	it("refuses invalid timestamps without guessing a span", () => {
		const before = repeatedWordDocument();
		before.transcripts[0].words[0].endSec = Number.NaN;
		const result = run(before, "removeWords", { wordIds: ["filler"] });
		expect(result.ok).toBe(false);
		expect(result.document).toBeUndefined();
		expect(result.resultJson).toContain("invalid source timestamps");
	});

	it("refuses a word covered by two clips", () => {
		const before = repeatedWordDocument();
		before.timeline.clips.push({
			...before.timeline.clips[0],
			id: "duplicate_clip",
		});
		const result = run(before, "removeWords", { wordIds: ["filler"] });
		expect(result.ok).toBe(false);
		expect(result.document).toBeUndefined();
		expect(result.resultJson).toContain("exactly one clip; found 2");
	});

	it("honours project edit consent", () => {
		const result = executeAgentTool(
			repeatedWordDocument(),
			"removeWords",
			JSON.stringify({ wordIds: ["filler"] }),
			{ editsAllowed: false },
		);
		expect(result.document).toBeUndefined();
		expect(JSON.parse(result.resultJson).code).toBe("consent_required");
	});
});

describe("setWordText", () => {
	it("changes the text and leaves the timeline alone", () => {
		const before = documentWithWords();
		const result = run(before, "setWordText", { wordId: "word_3", text: "Kubernetes" });
		expect(result.ok).toBe(true);
		const next = result.document as AxcutDocument;
		expect(next.transcripts[0].words.find((w) => w.id === "word_3")?.text).toBe("Kubernetes");
		expect(next.timeline).toEqual(before.timeline);
		expect(next.transcripts[0].segments[0].text).toBe("I use Kubernetes");
	});

	// The editor gates word INSERTION on a dev-only flag, and that gate lives in the renderer.
	// The chat runs in the main process, so an ungated path here would let a release rewrite
	// generated media through the agent — the one door the flag cannot see.
	it("refuses a word that was added rather than heard", () => {
		const base = documentWithWords();
		const withInsertion: AxcutDocument = {
			...base,
			transcripts: [
				...base.transcripts,
				{
					assetId: "ext:synth_1",
					language: "en",
					segments: [],
					words: [
						{
							id: "synth_1",
							segmentId: "seg_1",
							startSec: 0,
							endSec: 0.15,
							text: "added",
							source: "synth",
						},
					],
				},
			],
		};
		const result = run(withInsertion, "setWordText", {
			assetId: "ext:synth_1",
			wordId: "synth_1",
			text: "much longer",
		});
		expect(result.ok).toBe(false);
		expect(result.document).toBeUndefined();
	});

	// The document carries the transcript twice; a write that reaches only one leaves the
	// legacy mirror serving the old text forever.
	it("writes the legacy mirror too", () => {
		const result = run(documentWithWords(), "setWordText", {
			wordId: "word_3",
			text: "Kubernetes",
		});
		const next = result.document as AxcutDocument;
		expect(next.transcript).toBe(next.transcripts.find((t) => t.assetId === "asset_1"));
	});

	it("empties a word without cutting the speech around it", () => {
		const result = run(documentWithWords(), "setWordText", { wordId: "word_2", text: "" });
		const next = result.document as AxcutDocument;
		expect(next.transcripts[0].words.find((w) => w.id === "word_2")?.text).toBe("");
		expect(next.transcripts[0].segments[0].text).toBe("I Cuber Nettes");
		expect(JSON.parse(result.resultJson)).toMatchObject({ blanked: true });
	});

	it("points an unknown id at the read that hands them out", () => {
		const result = run(documentWithWords(), "setWordText", { wordId: "seg_1", text: "x" });
		expect(result.ok).toBe(false);
		// `seg_1` is a real id — of a SEGMENT. The two namespaces are the trap.
		expect(result.resultJson).toContain("getTranscriptWords");
	});

	it("refuses a write that would change nothing", () => {
		const result = run(documentWithWords(), "setWordText", { wordId: "word_2", text: "use" });
		expect(result.ok).toBe(false);
		expect(result.document).toBeUndefined();
	});

	it("is a consented edit, not a read", () => {
		const result = executeAgentTool(
			documentWithWords(),
			"setWordText",
			JSON.stringify({ wordId: "word_3", text: "Kubernetes" }),
			{ editsAllowed: false },
		);
		expect(result.document).toBeUndefined();
	});
});

describe("addTrim shapes the cut like the transcript pane", () => {
	// A 1.0-1.5, B 2.0-2.4, C 3.0-3.5: the production shape, one word per segment.
	function withWords(): AxcutDocument {
		const doc = fixtureDocument();
		const words = [
			{ id: "w_a", segmentId: "seg_1", startSec: 1, endSec: 1.5, text: "A" },
			{ id: "w_b", segmentId: "seg_1", startSec: 2, endSec: 2.4, text: "B" },
			{ id: "w_c", segmentId: "seg_1", startSec: 3, endSec: 3.5, text: "C" },
		];
		return { ...doc, transcripts: [{ ...doc.transcripts[0], words }] };
	}
	const lastTrim = (doc: AxcutDocument | undefined) => doc?.timeline.trimRanges.at(-1);

	it("keeps breath next to the kept words when a word goes with both its silences", () => {
		const result = executeAgentTool(
			withWords(),
			"addTrim",
			JSON.stringify({ startSec: 1.5, endSec: 3 }),
		);
		expect(result.ok).toBe(true);
		expect(lastTrim(result.document)?.startSec).toBeCloseTo(1.57);
		expect(lastTrim(result.document)?.endSec).toBeCloseTo(2.93);
	});

	it("does not breathe next to a word an earlier cut already took (addTrims)", () => {
		const doc = withWords();
		doc.timeline.trimRanges.push({
			id: "trim_a",
			assetId: "asset_1",
			clipId: "clip_1",
			startSec: 1,
			endSec: 1.5,
			reason: "",
			origin: "agent",
		});
		const result = executeAgentTool(
			doc,
			"addTrims",
			JSON.stringify({ ranges: [{ startSec: 1.5, endSec: 2 }] }),
		);
		expect(lastTrim(result.document)?.startSec).toBe(1.5);
		expect(lastTrim(result.document)?.endSec).toBeCloseTo(1.93);
	});

	it("closes a gap under two frames against a cut already on the clip", () => {
		// trim_1 covers 10-12 on asset_1; 50 ms of picture would flash between the two.
		const result = executeAgentTool(
			fixtureDocument(),
			"addTrim",
			JSON.stringify({ startSec: 12.05, endSec: 15 }),
		);
		expect(lastTrim(result.document)?.startSec).toBe(12);
		expect(lastTrim(result.document)?.endSec).toBe(15);
	});
});

describe("zoom transitions are reported, not hidden (#1028)", () => {
	// 1.8× (depth 3): each move lasts 0.6 + 0.55·ln 1.8 ≈ 0.923 s of screen time.
	const MOVE_SEC = 0.923;

	function run(document: AxcutDocument, name: string, args: unknown) {
		const result = executeAgentTool(document, name, JSON.stringify(args));
		expect(result.ok).toBe(true);
		return { document: result.document ?? document, payload: JSON.parse(result.resultJson) };
	}

	function zoomedAt10to12() {
		return run(shortSingleClip(), "addZoom", { startSec: 10, endSec: 12, depth: 3 });
	}

	function snapshotZoom(document: AxcutDocument) {
		return run(document, "getCurrentDocument", {}).payload.zoomRanges[0];
	}

	it("gives each zoom its move windows on the timeline", () => {
		const added = zoomedAt10to12();
		expect(added.payload.cutTransitions).toBeUndefined();
		const zoom = snapshotZoom(added.document);
		expect(zoom.transitionSec).toBe(MOVE_SEC);
		expect(zoom.zoomInFromSec).toBe(10 - MOVE_SEC);
		expect(zoom.zoomOutUntilSec).toBe(12 + MOVE_SEC);
		expect(zoom.cutByTrim).toBeUndefined();
	});

	it("warns when a trim at the zoom's end cuts its whole zoom-out (the issue's repro)", () => {
		const trimmed = run(zoomedAt10to12().document, "addTrim", { startSec: 12, endSec: 14 });
		const zoomId = snapshotZoom(trimmed.document).id;
		expect(trimmed.payload.cutTransitions).toEqual([
			{ zoomId, side: "out", cutSec: MOVE_SEC, by: "trim" },
		]);
		expect(snapshotZoom(trimmed.document).cutByTrim).toBe("out");
	});

	it("flags a zoom on the second clip of an asset that a trim without clipId cuts", () => {
		// Two clips over one recording, and a pre-v7 trim (no clipId): playback cuts it from
		// both clips, while the ruler maps it through the first one only.
		const base = shortSingleClip();
		const clip = base.timeline.clips[0];
		const length = (clip.sourceEndSec ?? 0) - clip.sourceStartSec;
		const twoClips: AxcutDocument = {
			...base,
			timeline: {
				...base.timeline,
				clips: [
					clip,
					{
						...clip,
						id: "clip_2",
						timelineStartSec: length,
						timelineEndSec: 2 * length,
					},
				],
				trimRanges: [
					{
						id: "trim_legacy",
						assetId: clip.assetId,
						startSec: 12,
						endSec: 14,
						reason: "",
						origin: "user",
					},
				],
			},
		};
		const added = run(twoClips, "addZoom", {
			startSec: length + 10,
			endSec: length + 12,
			depth: 3,
		});
		expect(added.payload.cutTransitions).toEqual([
			{ zoomId: added.payload.zoomId, side: "out", cutSec: MOVE_SEC, by: "trim" },
		]);
	});

	it("stays quiet about a trim clear of both windows", () => {
		const trimmed = run(zoomedAt10to12().document, "addTrim", { startSec: 14, endSec: 15 });
		expect(trimmed.payload.cutTransitions).toBeUndefined();
	});

	it("warns the zoom write too, when it lands next to an existing cut", () => {
		const trimmed = run(shortSingleClip(), "addTrim", { startSec: 8, endSec: 9.5 });
		const added = run(trimmed.document, "addZoom", { startSec: 10, endSec: 12, depth: 3 });
		expect(added.payload.cutTransitions).toEqual([
			{ zoomId: added.payload.zoomId, side: "in", cutSec: 0.423, by: "trim" },
		]);
		expect(snapshotZoom(added.document).cutByTrim).toBe("in");
	});

	it("repeats the warning when setZoom moves a zoom that is still cut", () => {
		const trimmed = run(zoomedAt10to12().document, "addTrim", { startSec: 12, endSec: 14 });
		const zoomId = snapshotZoom(trimmed.document).id;
		const moved = run(trimmed.document, "setZoom", { zoomId, startSec: 9 });
		expect(moved.payload.cutTransitions).toEqual([
			{ zoomId: moved.payload.zoomId, side: "out", cutSec: MOVE_SEC, by: "trim" },
		]);
	});

	it("reports two zooms closer than 1.5 s as one pan, not a zoom-out and back in", () => {
		const chained = run(zoomedAt10to12().document, "addZoom", {
			startSec: 12.5,
			endSec: 14,
			depth: 3,
		});
		const [first, second] = run(chained.document, "getCurrentDocument", {}).payload.zoomRanges;
		expect(first).toMatchObject({ panToZoomId: second.id, panUntilSec: 13 });
		expect(first.zoomOutUntilSec).toBeUndefined();
		expect(first.zoomInFromSec).toBe(10 - MOVE_SEC);
		expect(second.panFromZoomId).toBe(first.id);
		expect(second.zoomInFromSec).toBeUndefined();
		expect(second.zoomOutUntilSec).toBe(14 + MOVE_SEC);
	});

	it("warns of both moves when a trim between two chained zooms breaks the chain", () => {
		const chained = run(zoomedAt10to12().document, "addZoom", {
			startSec: 12.5,
			endSec: 14,
			depth: 3,
		});
		const trimmed = run(chained.document, "addTrim", { startSec: 12, endSec: 12.5 });
		const [first, second] = run(trimmed.document, "getCurrentDocument", {}).payload.zoomRanges;
		expect(first.panToZoomId).toBeUndefined();
		expect(trimmed.payload.cutTransitions).toEqual([
			{ zoomId: first.id, side: "out", cutSec: MOVE_SEC, by: "trim" },
			{ zoomId: second.id, side: "in", cutSec: MOVE_SEC, by: "trim" },
		]);
	});

	it("does not chain zooms across a clip junction", () => {
		const base = shortSingleClip();
		const clip = base.timeline.clips[0];
		const twoClips: AxcutDocument = {
			...base,
			timeline: {
				...base.timeline,
				clips: [
					{ ...clip, sourceEndSec: 12, timelineEndSec: 12 },
					{ ...clip, id: "clip_2", sourceStartSec: 12, timelineStartSec: 12 },
				],
			},
		};
		const first = run(twoClips, "addZoom", { startSec: 10, endSec: 12, depth: 3 });
		const both = run(first.document, "addZoom", { startSec: 12.5, endSec: 14, depth: 3 });
		const zooms = run(both.document, "getCurrentDocument", {}).payload.zoomRanges;
		expect(zooms[0].panToZoomId).toBeUndefined();
		expect(zooms[0].zoomOutUntilSec).toBe(12 + MOVE_SEC);

		// Each clip renders on its own: the junction cuts the first zoom's whole zoom-out and
		// the start of the second one's zoom-in, and says it is a junction, not a trim.
		expect(first.payload.cutTransitions).toEqual([
			{ zoomId: first.payload.zoomId, side: "out", cutSec: MOVE_SEC, by: "junction" },
		]);
		expect(both.payload.cutTransitions).toEqual([
			{ zoomId: both.payload.zoomId, side: "in", cutSec: 0.423, by: "junction" },
		]);
		expect(zooms[0]).toMatchObject({ cutByJunction: "out" });
		expect(zooms[1]).toMatchObject({ cutByJunction: "in" });
		expect(zooms[0].cutByTrim).toBeUndefined();
		expect(zooms[1].cutByTrim).toBeUndefined();
	});

	it("names a trim and a junction apart on the same zoom", () => {
		const base = shortSingleClip();
		const clip = base.timeline.clips[0];
		const twoClips: AxcutDocument = {
			...base,
			timeline: {
				...base.timeline,
				clips: [
					{ ...clip, sourceEndSec: 12.5, timelineEndSec: 12.5 },
					{ ...clip, id: "clip_2", sourceStartSec: 12.5, timelineStartSec: 12.5 },
				],
			},
		};
		const zoomed = run(twoClips, "addZoom", { startSec: 10, endSec: 12, depth: 3 });
		const trimmed = run(zoomed.document, "addTrim", { startSec: 9, endSec: 9.5 });
		expect(snapshotZoom(trimmed.document)).toMatchObject({ cutByTrim: "in", cutByJunction: "out" });
	});

	it("does not call the end of the timeline a junction", () => {
		const base = shortSingleClip();
		const end = base.timeline.clips[0].timelineEndSec;
		const added = run(base, "addZoom", { startSec: end - 2, endSec: end - 0.5, depth: 3 });
		expect(added.payload.cutTransitions).toBeUndefined();
		expect(snapshotZoom(added.document).cutByJunction).toBeUndefined();
	});

	it("stretches the zoom-out across a speed region, and catches a trim placed there", () => {
		const sped = run(zoomedAt10to12().document, "addSpeed", { startSec: 12, endSec: 20, speed: 3 });
		expect(snapshotZoom(sped.document).zoomOutUntilSec).toBe(14.77);
		const trimmed = run(sped.document, "addTrims", { ranges: [{ startSec: 14, endSec: 15 }] });
		expect(trimmed.payload.applied[0].cutTransitions).toEqual([
			{ zoomId: snapshotZoom(trimmed.document).id, side: "out", cutSec: 0.77, by: "trim" },
		]);
	});
});

// #1180 batch C: what the inspector sets on a zoom or an annotation, the agent sets and reads back.
describe("region tools reach the inspector's settings (#1180)", () => {
	const run = (doc: AxcutDocument, name: string, args: Record<string, unknown>) => {
		const result = executeAgentTool(doc, name, JSON.stringify(args));
		return { ...result, payload: JSON.parse(result.resultJson) };
	};
	const snapshot = (doc: AxcutDocument | undefined) =>
		JSON.parse(executeAgentTool(doc as AxcutDocument, "getCurrentDocument", "").resultJson);

	it("sets a zoom's focus mode, hidden cursor and free level, and reads them back", () => {
		const added = run(fixtureDocument(), "addZoom", {
			startSec: 2,
			endSec: 4,
			focusMode: "auto",
			hideCursor: true,
			customScale: 1.6,
		});
		expect(added.ok).toBe(true);
		expect(added.document?.zoomRanges[0]).toMatchObject({
			focusMode: "auto",
			hideCursor: true,
			customScale: 1.6,
		});
		expect(added.payload).toMatchObject({
			focusMode: "auto",
			hideCursor: true,
			renderedScale: 1.6,
		});
		expect(() => documentSchema.parse(added.document)).not.toThrow();
		expect(snapshot(added.document).zoomRanges[0]).toMatchObject({
			focusMode: "auto",
			hideCursor: true,
			customScale: 1.6,
			renderedScale: 1.6,
		});

		const id = added.payload.zoomId;
		const shown = run(added.document as AxcutDocument, "setZoom", {
			zoomId: id,
			hideCursor: false,
			focusMode: "manual",
		});
		expect(shown.document?.zoomRanges[0]).not.toHaveProperty("hideCursor");
		expect(shown.document?.zoomRanges[0]).toMatchObject({ focusMode: "manual", customScale: 1.6 });
		expect(snapshot(shown.document).zoomRanges[0]).not.toHaveProperty("hideCursor");
	});

	it("writes a level the depth table has as that depth, as the inspector does", () => {
		const added = run(fixtureDocument(), "addZoom", { startSec: 2, endSec: 4, customScale: 2.2 });
		expect(added.document?.zoomRanges[0]).toMatchObject({ depth: 4 });
		expect(added.document?.zoomRanges[0]).not.toHaveProperty("customScale");

		const custom = run(added.document as AxcutDocument, "setZoom", {
			zoomId: added.payload.zoomId,
			customScale: 1.333,
		});
		// To the hundredth, like a typed level.
		expect(custom.document?.zoomRanges[0]).toMatchObject({ depth: 4, customScale: 1.33 });
		const preset = run(custom.document as AxcutDocument, "setZoom", {
			zoomId: added.payload.zoomId,
			customScale: 1.5,
		});
		expect(preset.document?.zoomRanges[0]).toMatchObject({ depth: 2 });
		expect(preset.document?.zoomRanges[0]).not.toHaveProperty("customScale");
	});

	it("refuses a level past the clip's own limit, naming it, and depth with customScale", () => {
		const added = run(fixtureDocument(), "addZoom", { startSec: 2, endSec: 4 });
		const limit = zoomScaleLimit(added.document as AxcutDocument, added.payload.zoomId);
		// The fixture's 1080p take at the default padding blurs before the renderer's own 5×.
		expect(limit).toBeLessThan(5);
		const past = run(added.document as AxcutDocument, "setZoom", {
			zoomId: added.payload.zoomId,
			customScale: limit + 0.1,
		});
		expect(past.ok).toBe(false);
		expect(past.payload.error).toContain(`${limit}×`);
		expect(past.document).toBeUndefined();
		expect(
			run(fixtureDocument(), "addZoom", { startSec: 2, endSec: 4, customScale: limit + 0.1 }).ok,
		).toBe(false);
		expect(
			run(added.document as AxcutDocument, "setZoom", {
				zoomId: added.payload.zoomId,
				customScale: limit,
			}).ok,
		).toBe(true);
		const both = run(fixtureDocument(), "addZoom", {
			startSec: 2,
			endSec: 4,
			depth: 3,
			customScale: 2,
		});
		expect(both.ok).toBe(false);
	});

	it("takes customScale alone wherever the arguments were parsed first", () => {
		// The MCP server and the in-app agent hand the tool its arguments through the same schema,
		// and addZooms hands each region to addZoom parsed. A default depth filled in there read as
		// "depth and customScale both passed", so a free level could never be set in one call.
		const zoomOnly = { startSec: 2, endSec: 4, customScale: 1.6 };
		const parsed = run(fixtureDocument(), "addZoom", addZoomArgs.parse(zoomOnly));
		expect(parsed.ok).toBe(true);
		expect(parsed.document?.zoomRanges[0]).toMatchObject({ customScale: 1.6 });
		const batch = run(fixtureDocument(), "addZooms", { regions: [zoomOnly] });
		expect(batch.ok).toBe(true);
		expect(batch.document?.zoomRanges[0]).toMatchObject({ customScale: 1.6 });
		// Neither level given: the default depth still applies.
		const plain = run(fixtureDocument(), "addZoom", addZoomArgs.parse({ startSec: 2, endSec: 4 }));
		expect(plain.document?.zoomRanges[0]).toMatchObject({ depth: 3 });
		expect(plain.document?.zoomRanges[0]).not.toHaveProperty("customScale");
	});

	it("reads an annotation back in the terms its writes take", () => {
		const added = run(fixtureDocument(), "addAnnotation", {
			startSec: 1,
			endSec: 3,
			text: "Hi",
			x: 30,
			y: 70,
			fontSize: 48,
			background: "none",
			animation: "pop",
		});
		const [ann] = snapshot(added.document).annotations;
		expect(ann).toMatchObject({
			type: "text",
			text: "Hi",
			box: "frame",
			x: expect.closeTo(30, 1),
			y: expect.closeTo(70, 1),
			fontSize: 48,
			color: "#ffffff",
			background: "none",
			bold: true,
			animation: "pop",
		});
		expect(ann.width).toBeGreaterThan(0);
		expect(added.payload).toMatchObject({ type: "text", fontSize: 48 });
	});

	it("adds a privacy blur on the recording's picture, sized and placed as asked", () => {
		const added = run(fixtureDocument(), "addAnnotation", {
			startSec: 1,
			endSec: 3,
			type: "blur",
			x: 20,
			y: 10,
			width: 30,
			height: 6,
			blurData: { type: "blur", intensity: 20 },
		});
		expect(added.ok).toBe(true);
		const stored = added.document?.annotations[0];
		expect(stored).toMatchObject({
			type: "blur",
			content: "",
			position: { x: 5, y: 7 },
			size: { width: 30, height: 6 },
			blurData: { type: "blur", shape: "rectangle", intensity: 20 },
		});
		// A blur stays on what it hides: measured on the footage, never on the frame.
		expect(stored?.space).toBeUndefined();
		expect(() => documentSchema.parse(added.document)).not.toThrow();
		expect(snapshot(added.document).annotations[0]).toMatchObject({
			type: "blur",
			box: "footage",
			x: 20,
			y: 10,
			width: 30,
			height: 6,
			blurData: { type: "blur", shape: "rectangle", color: "white", intensity: 20, blockSize: 12 },
		});
		expect(snapshot(added.document).annotations[0]).not.toHaveProperty("text");

		// A patch of blurData changes what it names and keeps the rest.
		const oval = run(added.document as AxcutDocument, "setAnnotation", {
			annotationId: added.payload.annotationId,
			blurData: { shape: "oval" },
		});
		expect(oval.document?.annotations[0].blurData).toMatchObject({
			type: "blur",
			shape: "oval",
			intensity: 20,
		});
	});

	it("adds an arrow on the frame with its figureData", () => {
		const added = run(fixtureDocument(), "addAnnotation", {
			startSec: 1,
			endSec: 3,
			type: "figure",
			figureData: { arrowDirection: "down-left", color: "#ff0000" },
		});
		expect(added.ok).toBe(true);
		expect(added.document?.annotations[0]).toMatchObject({
			type: "figure",
			space: "frame",
			size: { width: 30, height: 20 },
			figureData: { arrowDirection: "down-left", color: "#ff0000", strokeWidth: 4 },
		});
		expect(() => documentSchema.parse(added.document)).not.toThrow();
		expect(snapshot(added.document).annotations[0]).toMatchObject({
			type: "figure",
			box: "frame",
			x: 50,
			y: 50,
			figureData: { arrowDirection: "down-left" },
		});
	});

	it("switches an annotation's type as the inspector does, keeping the text to come back to", () => {
		const added = run(fixtureDocument(), "addAnnotation", {
			startSec: 1,
			endSec: 3,
			text: "secret@example.com",
		});
		const id = added.payload.annotationId;
		const blurred = run(added.document as AxcutDocument, "setAnnotation", {
			annotationId: id,
			type: "blur",
		});
		expect(blurred.ok).toBe(true);
		const blur = blurred.document?.annotations[0];
		expect(blur).toMatchObject({ type: "blur", content: "", textContent: "secret@example.com" });
		expect(blur?.space).toBeUndefined();
		expect(() => documentSchema.parse(blurred.document)).not.toThrow();

		const back = run(blurred.document as AxcutDocument, "setAnnotation", {
			annotationId: id,
			type: "text",
		});
		expect(back.document?.annotations[0]).toMatchObject({
			type: "text",
			content: "secret@example.com",
			space: "frame",
		});
	});

	it("refuses arguments that mean nothing for the annotation's kind", () => {
		const text = run(fixtureDocument(), "addAnnotation", { startSec: 1, endSec: 3, text: "Hi" });
		const id = text.payload.annotationId;
		const doc = text.document as AxcutDocument;
		expect(run(doc, "setAnnotation", { annotationId: id, width: 40 }).ok).toBe(false);
		expect(run(doc, "setAnnotation", { annotationId: id, blurData: { type: "blur" } }).ok).toBe(
			false,
		);
		expect(
			run(doc, "setAnnotation", { annotationId: id, type: "blur", blurData: { type: "blur" } }).ok,
		).toBe(true);
		expect(
			run(fixtureDocument(), "addAnnotation", {
				startSec: 1,
				endSec: 3,
				type: "blur",
				blurData: { shape: "freehand" },
			}).ok,
		).toBe(false);
		expect(
			run(fixtureDocument(), "addAnnotation", { startSec: 1, endSec: 3, type: "image" }).ok,
		).toBe(false);
	});
});

describe("clip structure (#1180)", () => {
	/** Two recordings, one not probed yet, and a music file; one clip of the first, cut once. */
	function twoTakes(): AxcutDocument {
		const base = createEmptyDocument({
			title: "Takes",
			projectId: "proj_takes",
			createdAt: FIXTURE_CREATED_AT,
		});
		return documentSchema.parse({
			...base,
			project: { ...base.project, primaryAssetId: "asset_1" },
			assets: [
				{
					id: "asset_1",
					kind: "video",
					label: "Take 1",
					originalPath: "C:/v/1.mp4",
					durationSec: 20,
				},
				{
					id: "asset_2",
					kind: "video",
					label: "Take 2",
					originalPath: "C:/v/2.mp4",
					durationSec: 8,
				},
				{ id: "asset_3", kind: "video", label: "Unprobed", originalPath: "C:/v/3.mp4" },
				{
					id: "audio_1",
					kind: "audio",
					label: "Music",
					originalPath: "C:/v/m.mp3",
					durationSec: 30,
				},
			],
			timeline: {
				...base.timeline,
				clips: [
					{
						id: "clip_1",
						assetId: "asset_1",
						sourceStartSec: 0,
						sourceEndSec: 10,
						timelineStartSec: 0,
						timelineEndSec: 10,
						wordRefs: [],
						origin: "user",
						reason: "",
					},
				],
				trimRanges: [
					{
						id: "trim_1",
						assetId: "asset_1",
						clipId: "clip_1",
						startSec: 2,
						endSec: 3,
						reason: "",
						origin: "user",
					},
				],
			},
		});
	}

	const run = (document: AxcutDocument, name: string, args: unknown) =>
		executeAgentTool(document, name, JSON.stringify(args));

	it("insertClip places another asset's footage before the clip it names", () => {
		const result = run(twoTakes(), "insertClip", { assetId: "asset_2", beforeClipId: "clip_1" });
		expect(result.ok).toBe(true);
		const clips = (result.document as AxcutDocument).timeline.clips;
		const { clipId } = JSON.parse(result.resultJson);
		expect(clips.map((c) => c.id)).toEqual([clipId, "clip_1"]);
		expect(clips[0]).toMatchObject({ assetId: "asset_2", sourceStartSec: 0, sourceEndSec: 8 });
		// Back to back: the clip after it moved along the ruler.
		expect(clips[1]).toMatchObject({ timelineStartSec: 8, timelineEndSec: 18 });
	});

	it("insertClip folds footage that continues the clip before it into that clip", () => {
		const result = run(twoTakes(), "insertClip", {
			assetId: "asset_1",
			sourceStartSec: 10,
			sourceEndSec: 15,
		});
		expect(JSON.parse(result.resultJson)).toMatchObject({
			clipId: null,
			joinedIntoNeighbour: true,
		});
		expect((result.document as AxcutDocument).timeline.clips).toMatchObject([
			{ id: "clip_1", sourceStartSec: 0, sourceEndSec: 15 },
		]);
	});

	it("insertClip refuses what is not footage, and says what to use", () => {
		expect(run(twoTakes(), "insertClip", { assetId: "audio_1" }).resultJson).toContain("addAudio");
		const unknown = run(twoTakes(), "insertClip", { assetId: "nope" });
		expect(unknown.ok).toBe(false);
		expect(unknown.resultJson).toContain("asset_2 (Take 2)");
		const nowhere = run(twoTakes(), "insertClip", { assetId: "asset_2", beforeClipId: "clip_x" });
		expect(nowhere.ok).toBe(false);
	});

	it("insertClip asks for an end when the asset's length is unknown, and clamps to a known one", () => {
		const unprobed = run(twoTakes(), "insertClip", { assetId: "asset_3" });
		expect(unprobed.ok).toBe(false);
		expect(unprobed.resultJson).toContain("sourceEndSec");
		expect(run(twoTakes(), "insertClip", { assetId: "asset_3", sourceEndSec: 4 }).ok).toBe(true);
		const clamped = run(twoTakes(), "insertClip", { assetId: "asset_2", sourceEndSec: 99 });
		expect(JSON.parse(clamped.resultJson).sourceEndSec).toBe(8);
		expect(run(twoTakes(), "insertClip", { assetId: "asset_2", sourceStartSec: 9 }).ok).toBe(false);
	});

	it("duplicateClip puts the copy right after the original, with its own copy of the cuts", () => {
		const result = run(twoTakes(), "duplicateClip", { clipId: "clip_1" });
		const payload = JSON.parse(result.resultJson);
		const document = result.document as AxcutDocument;
		expect(document.timeline.clips.map((c) => c.id)).toEqual(["clip_1", payload.clipId]);
		expect(payload.copiedTrimIds).toHaveLength(1);
		expect(document.timeline.trimRanges.map((t) => t.clipId)).toEqual(["clip_1", payload.clipId]);
		expect(run(twoTakes(), "duplicateClip", { clipId: "clip_x" }).ok).toBe(false);
	});

	it("duplicateClip names the copy even when the clips before it fold together", () => {
		// clip_1 and clip_2 already meet, so the pass after the copy makes them one clip and
		// the copy is no longer at the original's index + 1.
		const result = run(fixtureDocument(), "duplicateClip", { clipId: "clip_2" });
		const { clipId } = JSON.parse(result.resultJson);
		expect(result.ok).toBe(true);
		expect((result.document as AxcutDocument).timeline.clips.map((c) => c.id)).toEqual([
			"clip_1",
			clipId,
		]);
	});

	it("setClipRange crops a clip without touching its range, and the snapshot reads it back", () => {
		const crop = { x: 0.1, y: 0.2, width: 0.5, height: 0.6 };
		const result = run(twoTakes(), "setClipRange", { clipId: "clip_1", cropRegion: crop });
		const document = result.document as AxcutDocument;
		expect(document.timeline.clips[0]).toMatchObject({
			sourceStartSec: 0,
			sourceEndSec: 10,
			cropRegion: crop,
		});
		const snapshot = JSON.parse(run(document, "getCurrentDocument", {}).resultJson);
		expect(snapshot.clips[0].cropRegion).toEqual(crop);
		// Absent, not null, on a clip that shows the whole frame.
		const plain = JSON.parse(run(twoTakes(), "getCurrentDocument", {}).resultJson);
		expect(plain.clips[0]).not.toHaveProperty("cropRegion");
	});

	it("setClipRange clears a crop with null or with the whole frame", () => {
		const cropped = run(twoTakes(), "setClipRange", {
			clipId: "clip_1",
			cropRegion: { x: 0, y: 0, width: 0.5, height: 0.5 },
		}).document as AxcutDocument;
		for (const cropRegion of [null, { x: 0, y: 0, width: 1, height: 1 }]) {
			const cleared = run(cropped, "setClipRange", { clipId: "clip_1", cropRegion });
			expect((cleared.document as AxcutDocument).timeline.clips[0].cropRegion).toBeUndefined();
		}
	});

	it("setClipRange refuses a crop outside the frame, and a call that changes nothing", () => {
		const outside = run(twoTakes(), "setClipRange", {
			clipId: "clip_1",
			cropRegion: { x: 0.6, y: 0, width: 0.6, height: 1 },
		});
		expect(outside.ok).toBe(false);
		expect(outside.resultJson).toContain("inside the frame");
		expect(run(twoTakes(), "setClipRange", { clipId: "clip_1" }).ok).toBe(false);
	});

	it("setClipRange weighs a new range and a new crop together", () => {
		// clip_2 is moved to meet clip_1 in the media AND given its own crop in one call: the
		// crop keeps them apart, so neither edit is lost to a fold.
		const placed = run(twoTakes(), "insertClip", {
			assetId: "asset_1",
			sourceStartSec: 12,
			sourceEndSec: 16,
		});
		const { clipId } = JSON.parse(placed.resultJson);
		const crop = { x: 0, y: 0, width: 0.5, height: 0.5 };
		const result = run(placed.document as AxcutDocument, "setClipRange", {
			clipId,
			sourceStartSec: 10,
			sourceEndSec: 16,
			cropRegion: crop,
		});
		expect((result.document as AxcutDocument).timeline.clips).toMatchObject([
			{ id: "clip_1", sourceEndSec: 10 },
			{ id: clipId, sourceStartSec: 10, sourceEndSec: 16, cropRegion: crop },
		]);
	});

	it("setClipRange moves one edge and keeps the other", () => {
		const result = run(twoTakes(), "setClipRange", { clipId: "clip_1", sourceEndSec: 6 });
		expect((result.document as AxcutDocument).timeline.clips[0]).toMatchObject({
			sourceStartSec: 0,
			sourceEndSec: 6,
		});
	});

	describe("addAutoZooms", () => {
		const suggestion = {
			span: { start: 3500, end: 5500 },
			focus: { cx: 0.4, cy: 0.6 },
			depth: 3 as const,
		};
		const withPlan = (autoZooms: AgentToolOptions["autoZooms"]) =>
			executeAgentTool(twoTakes(), "addAutoZooms", "{}", { autoZooms });

		it("adds the planned zooms, as the wand does", () => {
			const result = withPlan({ suggestions: [suggestion], telemetry: { asset_1: "ok" } });
			expect(result.ok).toBe(true);
			expect(JSON.parse(result.resultJson)).toMatchObject({
				added: 1,
				zooms: [{ startSec: 3.5, endSec: 5.5, focus: { cx: 0.4, cy: 0.6 } }],
				telemetry: { asset_1: "ok" },
			});
			expect((result.document as AxcutDocument).zoomRanges).toMatchObject([
				{ focusMode: "auto", depth: 3, clipId: "clip_1" },
			]);
		});

		it("answers added 0 without writing when no click calls for a zoom", () => {
			const result = withPlan({ suggestions: [], telemetry: { asset_1: "no-sidecar" } });
			expect(result.ok).toBe(true);
			expect(result.document).toBeUndefined();
			expect(JSON.parse(result.resultJson)).toMatchObject({
				added: 0,
				telemetry: { asset_1: "no-sidecar" },
			});
		});

		it("refuses, as a limit of its own, when the clicks could not be read", () => {
			for (const plan of [
				undefined,
				{ suggestions: [], telemetry: { asset_1: "unavailable" as const } },
			]) {
				const result = withPlan(plan);
				expect(result.ok).toBe(false);
				expect(result.resultJson).toContain("could not be read");
			}
		});
	});
});

describe("shader effects", () => {
	const CODE = "fn effect(uv: vec2<f32>) -> vec4<f32> { return frame(uv) * params.level; }";
	const params = [
		{ type: "number", name: "level", label: "Level", default: 1, min: 0, max: 2 },
		{ type: "color", name: "tint", label: "Tint", default: "#000000" },
	];
	// Stands in for the compositor's check: refuses `nope`, prices every effect at 4 reads.
	const checkShaderEffect = (code: string) =>
		code.includes("nope")
			? { error: "error: no definition in scope for identifier: `nope`" }
			: { tier: "light" as const, frameReads: 4, iterations: 0 };
	const options = { checkShaderEffect };
	const run = (document: AxcutDocument, name: string, args: unknown) =>
		executeAgentTool(document, name, JSON.stringify(args), options);
	const add = (document: AxcutDocument, args: Record<string, unknown> = {}) =>
		run(document, "addEffect", {
			startSec: 2,
			endSec: 6,
			effect: { name: "Dim", description: "Dims the picture.", code: CODE, params },
			...args,
		});

	it("writes the effect and poses it, anchored, with only the values that differ", () => {
		const added = add(fixtureDocument(), { values: { level: 0.5, tint: "#000000" } });
		expect(added.ok).toBe(true);
		const doc = added.document as AxcutDocument;
		const [effect] = doc.shaderEffects ?? [];
		const [range] = doc.shaderEffectRanges ?? [];
		expect(effect).toMatchObject({
			name: "Dim",
			contract: 1,
			origin: "agent",
			cost: { tier: "light", frameReads: 4 },
		});
		expect(range).toMatchObject({
			effectId: effect.id,
			startMs: 2000,
			endMs: 6000,
			clipId: "clip_1",
			values: { level: 0.5 },
			target: "image",
		});
		expect(JSON.parse(added.resultJson)).toMatchObject({
			effectRegionId: range.id,
			effectId: effect.id,
			validated: true,
			cost: { tier: "light", frameReads: 4 },
		});
		expect(() => documentSchema.parse(doc)).not.toThrow();
	});

	it("refuses code that does not compile, with the compiler's error, and changes nothing", () => {
		const refused = add(fixtureDocument(), {
			effect: {
				name: "Broken",
				description: "",
				code: "fn effect(uv: vec2<f32>) -> vec4<f32> { return nope; }",
			},
		});
		expect(refused.ok).toBe(false);
		expect(refused.document).toBeUndefined();
		expect(JSON.parse(refused.resultJson).error).toMatch(/does not compile[\s\S]*nope/);
	});

	it("takes either a new effect or one of the project's, not both or neither", () => {
		const doc = add(fixtureDocument()).document as AxcutDocument;
		const effectId = doc.shaderEffects?.[0].id;
		expect(run(doc, "addEffect", { startSec: 8, endSec: 9 }).ok).toBe(false);
		const reused = run(doc, "addEffect", { startSec: 8, endSec: 9, effectId });
		expect(reused.ok).toBe(true);
		expect(reused.document?.shaderEffects).toHaveLength(1);
		expect(reused.document?.shaderEffectRanges).toHaveLength(2);
	});

	it("runs one effect at a time, and says to combine looks in one shader", () => {
		const doc = add(fixtureDocument()).document as AxcutDocument;
		const blocked = add(doc, { startSec: 4, endSec: 8, target: "text" });
		expect(blocked.ok).toBe(false);
		expect(JSON.parse(blocked.resultJson).error).toMatch(
			/one effect runs at a time[\s\S]*one shader/,
		);
		expect(add(doc, { startSec: 6, endSec: 8 }).ok).toBe(true);
	});

	it("recommends a lighter tier when a heavy effect runs long, and never refuses it", () => {
		const heavy = {
			...options,
			checkShaderEffect: () => ({ tier: "heavy" as const, frameReads: 100 }),
		};
		const added = executeAgentTool(
			fixtureDocument(),
			"addEffect",
			JSON.stringify({
				startSec: 0,
				endSec: 40,
				effect: { name: "Blur", description: "", code: CODE, params },
			}),
			heavy,
		);
		expect(added.ok).toBe(true);
		expect(JSON.parse(added.resultJson).cost.advice).toMatch(/heavy over 40\.0 s/);
	});

	it("re-tunes, retargets and moves a region; a value back at its default is dropped", () => {
		const doc = add(fixtureDocument(), { values: { level: 0.5 } }).document as AxcutDocument;
		const regionId = doc.shaderEffectRanges?.[0].id;
		const tuned = run(doc, "setEffect", {
			effectRegionId: regionId,
			values: { level: 1, tint: "#ff0000" },
			target: "both",
			startSec: 10,
			endSec: 12,
		});
		expect(tuned.ok).toBe(true);
		expect(tuned.document?.shaderEffectRanges?.[0]).toMatchObject({
			startMs: 10000,
			endMs: 12000,
			target: "both",
			values: { tint: "#ff0000" },
		});
	});

	it("moves only its own pill when a re-tune makes it match the neighbour it touches", () => {
		const first = add(fixtureDocument(), { values: { level: 0.5 } }).document as AxcutDocument;
		const effectId = first.shaderEffects?.[0].id;
		const doc = run(first, "addEffect", { startSec: 6, endSec: 8, effectId })
			.document as AxcutDocument;
		const regionId = doc.shaderEffectRanges?.find((r) => r.startMs === 2000)?.id;
		const moved = run(doc, "setEffect", {
			effectRegionId: regionId,
			values: { level: 1 },
			endSec: 5,
		});
		expect(moved.ok).toBe(true);
		expect(
			[...(moved.document?.shaderEffectRanges ?? [])]
				.sort((a, b) => a.startMs - b.startMs)
				.map((r) => [r.startMs, r.endMs, r.values]),
		).toEqual([
			[2000, 5000, {}],
			[6000, 8000, {}],
		]);
	});

	it("refuses to move an effect onto another one", () => {
		const first = add(fixtureDocument()).document as AxcutDocument;
		const doc = add(first, { startSec: 8, endSec: 9 }).document as AxcutDocument;
		const second = doc.shaderEffectRanges?.find((r) => r.startMs === 8000);
		const moved = run(doc, "setEffect", { effectRegionId: second?.id, startSec: 4 });
		expect(moved.ok).toBe(false);
		expect(JSON.parse(moved.resultJson).error).toMatch(/one effect runs at a time/);
	});

	it("changes the definition for every region, recompiles, and drops a removed parameter's values", () => {
		const doc = add(fixtureDocument(), { values: { tint: "#ff0000" } }).document as AxcutDocument;
		const effectId = doc.shaderEffects?.[0].id;
		const refused = run(doc, "setEffectDefinition", {
			effectId,
			code: "fn effect(uv: vec2<f32>) -> vec4<f32> { return nope; }",
		});
		expect(refused.ok).toBe(false);
		const changed = run(doc, "setEffectDefinition", { effectId, params: [params[0]] });
		expect(changed.ok).toBe(true);
		expect(changed.document?.shaderEffectRanges?.[0].values).toEqual({});
		expect(JSON.parse(changed.resultJson)).toMatchObject({ regions: 1, validated: true });
	});

	it("reads an effect's code by getEffect, and lists effects without it in the snapshot", () => {
		const doc = add(fixtureDocument()).document as AxcutDocument;
		const effectId = doc.shaderEffects?.[0].id;
		const read = JSON.parse(run(doc, "getEffect", { effectId }).resultJson);
		expect(read).toMatchObject({
			code: CODE,
			regions: [{ startSec: 2, endSec: 6, target: "image" }],
		});
		const snapshot = JSON.parse(run(doc, "getCurrentDocument", {}).resultJson);
		expect(snapshot.effects).toEqual([
			expect.objectContaining({ effectId, name: "Dim", startSec: 2, endSec: 6 }),
		]);
		expect(snapshot.effectDefinitions[0]).toMatchObject({ effectId, lines: 1, regions: 1 });
		expect(snapshot.effectDefinitions[0].code).toBeUndefined();
		expect(snapshot.timeBaseNote).toMatch(/effects/);
	});

	it("removes a region by removeModifier, and its definition with the last one", () => {
		const doc = add(fixtureDocument()).document as AxcutDocument;
		const removed = run(doc, "removeModifier", { id: doc.shaderEffectRanges?.[0].id });
		expect(removed.ok).toBe(true);
		expect(JSON.parse(removed.resultJson).kind).toBe("shaderEffect");
		expect(removed.document?.shaderEffectRanges).toEqual([]);
		expect(removed.document?.shaderEffects).toEqual([]);
	});

	it("says when nothing could check the code", () => {
		const added = executeAgentTool(
			fixtureDocument(),
			"addEffect",
			JSON.stringify({
				startSec: 1,
				endSec: 2,
				effect: { name: "Dim", description: "", code: CODE, params },
			}),
		);
		expect(JSON.parse(added.resultJson)).toMatchObject({ validated: false, cost: null });
	});
});

describe("the executor's view of a check asked beforehand", () => {
	const source = {
		code: "fn effect(uv: vec2<f32>) -> vec4<f32> { return frame(uv); }",
		params: [{ name: "level", type: "number" as const }],
	};
	const check = { tier: "light" as const, frameReads: 1, iterations: 0 };

	it("is the answer for the same code and layout, and nothing for any other", () => {
		const lookup = shaderEffectCheckLookup(source, check);
		expect(lookup(source.code, [{ name: "level", type: "number" }])).toBe(check);
		expect(lookup(`${source.code}\n`, source.params)).toBeNull();
		expect(lookup(source.code, [{ name: "level", type: "color" }])).toBeNull();
		expect(lookup(source.code, [])).toBeNull();
	});

	it("is asked only by the two tools that compile", () => {
		const document = fixtureDocument();
		expect(
			shaderEffectToCheck(document, "addEffect", { startSec: 0, endSec: 1, effectId: "fx_1" }),
		).toBeNull();
		expect(shaderEffectToCheck(document, "addTrim", { startSec: 0, endSec: 1 })).toBeNull();
		expect(
			shaderEffectToCheck(document, "addEffect", {
				startSec: 0,
				endSec: 1,
				effect: { name: "A", description: "", code: source.code },
			}),
		).toEqual({ code: source.code, params: [] });
		expect(
			shaderEffectToCheck(document, "setEffectDefinition", { effectId: "fx_missing", code: "x" }),
		).toBeNull();
	});
});
