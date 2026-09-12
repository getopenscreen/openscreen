// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { replaceTimeline as replaceTimelineOp } from "@/lib/ai-edition/document/timeline";
import { type AxcutDocument, createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { undo } from "@/lib/ai-edition/store/undo";
import { clearHistory, past } from "@/lib/ai-edition/store/undoStack";
import {
	applyPendingFreshRecordingAutoZooms,
	consumeFreshRecordingAutoZoomPending,
	importPendingRecording,
	markFreshRecordingAutoZoomPending,
	maybeSaveFreshRecordingAutoZooms,
} from "./recordingImport";

// The first describe stubs the store actions, so the bridge is never reached
// there. The second one runs the REAL store against these, which is the only way
// to see what the import leaves on the undo stack.
const bridge = vi.hoisted(() => ({
	create: vi.fn(),
	addAsset: vi.fn(),
	save: vi.fn(),
	getTelemetry: vi.fn(async () => []),
}));
vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		aiEdition: bridge,
		cursor: { getTelemetry: bridge.getTelemetry },
	},
}));

// Typed to the store's own action signatures rather than cast through `any`:
// tsconfig.test.json typechecks this file in CI, so a stub that drifts from the
// contract it stands in for should fail there instead of passing silently.
// `createProject` returns a document because the real one does — the import path
// discards it, but a stub that lies about the shape is a stub that stops catching
// the day something starts reading it.
const createProject = vi.fn(
	async (title: string): Promise<AxcutDocument> =>
		createEmptyDocument({ projectId: "proj_stub", title }),
);
const addAsset = vi.fn(async (): Promise<null> => null);
const replaceTimeline = vi.fn(async () => undefined);

// Read before anything stubs them: the first describe replaces these actions on the
// live store, and `clear()` resets the DATA, not the actions.
const realActions = {
	createProject: useProjectStore.getState().createProject,
	addAsset: useProjectStore.getState().addAsset,
	replaceTimeline: useProjectStore.getState().replaceTimeline,
	saveDocument: useProjectStore.getState().saveDocument,
};

/** Stands in for the main-process recording slot: one value, set and read. */
function stubElectronApi(
	screenVideoPath: string | null,
	cursorCaptureMode: "editable-overlay" | "system" = "editable-overlay",
) {
	let session: {
		screenVideoPath: string;
		createdAt: number;
		cursorCaptureMode: "editable-overlay" | "system";
	} | null = screenVideoPath ? { screenVideoPath, createdAt: 0, cursorCaptureMode } : null;
	const api = {
		getCurrentRecordingSession: vi.fn(async () =>
			session ? { success: true, session } : { success: false },
		),
		setCurrentRecordingSession: vi.fn(async (next: typeof session) => {
			session = next;
			return { success: true };
		}),
	};
	// biome-ignore lint/suspicious/noExplicitAny: test-only stub of the contextBridge surface
	(window as any).electronAPI = api;
	return api;
}

describe("importPendingRecording", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		consumeFreshRecordingAutoZoomPending();
		useProjectStore.setState({
			document: null,
			createProject,
			addAsset,
			replaceTimeline,
		});
	});

	it("does nothing when no recording is waiting", async () => {
		stubElectronApi(null);
		await expect(importPendingRecording()).resolves.toBe(false);
		expect(createProject).not.toHaveBeenCalled();
	});

	it("imports the recording into a new project and consumes the hand-off", async () => {
		const api = stubElectronApi("C:\\recordings\\recording-1.mp4");

		await expect(importPendingRecording()).resolves.toBe(true);

		expect(createProject).toHaveBeenCalledTimes(1);
		expect(addAsset).toHaveBeenCalledWith("C:\\recordings\\recording-1.mp4", "recording-1.mp4");
		expect(api.setCurrentRecordingSession).toHaveBeenCalledWith(null);
	});

	// The regression: the editor window is destroyed and recreated on every open,
	// so a session left in the slot was imported again — a second project on the
	// same recording, at default settings, with the user's saved ones stranded in
	// the first one.
	it("imports one recording once, however often the editor mounts", async () => {
		stubElectronApi("C:\\recordings\\recording-1.mp4");

		await importPendingRecording();
		await expect(importPendingRecording()).resolves.toBe(false);

		expect(createProject).toHaveBeenCalledTimes(1);
		expect(addAsset).toHaveBeenCalledTimes(1);
	});

	it("seeds a placeholder clip when the imported asset has none", async () => {
		stubElectronApi("/recordings/recording-1.webm");
		addAsset.mockImplementationOnce(async () => {
			useProjectStore.setState({
				// biome-ignore lint/suspicious/noExplicitAny: only the two fields the seed reads
				document: { assets: [{ id: "a1" }], timeline: { clips: [] } } as any,
			});
			return null;
		});

		await importPendingRecording();

		expect(replaceTimeline).toHaveBeenCalledWith(
			[{ startSec: 0, endSec: 60 }],
			"Auto-imported recording",
			{ history: false },
		);
	});
});

