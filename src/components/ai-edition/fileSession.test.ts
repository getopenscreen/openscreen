// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	normalizeProjectEditor,
	PROJECT_VERSION,
} from "@/components/video-editor/projectPersistence";
import { migrateProjectDataToAxcutDocument } from "@/lib/ai-edition/document/migrate";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { finishEditorFile, loadEditorFile } from "./fileSession";

const bridge = vi.hoisted(() => ({ save: vi.fn(), get: vi.fn() }));
const probes = vi.hoisted(() => ({ probeVideoDuration: vi.fn(), probeVideoDimensions: vi.fn() }));
vi.mock("@/native/client", () => ({ nativeBridgeClient: { aiEdition: bridge } }));
vi.mock("@/lib/ai-edition/timeline/duration", () => probes);
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const legacy = {
	version: PROJECT_VERSION,
	media: { screenVideoPath: "/recordings/take.mp4" },
	editor: normalizeProjectEditor({}),
};

beforeEach(() => {
	vi.clearAllMocks();
	useProjectStore.getState().clear();
	window.electronAPI = {
		loadProjectFileFromPath: vi.fn(async () => ({ success: true, project: legacy })),
	} as unknown as typeof window.electronAPI;
	probes.probeVideoDuration.mockResolvedValue(12);
	probes.probeVideoDimensions.mockResolvedValue({ width: 640, height: 360 });
	bridge.save.mockImplementation(async (document) => ({ success: true, document }));
	bridge.get.mockImplementation(async () => ({
		success: true,
		document: bridge.save.mock.calls.at(-1)?.[0],
	}));
});
afterEach(() => {
	vi.useRealTimers();
	useProjectStore.getState().clear();
});

describe("editor file sessions", () => {
	it("opens the requested legacy file and resolves its real duration before completion", async () => {
		await loadEditorFile("/recordings/take.openscreen");
		expect(window.electronAPI.loadProjectFileFromPath).toHaveBeenCalledWith(
			"/recordings/take.openscreen",
		);
		const doc = useProjectStore.getState().document;
		expect(doc?.assets[0].durationSec).toBe(12);
		expect(doc?.assets[0].video).toMatchObject({ width: 640, height: 360 });
		expect(doc?.timeline.clips[0].sourceEndSec).toBe(12);
	});

	it("loads current documents without applying the legacy migration or probing measured media", async () => {
		const doc = migrateProjectDataToAxcutDocument(legacy);
		doc.project.title = "Edited project";
		vi.mocked(window.electronAPI.loadProjectFileFromPath).mockResolvedValue({
			success: true,
			project: doc,
		});
		await loadEditorFile("/recordings/edited.openscreen");
		expect(useProjectStore.getState().document).toEqual(doc);
		expect(probes.probeVideoDuration).not.toHaveBeenCalled();
	});

	it("reports load and import failures rather than falling back to another project", async () => {
		vi.mocked(window.electronAPI.loadProjectFileFromPath).mockResolvedValue({
			success: false,
			message: "File not found",
		});
		await expect(loadEditorFile("/missing.openscreen")).rejects.toThrow("File not found");
		expect(bridge.save).not.toHaveBeenCalled();
		expect(useProjectStore.getState().document).toBeNull();
	});

	it("refuses a legacy file whose media cannot be probed", async () => {
		probes.probeVideoDuration.mockResolvedValue(null);
		await expect(loadEditorFile("/recordings/take.openscreen")).rejects.toThrow(
			"Could not read recorded video",
		);
		expect(bridge.save).not.toHaveBeenCalled();
	});

	it("waits for an in-flight edit and returns that saved document", async () => {
		await loadEditorFile("/recordings/take.openscreen");
		const state = useProjectStore.getState();
		const doc = state.document!;
		const edited = { ...doc, project: { ...doc.project, title: "Latest edit" } };
		let release!: () => void;
		bridge.save.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = () => resolve({ success: true, document: edited });
				}),
		);
		const saving = state.saveDocument(edited, { history: true });
		const finish = vi.fn(async () => undefined);
		const finishing = finishEditorFile(finish);
		await Promise.resolve();
		expect(finish).not.toHaveBeenCalled();
		release();
		await saving;
		await finishing;
		expect(finish).toHaveBeenCalledWith(edited);
	});

	it("does not complete if saving the current edits fails", async () => {
		await loadEditorFile("/recordings/take.openscreen");
		bridge.save.mockResolvedValueOnce({ success: false, error: "Full disk" });
		const finish = vi.fn();
		await expect(finishEditorFile(finish)).rejects.toThrow("Could not save the current edits");
		expect(finish).not.toHaveBeenCalled();
	});

	it("waits for edits queued before any native save starts", async () => {
		await loadEditorFile("/recordings/take.openscreen");
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const finish = vi.fn(async () => undefined);
		const finishing = finishEditorFile(finish, pending);
		await Promise.resolve();
		expect(finish).not.toHaveBeenCalled();
		const doc = useProjectStore.getState().document!;
		const updated = { ...doc, project: { ...doc.project, title: "Queued edit" } };
		await useProjectStore.getState().saveDocument(updated, { history: true });
		release();
		await finishing;
		expect(finish).toHaveBeenCalledWith(updated);
	});

	it("abandons completion if a queued edit never settles", async () => {
		vi.useFakeTimers();
		const pending = new Promise<void>(() => {
			/* simulate a stalled edit */
		});
		const finish = vi.fn();
		const assertion = expect(finishEditorFile(finish, pending)).rejects.toThrow("queued edit");
		await vi.advanceTimersByTimeAsync(10_000);
		await assertion;
		expect(finish).not.toHaveBeenCalled();
	});

	it("propagates a failed output commit and permits a later retry", async () => {
		await loadEditorFile("/recordings/take.openscreen");
		const finish = vi
			.fn()
			.mockRejectedValueOnce(new Error("Permission denied"))
			.mockResolvedValueOnce(undefined);
		await expect(finishEditorFile(finish)).rejects.toThrow("Permission denied");
		await finishEditorFile(finish);
		expect(finish).toHaveBeenCalledTimes(2);
	});
});
