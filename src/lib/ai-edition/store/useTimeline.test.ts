import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AxcutCursorMotionRegion, documentSchema } from "../schema";
import { useProjectStore } from "./projectStore";
import { useTimeline } from "./useTimeline";

const probeVideoDurationMock = vi.hoisted(() => vi.fn());

vi.mock("../timeline/duration", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../timeline/duration")>();
	return { ...actual, probeVideoDuration: probeVideoDurationMock };
});

const bridgeMocks = vi.hoisted(() => ({
	get: vi.fn(),
	create: vi.fn(),
	save: vi.fn(),
	addAsset: vi.fn(),
	removeAsset: vi.fn(),
	listProjects: vi.fn(),
}));

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		aiEdition: {
			get: bridgeMocks.get,
			create: bridgeMocks.create,
			save: bridgeMocks.save,
			addAsset: bridgeMocks.addAsset,
			removeAsset: bridgeMocks.removeAsset,
			listProjects: bridgeMocks.listProjects,
		},
	},
}));

const sampleDoc = {
	schemaVersion: 3,
	project: {
		id: "proj_test",
		title: "Test",
		createdAt: "2026-06-25T10:00:00.000Z",
		updatedAt: "2026-06-25T10:00:00.000Z",
		primaryAssetId: "asset_1",
	},
	assets: [
		{
			id: "asset_1",
			kind: "video",
			label: "screen.webm",
			originalPath: "/tmp/screen.webm",
			durationSec: 30,
		},
	],
	transcript: null,
	transcripts: [],
	timeline: {
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
		],
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
};

function motionRegion(overrides: Partial<AxcutCursorMotionRegion> = {}): AxcutCursorMotionRegion {
	return {
		id: "motion_1",
		clipId: "clip_a",
		assetId: "asset_1",
		startMs: 1000,
		endMs: 2000,
		sourceStartMs: 1000,
		sourceEndMs: 2000,
		startPoint: { cx: 0.2, cy: 0.4 },
		endPoint: { cx: 0.8, cy: 0.6 },
		controlPoints: [{ cx: 0.5, cy: 0.2 }],
		startAnchor: "rest",
		endAnchor: "click",
		segmentKind: "move",
		preset: "recorded",
		speed: 1,
		cycles: 1,
		easing: "ease-in-out",
		...overrides,
	};
}

describe("useTimeline.editClip", () => {
	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("updates the target clip in place and persists via the store", async () => {
		const { result } = renderHook(() => useTimeline());
		await act(async () => {
			await result.current.editClip("clip_a", {
				sourceStartSec: 1,
				sourceEndSec: 8,
				timelineStartSec: 2,
				timelineEndSec: 9,
			});
		});
		const doc = useProjectStore.getState().document;
		const updated = doc?.timeline.clips[0];
		expect(updated).toMatchObject({
			id: "clip_a",
			sourceStartSec: 1,
			sourceEndSec: 8,
			timelineStartSec: 2,
			timelineEndSec: 9,
		});
		expect(bridgeMocks.save).toHaveBeenCalledTimes(1);
	});

	it("clamps end >= start when the user types them out of order", async () => {
		const { result } = renderHook(() => useTimeline());
		await act(async () => {
			await result.current.editClip("clip_a", {
				sourceStartSec: 7,
				sourceEndSec: 2,
			});
		});
		const updated = useProjectStore.getState().document?.timeline.clips[0];
		expect(updated?.sourceStartSec).toBe(2);
		expect(updated?.sourceEndSec).toBe(7);
	});

	it("no-ops when the clip id is unknown", async () => {
		const { result } = renderHook(() => useTimeline());
		await act(async () => {
			await result.current.editClip("clip_missing", { sourceStartSec: 1 });
		});
		expect(bridgeMocks.save).not.toHaveBeenCalled();
	});
});

