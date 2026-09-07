// What one `loadedmetadata` event does once it reaches the front of the queue.
//
// The queue is why this is worth its own test: the shell puts this step on
// `useSequentialTimelineOps` alongside the user's own edits, so a step that never
// finishes holds that queue — and everything behind it. The pure decision
// (`documentAfterProbedDuration`) is covered next door; this covers what surrounds
// it — the guards, the bounded save, and what the auto-zoom pass is handed.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/contexts/ShortcutsContext", async () => {
	const { DEFAULT_SHORTCUTS } = await import("@/lib/shortcuts");
	return {
		useShortcuts: () => ({
			shortcuts: DEFAULT_SHORTCUTS,
			isMac: false,
			isConfigOpen: false,
			openConfig: vi.fn(),
			closeConfig: vi.fn(),
			setShortcuts: vi.fn(),
			persistShortcuts: () => Promise.resolve(true),
		}),
	};
});

vi.mock("@/contexts/I18nContext", () => ({
	useI18n: () => ({ locale: "en", setLocale: vi.fn() }),
	useScopedT: () => (key: string) => key,
}));

import { type AxcutDocument, createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { runLoadedMetadataWrite } from "./NewEditorShell";

const PROJECT = "proj_a";

/** A fresh import: one video asset on the document, nothing on the timeline yet. */
function freshImport(): AxcutDocument {
	const doc = createEmptyDocument({ projectId: PROJECT, title: "A" });
	return {
		...doc,
		project: { ...doc.project, primaryAssetId: "asset_1" },
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "screen.mp4",
				originalPath: "/tmp/screen.mp4",
				cameraTrack: null,
			},
		],
	};
}

/** Stands in for a save that answers, installing its result the way the real one does. */
function settlingSave() {
	return vi.fn(async (document: AxcutDocument) => {
		useProjectStore.setState({ document });
		return true;
	});
}

describe("runLoadedMetadataWrite", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useProjectStore.setState({ document: freshImport() });
	});

	it("folds the probed length in and hands auto-zoom the saved document", async () => {
		const saveDocument = settlingSave();
		useProjectStore.setState({ saveDocument });
		const autoZoom = vi.fn(async () => undefined);

		await runLoadedMetadataWrite(12.5, "asset_1", PROJECT, { autoZoom });

		expect(saveDocument).toHaveBeenCalledTimes(1);
		const saved = saveDocument.mock.calls[0][0];
		expect(saved.timeline.clips).toHaveLength(1);
		expect(saved.assets[0].durationSec).toBe(12.5);
		// Not the pre-save snapshot: auto-zoom appends to whatever is on the store now.
		expect(autoZoom).toHaveBeenCalledWith(useProjectStore.getState().document);
		expect(useProjectStore.getState().document?.timeline.clips).toHaveLength(1);
	});

	// THE reason the save is bounded. `saveDocument` awaits the bridge with no
	// deadline of its own and never rejects, so a main process that stops answering
	// leaves this step pending for the life of the renderer — and every edit queued
	// behind it waits with it, this take's auto-zoom included. Without the deadline
	// this test does not fail with a wrong value, it never finishes.
	it("gives up on a save that never answers instead of holding the queue", async () => {
		const saveDocument = vi.fn(() => new Promise<boolean>(() => undefined));
		useProjectStore.setState({ saveDocument });
		const autoZoom = vi.fn(async () => undefined);

		await runLoadedMetadataWrite(12.5, "asset_1", PROJECT, { autoZoom, saveTimeoutMs: 20 });

		expect(saveDocument).toHaveBeenCalledTimes(1);
		// The step let go and carried on, with the document the store actually holds
		// — the stuck write never installed one.
		expect(autoZoom).toHaveBeenCalledTimes(1);
		expect(useProjectStore.getState().document?.timeline.clips).toHaveLength(0);
	});

	// The switch that happens DURING the save, which the guard at the top cannot
	// see. Auto-zoom would not write zooms into the new project — the pending-path
	// guard refuses it — but the passes before that check clear the pending flag on
	// whatever document they are handed, so the take that was actually imported
	// would lose its auto-zoom without a trace.
	it("stops when the project changes while the save is in flight", async () => {
		// Carrying assets on purpose: an assetless document is turned away a line
		// later for a different reason, and this test would then pass without the
		// ownership check it exists to cover.
		const other = { ...freshImport(), project: { ...freshImport().project, id: "proj_b" } };
		const saveDocument = vi.fn(async () => {
			useProjectStore.setState({ document: other });
			return true;
		});
		useProjectStore.setState({ saveDocument });
		const autoZoom = vi.fn(async () => undefined);

		await runLoadedMetadataWrite(12.5, "asset_1", PROJECT, { autoZoom });

		expect(saveDocument).toHaveBeenCalledTimes(1);
		expect(autoZoom).not.toHaveBeenCalled();
	});

	// Same for the project being closed outright: there is nothing left for this
	// event to belong to, and the pre-switch snapshot is not a stand-in for it.
	it("stops when the project is closed while the save is in flight", async () => {
		const saveDocument = vi.fn(async () => {
			useProjectStore.setState({ document: null });
			return true;
		});
		useProjectStore.setState({ saveDocument });
		const autoZoom = vi.fn(async () => undefined);

		await runLoadedMetadataWrite(12.5, "asset_1", PROJECT, { autoZoom });

		expect(autoZoom).not.toHaveBeenCalled();
	});

	// The event is bound to the project that owned the video when it fired, and the
	// queue puts real time between the two.
	it("writes nothing when the project changed before it ran", async () => {
		const saveDocument = settlingSave();
		useProjectStore.setState({ saveDocument });
		const autoZoom = vi.fn(async () => undefined);

		await runLoadedMetadataWrite(12.5, "asset_1", "proj_switched_away_from", { autoZoom });

		expect(saveDocument).not.toHaveBeenCalled();
		expect(autoZoom).not.toHaveBeenCalled();
	});

	it("writes nothing without a document, or without assets", async () => {
		const saveDocument = settlingSave();
		const autoZoom = vi.fn(async () => undefined);

		useProjectStore.setState({ document: null, saveDocument });
		await runLoadedMetadataWrite(12.5, "asset_1", PROJECT, { autoZoom });

		const empty = createEmptyDocument({ projectId: PROJECT, title: "A" });
		useProjectStore.setState({ document: empty, saveDocument });
		await runLoadedMetadataWrite(12.5, "asset_1", PROJECT, { autoZoom });

		expect(saveDocument).not.toHaveBeenCalled();
		expect(autoZoom).not.toHaveBeenCalled();
	});

	// Nothing to fold in is not a reason to skip auto-zoom: a second event for a
	// document that already has its length still has to let the suggestion pass run.
	it("still runs auto-zoom when the document needs no write", async () => {
		const saveDocument = settlingSave();
		useProjectStore.setState({ saveDocument });
		const autoZoom = vi.fn(async () => undefined);

		await runLoadedMetadataWrite(12.5, "asset_1", PROJECT, { autoZoom });
		saveDocument.mockClear();
		await runLoadedMetadataWrite(12.5, "asset_1", PROJECT, { autoZoom });

		expect(saveDocument).not.toHaveBeenCalled();
		expect(autoZoom).toHaveBeenCalledTimes(2);
	});
});
