import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentService } from "../../ai-edition/document-service";
import { findMediaLinksByFingerprint, registerMediaLinks } from "../../media/mediaLinksRegistry";
import { AiEditionService, type AiEditionServiceOptions } from "./aiEditionService";

describe("AiEditionService — deleting a project's recordings", () => {
	let root: string;
	let recordingsDir: string;
	let documents: DocumentService;
	let video: string;
	let cursor: string;
	let projectId: string;
	let trashItem: ReturnType<typeof vi.fn<(filePath: string) => Promise<void>>>;

	function service(): AiEditionService {
		return new AiEditionService({
			documents,
			llmConfig: () => {
				throw new Error("not used");
			},
			recordings: {
				dirs: () => [recordingsDir],
				registryDir: () => recordingsDir,
				trashItem,
			},
		} as unknown as AiEditionServiceOptions);
	}

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-delete-recordings-"));
		recordingsDir = path.join(root, "recordings");
		await fs.mkdir(recordingsDir);
		documents = new DocumentService(path.join(root, "projects"), root);
		video = path.join(recordingsDir, "recording-42.mp4");
		cursor = `${video}.cursor.json`;
		await fs.writeFile(video, "video");
		await fs.writeFile(cursor, "{}");
		await registerMediaLinks(recordingsDir, video, { cursorTelemetryPath: cursor });
		const doc = await documents.createProject("Take");
		await documents.addAsset(doc.project.id, { path: video, label: "recording-42.mp4" });
		projectId = doc.project.id;
		trashItem = vi.fn(async (filePath: string) => {
			await fs.rm(filePath);
		});
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	it("reports what the delete could remove", async () => {
		await expect(service().projectRecordings(projectId)).resolves.toEqual({
			success: true,
			count: 1,
			sizeBytes: 5 + 2,
			keptFor: [],
			unreadable: 0,
		});
	});

	it("keeps the recordings unless asked", async () => {
		await expect(service().deleteProject(projectId)).resolves.toEqual({ success: true });
		expect(trashItem).not.toHaveBeenCalled();
		await expect(fs.access(video)).resolves.toBeUndefined();
	});

	it("moves them to the Trash, deletes the project and forgets their links", async () => {
		await fs.writeFile(path.join(root, "probe.mp4"), "video");
		await expect(service().deleteProject(projectId, "trash")).resolves.toEqual({ success: true });

		expect(trashItem).toHaveBeenCalledTimes(2);
		await expect(documents.getProject(projectId)).rejects.toThrow();
		// Same bytes as the deleted take: only its registry entry could match.
		expect(
			await findMediaLinksByFingerprint(recordingsDir, path.join(root, "probe.mp4")),
		).toBeNull();
	});

	it("deletes nothing when a project file stopped parsing after the dialog asked", async () => {
		await fs.writeFile(path.join(root, "projects", "broken.openscreen"), "{ not json");

		await expect(service().deleteProject(projectId, "trash")).resolves.toMatchObject({
			success: false,
		});
		expect(trashItem).not.toHaveBeenCalled();
		await expect(fs.access(video)).resolves.toBeUndefined();
		await expect(documents.getProject(projectId)).resolves.toBeDefined();
	});

	it("keeps everything when the Trash refuses, then deletes permanently on request", async () => {
		trashItem.mockRejectedValueOnce(new Error("no trash on this filesystem"));

		await expect(service().deleteProject(projectId, "trash")).resolves.toMatchObject({
			success: false,
			trashFailed: true,
		});
		await expect(documents.getProject(projectId)).resolves.toBeDefined();
		await expect(fs.access(video)).resolves.toBeUndefined();

		await expect(service().deleteProject(projectId, "permanent")).resolves.toEqual({
			success: true,
		});
		await expect(fs.access(video)).rejects.toThrow();
		await expect(fs.access(cursor)).rejects.toThrow();
		await expect(documents.getProject(projectId)).rejects.toThrow();
	});
});