describe("useTimeline.insertClipAt background duration probe", () => {
	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		probeVideoDurationMock.mockReset();
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
		useProjectStore.setState({
			projectId: "proj_test",
			document: {
				...sampleDoc,
				assets: [
					...sampleDoc.assets,
					{
						id: "asset_2",
						kind: "video",
						label: "long.webm",
						originalPath: "/tmp/long.webm",
						durationSec: undefined,
					},
				],
			},
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("only resizes the probed clip and leaves earlier clips' positions untouched", async () => {
		// clip_a already sits at 0..10 (a "short clip"). Insert a second clip
		// for asset_2 after it — insertClipAt has no cached duration for
		// asset_2, so it lands at the 60s placeholder, then the background
		// probe (mocked here to resolve to a much shorter real duration)
		// corrects it. Regression test for the bug where the probe used to
		// shift EVERY sibling clip (including ones before it) by the delta
		// between the real and placeholder duration, corrupting their
		// positions and producing visual overlap.
		probeVideoDurationMock.mockResolvedValue(5);
		const { result } = renderHook(() => useTimeline());

		await act(async () => {
			await result.current.insertClipAt("asset_2", 1);
		});

		const clips = useProjectStore.getState().document?.timeline.clips;
		expect(clips).toHaveLength(2);
		const clipA = clips?.find((c) => c.id === "clip_a");
		const inserted = clips?.find((c) => c.assetId === "asset_2");
		expect(clipA).toMatchObject({ timelineStartSec: 0, timelineEndSec: 10 });
		expect(inserted).toMatchObject({
			sourceEndSec: 5,
			timelineStartSec: 10,
			timelineEndSec: 15,
		});
	});
});

describe("useTimeline.moveClip / duplicateClip (delegates to document/timeline.ts)", () => {
	const twoClipDoc = {
		...sampleDoc,
		timeline: {
			...sampleDoc.timeline,
			clips: [
				sampleDoc.timeline.clips[0],
				{
					id: "clip_b",
					assetId: "asset_1",
					sourceStartSec: 10,
					sourceEndSec: 20,
					timelineStartSec: 10,
					timelineEndSec: 20,
					wordRefs: [],
					origin: "user" as const,
					reason: "",
				},
			],
		},
	};

	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
		useProjectStore.setState({
			projectId: "proj_test",
			document: twoClipDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("moveClip reorders clips and persists the resequenced timeline", async () => {
		const { result } = renderHook(() => useTimeline());
		await act(async () => {
			await result.current.moveClip("clip_a", 1);
		});
		const clips = useProjectStore.getState().document?.timeline.clips;
		expect(clips?.map((c) => c.id)).toEqual(["clip_b", "clip_a"]);
		expect(clips?.[0]).toMatchObject({ timelineStartSec: 0, timelineEndSec: 10 });
		expect(clips?.[1]).toMatchObject({ timelineStartSec: 10, timelineEndSec: 20 });
	});

	it("moveClip no-ops for an unknown clip id", async () => {
		const { result } = renderHook(() => useTimeline());
		await act(async () => {
			await result.current.moveClip("clip_missing", 0);
		});
		expect(bridgeMocks.save).not.toHaveBeenCalled();
	});

	it("duplicateClip inserts a copy right after the original and selects it", async () => {
		const { result } = renderHook(() => useTimeline());
		await act(async () => {
			await result.current.duplicateClip("clip_a");
		});
		const clips = useProjectStore.getState().document?.timeline.clips;
		expect(clips).toHaveLength(3);
		expect(clips?.[0].id).toBe("clip_a");
		expect(clips?.[2].id).toBe("clip_b");
		const copyId = clips?.[1].id;
		expect(copyId).toBeTruthy();
		expect(copyId).not.toBe("clip_a");
		expect(result.current.clipSelection).toBe(copyId);
	});

	it("duplicateClip no-ops for an unknown clip id", async () => {
		const { result } = renderHook(() => useTimeline());
		await act(async () => {
			await result.current.duplicateClip("clip_missing");
		});
		expect(bridgeMocks.save).not.toHaveBeenCalled();
	});
});

describe("useTimeline cursor motion", () => {
	const cursorRegion: AxcutCursorMotionRegion = {
		id: "motion_1",
		clipId: "clip_a",
		assetId: "asset_1",
		startMs: 1000,
		endMs: 2000,
		sourceStartMs: 1000,
		sourceEndMs: 2000,
		startPoint: { cx: 0.2, cy: 0.4 },
		endPoint: { cx: 0.8, cy: 0.6 },
		controlPoints: [{ cx: 0.5, cy: 0.2 }],
		startAnchor: "rest",
		endAnchor: "click",
		segmentKind: "move",
		preset: "recorded",
		speed: 1,
		cycles: 1,
		easing: "ease-in-out",
	};

	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		bridgeMocks.save.mockImplementation(async (document: unknown) => ({
			success: true,
			document,
		}));
		useProjectStore.setState({
			projectId: "proj_test",
			document: documentSchema.parse({ ...sampleDoc, schemaVersion: 4 }),
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("adds split regions with one save and selects the first segment", async () => {
		const second = {
			...cursorRegion,
			id: "motion_2",
			startMs: 2000,
			endMs: 3000,
			sourceStartMs: 2000,
			sourceEndMs: 3000,
			startPoint: cursorRegion.endPoint,
		};
		const { result } = renderHook(() => useTimeline());

		await act(async () => {
			expect(await result.current.addCursorMotionRegions([cursorRegion, second])).toBe(2);
		});

		expect(bridgeMocks.save).toHaveBeenCalledTimes(1);
		expect(useProjectStore.getState().document?.cursorMotionRegions).toHaveLength(2);
		expect(result.current.selection).toEqual({ kind: "cursorMotion", id: "motion_1" });
	});

	it("rejects a region that does not belong to the target clip and asset", async () => {
		const { result } = renderHook(() => useTimeline());

		await act(async () => {
			expect(
				await result.current.addCursorMotionRegions([
					{ ...cursorRegion, clipId: "clip_other", assetId: "asset_other" },
				]),
			).toBe(0);
		});

		expect(bridgeMocks.save).not.toHaveBeenCalled();
	});

	it("updates control points live and persists only once on commit", async () => {
		useProjectStore.setState((state) => ({
			document: { ...state.document!, cursorMotionRegions: [cursorRegion] },
		}));
		const { result } = renderHook(() => useTimeline());

		act(() => {
			result.current.updateCursorMotionControlPointLive("motion_1", 0, { cx: 0.55, cy: 0.25 });
			result.current.updateCursorMotionControlPointLive("motion_1", 0, { cx: 0.6, cy: 0.3 });
		});

		expect(bridgeMocks.save).not.toHaveBeenCalled();
		expect(useProjectStore.getState().document?.cursorMotionRegions[0].controlPoints[0]).toEqual({
			cx: 0.6,
			cy: 0.3,
		});
		expect(useProjectStore.getState().revision).toBe(2);

		await act(async () => {
			await result.current.commitCursorMotionChange();
		});

		expect(bridgeMocks.save).toHaveBeenCalledTimes(1);
		expect(useProjectStore.getState().revision).toBe(3);
	});

	it("clamps speed and cycles before saving settings", async () => {
		useProjectStore.setState((state) => ({
			document: { ...state.document!, cursorMotionRegions: [cursorRegion] },
		}));
		const { result } = renderHook(() => useTimeline());

		await act(async () => {
			await result.current.updateCursorMotionSettings("motion_1", { speed: 9, cycles: 0 });
		});

		expect(useProjectStore.getState().document?.cursorMotionRegions[0]).toMatchObject({
			speed: 4,
			cycles: 1,
		});
	});
});

describe("useTimeline cursor motion clip lifecycle", () => {
	const asset2 = {
		id: "asset_2",
		kind: "video" as const,
		label: "camera.webm",
		originalPath: "/tmp/camera.webm",
		durationSec: 5,
	};
	const clipB = {
		id: "clip_b",
		assetId: "asset_2",
		sourceStartSec: 0,
		sourceEndSec: 5,
		timelineStartSec: 10,
		timelineEndSec: 15,
		wordRefs: [] as string[],
		origin: "user" as const,
		reason: "",
	};

	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		probeVideoDurationMock.mockReset();
		bridgeMocks.save.mockImplementation(async (document: unknown) => ({
			success: true,
			document,
		}));
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("reprojects an existing region after insertion and drops an asset mismatch", async () => {
		const valid = motionRegion();
		const mismatch = motionRegion({ id: "motion_mismatch", assetId: "asset_2" });
		useProjectStore.setState({
			projectId: "proj_test",
			document: documentSchema.parse({
				...sampleDoc,
				schemaVersion: 4,
				assets: [...sampleDoc.assets, asset2],
				cursorMotionRegions: [valid, mismatch],
			}),
			revision: 1,
			status: "ready",
			error: null,
		});
		const { result } = renderHook(() => useTimeline());

		await act(async () => {
			await result.current.insertClipAt("asset_2", 0);
		});

		expect(useProjectStore.getState().document?.cursorMotionRegions).toEqual([
			{ ...valid, startMs: 6000, endMs: 7000 },
		]);
	});

	it("drops a removed clip's region and reprojects the surviving asset", async () => {
		const removed = motionRegion();
		const surviving = motionRegion({
			id: "motion_b",
			clipId: "clip_b",
			assetId: "asset_2",
			startMs: 11000,
			endMs: 12000,
		});
		useProjectStore.setState({
			projectId: "proj_test",
			document: documentSchema.parse({
				...sampleDoc,
				schemaVersion: 4,
				assets: [...sampleDoc.assets, asset2],
				timeline: { ...sampleDoc.timeline, clips: [sampleDoc.timeline.clips[0], clipB] },
				cursorMotionRegions: [removed, surviving],
			}),
			revision: 1,
			status: "ready",
			error: null,
		});
		const { result } = renderHook(() => useTimeline());

		await act(async () => {
			await result.current.removeClip("clip_a");
		});

		expect(useProjectStore.getState().document?.cursorMotionRegions).toEqual([
			{ ...surviving, startMs: 1000, endMs: 2000 },
		]);
	});

	it("keeps contained source motion after a trim and drops truncated motion", async () => {
		const inside = motionRegion({
			id: "motion_inside",
			startMs: 3000,
			endMs: 4000,
			sourceStartMs: 3000,
			sourceEndMs: 4000,
		});
		const truncated = motionRegion({
			id: "motion_truncated",
			startMs: 500,
			endMs: 1500,
			sourceStartMs: 500,
			sourceEndMs: 1500,
		});
		useProjectStore.setState({
			projectId: "proj_test",
			document: documentSchema.parse({
				...sampleDoc,
				schemaVersion: 4,
				cursorMotionRegions: [inside, truncated],
			}),
			revision: 1,
			status: "ready",
			error: null,
		});
		const { result } = renderHook(() => useTimeline());

		await act(async () => {
			await result.current.updateClipSourceRange("clip_a", 2, 8);
		});

		const document = useProjectStore.getState().document;
		expect(document?.timeline.clips[0]).toMatchObject({
			sourceStartSec: 2,
			sourceEndSec: 8,
			timelineStartSec: 0,
			timelineEndSec: 6,
		});
		expect(document?.cursorMotionRegions).toEqual([{ ...inside, startMs: 1000, endMs: 2000 }]);
	});

	it("drops placeholder motion that exceeds the probed source duration", async () => {
		let resolveProbe: (duration: number | null) => void = () => undefined;
		probeVideoDurationMock.mockImplementation(
			() => new Promise<number | null>((resolve) => (resolveProbe = resolve)),
		);
		const uncachedAsset = { ...asset2, durationSec: undefined };
		useProjectStore.setState({
			projectId: "proj_test",
			document: documentSchema.parse({
				...sampleDoc,
				schemaVersion: 4,
				assets: [...sampleDoc.assets, uncachedAsset],
			}),
			revision: 1,
			status: "ready",
			error: null,
		});
		const { result } = renderHook(() => useTimeline());

		await act(async () => {
			await result.current.insertClipAt("asset_2", 1);
		});
		const inserted = useProjectStore
			.getState()
			.document?.timeline.clips.find((clip) => clip.assetId === "asset_2");
		expect(inserted).toBeDefined();
		useProjectStore.setState((state) => ({
			document: {
				...state.document!,
				cursorMotionRegions: [
					motionRegion({
						id: "motion_placeholder",
						clipId: inserted!.id,
						assetId: "asset_2",
						startMs: 20000,
						endMs: 30000,
						sourceStartMs: 10000,
						sourceEndMs: 20000,
					}),
				],
			},
		}));

		await act(async () => {
			resolveProbe(5);
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(useProjectStore.getState().document?.cursorMotionRegions).toEqual([]);
		expect(useProjectStore.getState().document?.timeline.clips[1]).toMatchObject({
			sourceEndSec: 5,
			timelineStartSec: 10,
			timelineEndSec: 15,
		});
	});
});

describe("useTimeline automatic zoom compatibility", () => {
	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		bridgeMocks.save.mockImplementation(async (document: unknown) => ({
			success: true,
			document,
		}));
		useProjectStore.setState({
			projectId: "proj_test",
			document: documentSchema.parse({ ...sampleDoc, schemaVersion: 4 }),
			revision: 1,
			status: "ready",
			error: null,
			currentTimeSec: 1,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("makes new zooms manual unless global Auto-Focus is enabled", async () => {
		const { result, rerender } = renderHook(() => useTimeline());
		await act(async () => result.current.addZoom());
		expect(useProjectStore.getState().document?.zoomRanges[0]).toMatchObject({
			focusMode: "manual",
			source: "manual",
		});

		await act(async () => result.current.setAutoFocusAll(true));
		rerender();
		await act(async () => result.current.addZoom());
		expect(useProjectStore.getState().document?.zoomRanges.at(-1)).toMatchObject({
			focusMode: "auto",
			source: "manual",
		});
	});

	it("updates one focus mode and the global toggle with one save each", async () => {
		useProjectStore.setState((state) => ({
			document: {
				...state.document!,
				zoomRanges: [
					{
						id: "zoom_auto",
						startMs: 1000,
						endMs: 2000,
						depth: 3,
						focus: { cx: 0.4, cy: 0.6 },
						focusMode: "manual",
						source: "auto",
					},
				],
			},
		}));
		const { result, rerender } = renderHook(() => useTimeline());

		await act(async () => result.current.updateZoomFocusMode("zoom_auto", "auto"));
		expect(bridgeMocks.save).toHaveBeenCalledTimes(1);
		expect(useProjectStore.getState().document?.zoomRanges[0]).toMatchObject({
			focusMode: "auto",
			source: "manual",
		});

		rerender();
		await act(async () => result.current.setAutoFocusAll(false));
		expect(bridgeMocks.save).toHaveBeenCalledTimes(2);
		expect(useProjectStore.getState().document?.zoomRanges[0].focusMode).toBe("manual");
		expect(
			(useProjectStore.getState().document?.legacyEditor as { autoFocusAll?: boolean })
				.autoFocusAll,
		).toBe(false);
	});

	it("marks a pending asset processed atomically and never duplicates suggestions", async () => {
		useProjectStore.setState((state) => ({
			document: {
				...state.document!,
				assets: state.document!.assets.map((asset) => ({
					...asset,
					autoZoomState: "pending" as const,
				})),
			},
		}));
		const { result, rerender } = renderHook(() => useTimeline());
		const suggestions = [
			{ span: { start: 1000, end: 2000 }, focus: { cx: 0.2, cy: 0.3 } },
			{ span: { start: 1500, end: 2500 }, focus: { cx: 0.8, cy: 0.7 } },
		];

		await act(async () => {
			expect(await result.current.completePendingAutoZoom("asset_1", suggestions)).toBe(1);
		});
		expect(useProjectStore.getState().document?.assets[0].autoZoomState).toBe("processed");
		expect(useProjectStore.getState().document?.zoomRanges).toHaveLength(1);
		expect(bridgeMocks.save).toHaveBeenCalledTimes(1);

		rerender();
		await act(async () => {
			expect(await result.current.completePendingAutoZoom("asset_1", suggestions)).toBe(0);
		});
		expect(bridgeMocks.save).toHaveBeenCalledTimes(1);
	});

	it("disabling automatic zoom removes only untouched generated regions", async () => {
		useProjectStore.setState((state) => ({
			document: {
				...state.document!,
				zoomRanges: [
					{
						id: "generated",
						startMs: 1000,
						endMs: 2000,
						depth: 3,
						focus: { cx: 0.2, cy: 0.3 },
						source: "auto",
					},
					{
						id: "edited",
						startMs: 3000,
						endMs: 4000,
						depth: 3,
						focus: { cx: 0.7, cy: 0.6 },
						source: "manual",
					},
				],
			},
		}));
		const { result } = renderHook(() => useTimeline());

		await act(async () => result.current.setAutoZoomEnabled(false));
		expect(useProjectStore.getState().document?.zoomRanges.map((region) => region.id)).toEqual([
			"edited",
		]);
		expect(
			(useProjectStore.getState().document?.legacyEditor as { autoZoomEnabled?: boolean })
				.autoZoomEnabled,
		).toBe(false);
	});
});
