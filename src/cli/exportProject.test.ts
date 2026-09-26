import { describe, expect, it, vi } from "vitest";
import {
	normalizeProjectEditor,
	PROJECT_VERSION,
	validateProjectData,
} from "@/components/video-editor/projectPersistence";
import { migrateProjectDataToAxcutDocument } from "@/lib/ai-edition/document/migrate";
import { isAxcutDocumentFile } from "@/lib/ai-edition/schema";
import { loadDocumentProject, type VideoProbe } from "./exportProject";

const SCREEN = "/recordings/screen.mp4";

const v2Project = (editor: Record<string, unknown> = {}) => ({
	version: PROJECT_VERSION,
	media: { screenVideoPath: SCREEN },
	editor,
});

/**
 * A project file as the editor writes it: the AxcutDocument itself, JSON round-tripped, its
 * primary asset carrying the dimensions and duration the editor probed on import, and `settings`
 * written straight into `legacyEditor`, where the editor keeps them.
 */
function savedDocument(settings: Record<string, unknown> = {}, schemaVersion?: number) {
	const migrated = migrateProjectDataToAxcutDocument({
		...v2Project(),
		editor: normalizeProjectEditor({}),
	});
	const doc = { ...migrated, legacyEditor: { ...migrated.legacyEditor, ...settings } };
	const assets = doc.assets.map((asset) => ({
		...asset,
		durationSec: 12,
		video: { codec: "h264", fps: 60, width: 1920, height: 1080 },
	}));
	const raw = JSON.parse(JSON.stringify({ ...doc, assets })) as Record<string, unknown>;
	if (schemaVersion !== undefined) raw.schemaVersion = schemaVersion;
	return raw;
}

const noProbe: VideoProbe = () =>
	Promise.reject(new Error("probed a video the document describes"));

describe("the project file shapes the CLI export reads", () => {
	it("tells a saved document from a legacy v2 project", () => {
		expect(isAxcutDocumentFile(savedDocument())).toBe(true);
		expect(isAxcutDocumentFile(v2Project())).toBe(false);
		// The v2 validator is what rejected every document before: it must stay out of their way.
		expect(validateProjectData(savedDocument())).toBe(false);
		expect(validateProjectData(v2Project())).toBe(true);
		expect(isAxcutDocumentFile(null)).toBe(false);
		expect(isAxcutDocumentFile({ schemaVersion: 8 })).toBe(false);
	});
});

describe("loadDocumentProject", () => {
	it("reads the media, length and size off the document without probing", async () => {
		const project = await loadDocumentProject(savedDocument(), noProbe);
		expect(project.screenVideoPath).toBe(SCREEN);
		expect(project.durationMs).toBe(12_000);
		expect(project.sourceDims).toEqual({ width: 1920, height: 1080 });
		expect(project.document.assets[0]?.originalPath).toBe(SCREEN);
	});

	it("keeps what the editor saved, the frame included", async () => {
		const project = await loadDocumentProject(
			savedDocument({ frame: "phone", padding: 30, exportFormat: "gif", exportQuality: "source" }),
			noProbe,
		);
		expect(project.document.legacyEditor).toMatchObject({ frame: "phone", padding: 30 });
		expect(project.editor).toMatchObject({ exportFormat: "gif", exportQuality: "source" });
	});

	it("upgrades an older schemaVersion the way the editor does on open", async () => {
		const raw = savedDocument({}, 7);
		delete (raw.legacyEditor as Record<string, unknown>).aspectRatio;
		const project = await loadDocumentProject(raw, noProbe);
		expect(project.document.schemaVersion).toBe(8);
		expect(project.document.legacyEditor?.aspectRatio).toBe("16:9");
	});

	it("probes the recording only when the document lacks its size or length", async () => {
		const raw = savedDocument();
		const assets = raw.assets as Record<string, unknown>[];
		raw.assets = assets.map(({ video: _video, ...asset }) => asset);
		const probe = vi
			.fn<VideoProbe>()
			.mockResolvedValue({ width: 1280, height: 720, durationMs: 4000 });
		const project = await loadDocumentProject(raw, probe);
		expect(probe).toHaveBeenCalledWith(SCREEN);
		expect(project.sourceDims).toEqual({ width: 1280, height: 720 });
		expect(project.durationMs).toBe(4000);
	});

	it("refuses a document with no media, and one that does not validate", async () => {
		await expect(loadDocumentProject({ ...savedDocument(), assets: [] }, noProbe)).rejects.toThrow(
			"does not reference any recorded media",
		);
		await expect(
			loadDocumentProject({ ...savedDocument(), project: null }, noProbe),
		).rejects.toThrow();
	});
});