// The whole hand-off, against the real store: stop the recording, land in the
// editor, press Ctrl+Z.
//
// The user has made no edit at this point -- the editor built this project for
// them, unattended, on mount. The seed below used to record itself as an undo
// step because `projectStore.replaceTimeline` hardcoded `{ history: true }` inside
// itself, where the option was invisible to its caller. So a brand-new project
// opened with `past.length === 1`, the first Ctrl+Z restored the state before the
// seed -- an empty timeline -- and `NewEditorShell`'s post-undo persist wrote that
// empty timeline to disk.
describe("what the recording import leaves on the undo stack", () => {
	const PROJECT_ID = "project_imported";
	const SCREEN_PATH = "/recordings/recording-1.webm";

	/** The document the main process actually returns from `addAsset`: an asset with
	 *  no `durationSec` (it stats the file, it does not probe it). */
	function withAsset(): AxcutDocument {
		const doc = createEmptyDocument({ projectId: PROJECT_ID, title: "Recording" });
		return {
			...doc,
			assets: [
				{
					id: "asset_1",
					kind: "video",
					label: "recording-1.webm",
					originalPath: SCREEN_PATH,
					cameraTrack: null,
				},
			],
			project: { ...doc.project, primaryAssetId: "asset_1" },
		};
	}

	beforeEach(() => {
		vi.clearAllMocks();
		consumeFreshRecordingAutoZoomPending();
		useProjectStore.getState().clear();
		useProjectStore.setState(realActions);
		clearHistory();
		bridge.create.mockImplementation(async () => ({
			success: true,
			document: createEmptyDocument({ projectId: PROJECT_ID, title: "Recording" }),
		}));
		bridge.addAsset.mockImplementation(async () => ({ success: true, document: withAsset() }));
		bridge.save.mockImplementation(async (document: unknown) => ({ success: true, document }));
		stubElectronApi(SCREEN_PATH);
	});

	it("leaves it empty: the user has not edited anything yet", async () => {
		await importPendingRecording();

		expect(past).toHaveLength(0);
		expect(undo()).toBe(false);
	});

	it("still has its clip after the first Ctrl+Z", async () => {
		await importPendingRecording();

		// The `<video>` reports its duration and `NewEditorShell.handleLoadedMetadata`
		// folds it in -- which is when the clip the user sees actually appears, since
		// `replaceTimeline` sizes clips from `asset.durationSec` and the import has none.
		// Automatic too, hence `history: false`.
		const loaded = useProjectStore.getState().document as AxcutDocument;
		const probed: AxcutDocument = {
			...loaded,
			assets: loaded.assets.map((a) => ({ ...a, durationSec: 42 })),
		};
		await useProjectStore
			.getState()
			.saveDocument(replaceTimelineOp(probed, [{ startSec: 0, endSec: 42 }], "Auto-created"), {
				history: false,
			});
		expect(useProjectStore.getState().document?.timeline.clips).toHaveLength(1);

		undo();

		expect(useProjectStore.getState().document?.timeline.clips).toHaveLength(1);
	});
});

function dwell(
	centerMs: number,
	cx: number,
	cy: number,
	count = 6,
	spanMs = 900,
): Array<{ timeMs: number; cx: number; cy: number }> {
	const step = spanMs / (count - 1);
	return Array.from({ length: count }, (_, i) => ({
		timeMs: centerMs - spanMs / 2 + i * step,
		cx,
		cy,
	}));
}

const RECORDING_PATH = "C:\\recordings\\rec.mp4";

function documentWithClip(durationSec = 10): AxcutDocument {
	const doc = createEmptyDocument({ projectId: "p_autozoom", title: "Recording" });
	return {
		...doc,
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "rec.mp4",
				originalPath: RECORDING_PATH,
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

describe("fresh-recording auto-zoom", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		consumeFreshRecordingAutoZoomPending();
		useProjectStore.setState({
			document: null,
			createProject,
			addAsset,
			replaceTimeline,
		});
	});

	it("marks a successful import as waiting when the document is not ready yet", async () => {
		stubElectronApi("C:\\recordings\\recording-1.mp4");
		await importPendingRecording();
		expect(consumeFreshRecordingAutoZoomPending()).toBe(true);
	});

	it("does not mark when nothing is waiting", async () => {
		stubElectronApi(null);
		await importPendingRecording();
		expect(consumeFreshRecordingAutoZoomPending()).toBe(false);
	});

	// A system-cursor take writes no `.cursor.json`, so there is never a dwell to
	// find. Marking it pending anyway armed the hand-off for a take that can never
	// spend it.
	it("does not mark a system-cursor take as waiting", async () => {
		stubElectronApi("C:\\recordings\\recording-1.mp4", "system");
		await importPendingRecording();
		expect(consumeFreshRecordingAutoZoomPending()).toBe(false);
	});

	it("still marks an editable-cursor take from the same import path", async () => {
		stubElectronApi("C:\\recordings\\recording-1.mp4", "editable-overlay");
		await importPendingRecording();
		expect(consumeFreshRecordingAutoZoomPending()).toBe(true);
	});

	it("applies cursor-dwell zooms once, after duration is known", async () => {
		markFreshRecordingAutoZoomPending(RECORDING_PATH);
		const next = await applyPendingFreshRecordingAutoZooms(documentWithClip(), {
			enabled: true,
			getTelemetry: async () => dwell(4000, 0.4, 0.6),
			createId: (prefix) => `${prefix}_test`,
		});
		expect(next.zoomRanges).toHaveLength(1);
		expect(next.zoomRanges[0]).toMatchObject({
			startMs: 3000,
			endMs: 5000,
			focusMode: "auto",
		});
		expect(await applyPendingFreshRecordingAutoZooms(next, { enabled: true })).toBe(next);
	});

	it("skips when the HUD toggle is off", async () => {
		markFreshRecordingAutoZoomPending(RECORDING_PATH);
		const document = documentWithClip();
		const next = await applyPendingFreshRecordingAutoZooms(document, {
			enabled: false,
			getTelemetry: async () => dwell(4000, 0.5, 0.5),
		});
		expect(next).toBe(document);
		expect(next.zoomRanges).toEqual([]);
	});

	// The stop handler awaits `writePendingCursorTelemetry` before it publishes the
	// session, so the sidecar is on disk by the time a take can be imported. An empty
	// read is therefore the take's real answer, not a mid-flush one, and leaving the
	// hand-off armed would let it fire on the next document loaded in this window.
	it("consumes the hand-off when the sidecar holds no dwell", async () => {
		markFreshRecordingAutoZoomPending(RECORDING_PATH);
		const document = documentWithClip();
		const first = await applyPendingFreshRecordingAutoZooms(document, {
			enabled: true,
			getTelemetry: async () => [],
		});
		expect(first).toBe(document);
		expect(consumeFreshRecordingAutoZoomPending()).toBe(false);
	});

	it("keeps the pending flag when clips are not on the document yet", async () => {
		markFreshRecordingAutoZoomPending(RECORDING_PATH);
		const document = createEmptyDocument({ projectId: "p_empty", title: "Recording" });
		const next = await applyPendingFreshRecordingAutoZooms(document, {
			enabled: true,
			getTelemetry: async () => dwell(4000, 0.5, 0.5),
		});
		expect(next).toBe(document);
		expect(consumeFreshRecordingAutoZoomPending()).toBe(true);
	});

	it("consumes the hand-off when the cursor never sits still", async () => {
		markFreshRecordingAutoZoomPending(RECORDING_PATH);
		const document = documentWithClip();
		const moving = Array.from({ length: 8 }, (_, i) => ({
			timeMs: 1000 + i * 80,
			cx: 0.2 + i * 0.08,
			cy: 0.3,
		}));
		const first = await applyPendingFreshRecordingAutoZooms(document, {
			enabled: true,
			getTelemetry: async () => moving,
		});
		expect(first).toBe(document);
		expect(consumeFreshRecordingAutoZoomPending()).toBe(false);
	});

	// The one read that is not an answer: an error says nothing about whether the take
	// has a dwell, so the hand-off survives it.
	it("keeps pending when telemetry read throws", async () => {
		markFreshRecordingAutoZoomPending(RECORDING_PATH);
		const document = documentWithClip();
		const next = await applyPendingFreshRecordingAutoZooms(document, {
			enabled: true,
			getTelemetry: async () => {
				throw new Error("sidecar missing");
			},
		});
		expect(next).toBe(document);
		expect(consumeFreshRecordingAutoZoomPending()).toBe(true);
	});

	it("does not decorate a different project's asset after a leftover pending flag", async () => {
		markFreshRecordingAutoZoomPending("C:\\recordings\\fresh.mp4");
		const other = documentWithClip();
		const next = await applyPendingFreshRecordingAutoZooms(other, {
			enabled: true,
			getTelemetry: async () => dwell(4000, 0.4, 0.6),
		});
		expect(next).toBe(other);
		expect(consumeFreshRecordingAutoZoomPending()).toBe(true);
	});

	it("does not decorate a later imported clip while the fresh take is still pending", async () => {
		const fresh = documentWithClip();
		const laterPath = "C:\\recordings\\later.mp4";
		const withLater: AxcutDocument = {
			...fresh,
			assets: [
				...fresh.assets,
				{
					id: "asset_later",
					kind: "video",
					label: "later.mp4",
					originalPath: laterPath,
					cameraTrack: null,
					durationSec: 10,
				},
			],
			timeline: {
				...fresh.timeline,
				clips: [
					...fresh.timeline.clips,
					{
						id: "clip_later",
						assetId: "asset_later",
						sourceStartSec: 0,
						sourceEndSec: 10,
						timelineStartSec: 10,
						timelineEndSec: 20,
						wordRefs: [],
						origin: "system",
						reason: "",
					},
				],
			},
		};
		markFreshRecordingAutoZoomPending(fresh.assets[0].originalPath);
		const next = await applyPendingFreshRecordingAutoZooms(withLater, {
			enabled: true,
			getTelemetry: async (videoPath) => (videoPath === laterPath ? dwell(14000, 0.4, 0.6) : []),
			createId: (prefix) => `${prefix}_later`,
		});
		// The point of the test: the later clip's dwell is not read at all, so the fresh
		// take is never decorated with another asset's telemetry. Its own sidecar was
		// empty, which is a real answer, so the hand-off is spent either way.
		expect(next).toBe(withLater);
		expect(next.zoomRanges).toEqual([]);
		expect(consumeFreshRecordingAutoZoomPending()).toBe(false);
	});

	it("waits for a probed asset duration before generating zooms", async () => {
		markFreshRecordingAutoZoomPending(RECORDING_PATH);
		const placeholder = documentWithClip(60);
		placeholder.assets[0].durationSec = undefined;
		const first = await applyPendingFreshRecordingAutoZooms(placeholder, {
			enabled: true,
			getTelemetry: async () => dwell(4000, 0.4, 0.6),
		});
		expect(first).toBe(placeholder);
		expect(first.zoomRanges).toEqual([]);
		expect(consumeFreshRecordingAutoZoomPending()).toBe(true);
	});

	it("appends to the store document after telemetry, not the caller's snapshot", async () => {
		const stale = documentWithClip(90);
		const trimmed = {
			...stale,
			timeline: {
				...stale.timeline,
				clips: [
					{
						...stale.timeline.clips[0],
						sourceEndSec: 80,
						timelineEndSec: 80,
					},
				],
			},
		};
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		markFreshRecordingAutoZoomPending(stale.assets[0].originalPath);
		useProjectStore.setState({ document: stale });
		const pending = applyPendingFreshRecordingAutoZooms(stale, {
			enabled: true,
			getTelemetry: async () => {
				await gate;
				return dwell(4000, 0.4, 0.6);
			},
			createId: (prefix) => `${prefix}_live`,
		});
		useProjectStore.setState({ document: trimmed });
		release();
		const next = await pending;
		expect(next.timeline.clips[0].sourceEndSec).toBe(80);
		expect(next.zoomRanges).toHaveLength(1);
	});

	it("does not re-apply after a successful save once the user removes the zooms", async () => {
		const document = documentWithClip();
		const saveDocument = vi.fn(async (next: AxcutDocument) => {
			useProjectStore.setState({ document: next });
			return true;
		});
		useProjectStore.setState({
			document,
			saveDocument,
		});
		markFreshRecordingAutoZoomPending(document.assets[0].originalPath);
		await expect(
			maybeSaveFreshRecordingAutoZooms(document, {
				enabled: true,
				getTelemetry: async () => dwell(4000, 0.4, 0.6),
				createId: (prefix) => `${prefix}_once`,
			}),
		).resolves.toBe(true);
		expect(useProjectStore.getState().document?.zoomRanges).toHaveLength(1);

		const cleared = {
			...useProjectStore.getState().document,
			zoomRanges: [],
		} as AxcutDocument;
		useProjectStore.setState({ document: cleared });
		await expect(
			maybeSaveFreshRecordingAutoZooms(cleared, {
				enabled: true,
				getTelemetry: async () => dwell(4000, 0.4, 0.6),
			}),
		).resolves.toBe(false);
		expect(useProjectStore.getState().document?.zoomRanges).toEqual([]);
	});

	it("does not overwrite an in-flight user save with stale zooms", async () => {
		const stale = documentWithClip(90);
		const trimmed = {
			...stale,
			timeline: {
				...stale.timeline,
				clips: [
					{
						...stale.timeline.clips[0],
						sourceEndSec: 80,
						timelineEndSec: 80,
					},
				],
			},
		};
		let releaseUserSave!: () => void;
		const userSaveGate = new Promise<void>((resolve) => {
			releaseUserSave = resolve;
		});
		let releaseTelemetry!: () => void;
		const telemetryGate = new Promise<void>((resolve) => {
			releaseTelemetry = resolve;
		});
		let saveCalls = 0;
		bridge.save.mockImplementation(async (document: unknown) => {
			saveCalls += 1;
			if (saveCalls === 1) await userSaveGate;
			return { success: true, document };
		});
		useProjectStore.setState({
			document: stale,
			saveDocument: realActions.saveDocument,
		});
		markFreshRecordingAutoZoomPending(stale.assets[0].originalPath);
		const userSave = useProjectStore.getState().saveDocument(trimmed, { history: true });
		const autoZoom = maybeSaveFreshRecordingAutoZooms(stale, {
			enabled: true,
			getTelemetry: async () => {
				await telemetryGate;
				return dwell(4000, 0.4, 0.6);
			},
			createId: (prefix) => `${prefix}_race`,
		});
		releaseTelemetry();
		releaseUserSave();
		await expect(userSave).resolves.toBe(true);
		await expect(autoZoom).resolves.toBe(true);
		const stored = useProjectStore.getState().document;
		expect(stored?.timeline.clips[0].sourceEndSec).toBe(80);
		expect(stored?.zoomRanges).toHaveLength(1);
	});

	// Contention is never a rebase: writing the snapshot this attempt built from would
	// take the user's trim with it. The attempt is dropped whole and repeated once, from
	// scratch, after `waitForDocumentSaves` has seen that writer finish -- so the zooms
	// land ON the trim rather than over it.
	it("re-collects from scratch when a user save lands mid-attempt", async () => {
		const stale = documentWithClip(90);
		const trimmed = {
			...stale,
			timeline: {
				...stale.timeline,
				clips: [{ ...stale.timeline.clips[0], sourceEndSec: 80, timelineEndSec: 80 }],
			},
		};
		bridge.save.mockImplementation(async (document: unknown) => ({ success: true, document }));
		useProjectStore.setState({ document: stale, saveDocument: realActions.saveDocument });
		markFreshRecordingAutoZoomPending(stale.assets[0].originalPath);
		let userSaveLanded = false;

		const result = await maybeSaveFreshRecordingAutoZooms(stale, {
			enabled: true,
			// Runs between the two `waitForDocumentSaves` calls, which is exactly the
			// window a rebase would have gone through. The save fires ONCE: if it
			// fired again on a second suggestion pass, a rebasing implementation
			// would bail on the newer write instead of on the contention itself, and
			// this test would pass against the behaviour it exists to rule out.
			getTelemetry: async () => {
				if (!userSaveLanded) {
					userSaveLanded = true;
					await useProjectStore.getState().saveDocument(trimmed, { history: true });
				}
				return dwell(4000, 0.4, 0.6);
			},
			createId: (prefix) => `${prefix}_contended`,
		});

		expect(result).toBe(true);
		const stored = useProjectStore.getState().document;
		// The user's trim survived, and the zooms sit on top of it.
		expect(stored?.timeline.clips[0].sourceEndSec).toBe(80);
		expect(stored?.zoomRanges).toHaveLength(1);
		expect(consumeFreshRecordingAutoZoomPending()).toBe(false);
	});

	it("keeps pending when a later user save wipes zooms before they settle", async () => {
		const stale = documentWithClip(90);
		const trimmed = {
			...stale,
			timeline: {
				...stale.timeline,
				clips: [
					{
						...stale.timeline.clips[0],
						sourceEndSec: 80,
						timelineEndSec: 80,
					},
				],
			},
		};
		let releaseAutoZoomIpc!: () => void;
		const autoZoomIpcGate = new Promise<void>((resolve) => {
			releaseAutoZoomIpc = resolve;
		});
		let releaseUserIpc!: () => void;
		const userIpcGate = new Promise<void>((resolve) => {
			releaseUserIpc = resolve;
		});
		let autoZoomStarted!: () => void;
		const autoZoomStartedGate = new Promise<void>((resolve) => {
			autoZoomStarted = resolve;
		});
		let userStarted!: () => void;
		const userStartedGate = new Promise<void>((resolve) => {
			userStarted = resolve;
		});
		let saveCalls = 0;
		bridge.save.mockImplementation(async (document: unknown) => {
			saveCalls += 1;
			if (saveCalls === 1) {
				autoZoomStarted();
				await autoZoomIpcGate;
			} else {
				userStarted();
				await userIpcGate;
			}
			return { success: true, document };
		});
		useProjectStore.setState({
			document: stale,
			saveDocument: realActions.saveDocument,
		});
		markFreshRecordingAutoZoomPending(stale.assets[0].originalPath);
		const autoZoom = maybeSaveFreshRecordingAutoZooms(stale, {
			enabled: true,
			getTelemetry: async () => dwell(4000, 0.4, 0.6),
			createId: (prefix) => `${prefix}_after`,
		});
		await autoZoomStartedGate;
		const userSave = useProjectStore.getState().saveDocument(trimmed, { history: true });
		await userStartedGate;
		releaseAutoZoomIpc();
		releaseUserIpc();
		await expect(userSave).resolves.toBe(true);
		await expect(autoZoom).resolves.toBe(true);
		const wiped = useProjectStore.getState().document;
		expect(wiped?.timeline.clips[0].sourceEndSec).toBe(80);
		expect(wiped?.zoomRanges).toEqual([]);

		await expect(
			maybeSaveFreshRecordingAutoZooms(wiped as AxcutDocument, {
				enabled: true,
				getTelemetry: async () => dwell(4000, 0.4, 0.6),
				createId: (prefix) => `${prefix}_rebase`,
			}),
		).resolves.toBe(true);
		const recovered = useProjectStore.getState().document;
		expect(recovered?.timeline.clips[0].sourceEndSec).toBe(80);
		expect(recovered?.zoomRanges).toHaveLength(1);
		expect(consumeFreshRecordingAutoZoomPending()).toBe(false);
	});
	// Waiting on somebody else's write is only half of it: this path's OWN write
	// can hang too. `saveDocument` never rejects, so a main process that stops
	// answering leaves the await pending forever — inside the shared chain, which
	// then takes every retry down with it.
	//
	// LAST in this file on purpose: the abandoned save is never released, so it
	// leaves the in-flight counter raised for anything that runs after it.
	it("gives up on a write that never answers, and leaves the chain usable", async () => {
		const doc = documentWithClip(90);
		bridge.save.mockReturnValue(new Promise(() => undefined));
		useProjectStore.setState({ document: doc, saveDocument: realActions.saveDocument });
		markFreshRecordingAutoZoomPending(doc.assets[0].originalPath);

		await expect(
			maybeSaveFreshRecordingAutoZooms(doc, {
				enabled: true,
				getTelemetry: async () => dwell(4000, 0.4, 0.6),
				createId: (prefix) => `${prefix}_stuck`,
				saveTimeoutMs: 10,
				waitTimeoutMs: 10,
			}),
		).resolves.toBe(false);
		// Nothing was written, and the attempt is still owed.
		expect(useProjectStore.getState().document?.zoomRanges).toEqual([]);

		// The chain let go: a later attempt runs instead of queueing behind a promise
		// that is never coming back. (The abandoned save still holds the in-flight
		// counter, so this one waits out its own deadline rather than resolving idle
		// — which is the point: degraded, not wedged.)
		bridge.save.mockImplementation(async (document: unknown) => ({ success: true, document }));
		await expect(
			maybeSaveFreshRecordingAutoZooms(doc, {
				enabled: true,
				getTelemetry: async () => dwell(4000, 0.4, 0.6),
				createId: (prefix) => `${prefix}_after`,
				saveTimeoutMs: 1_000,
				waitTimeoutMs: 10,
			}),
		).resolves.toBe(false);
		expect(consumeFreshRecordingAutoZoomPending()).toBe(true);
	});
});
