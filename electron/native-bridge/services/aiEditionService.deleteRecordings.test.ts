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

	describe("managing every recording", () => {
		it("lists the take with the project that uses it", async () => {
			const result = await service().listRecordings();

			expect(result).toMatchObject({ success: true, unreadable: 0 });
			expect(result.recordings).toHaveLength(1);
			expect(result.recordings[0]).toMatchObject({
				id: path.join(recordingsDir, "recording-42"),
				usedBy: ["Take"],
				sizeBytes: 5 + 2,
			});
		});

		it("trashes the named takes and forgets their links", async () => {
			const other = path.join(recordingsDir, "recording-43.mp4");
			await fs.writeFile(other, "other");
			await fs.writeFile(path.join(root, "probe.mp4"), "video");

			await expect(
				service().deleteRecordings([path.join(recordingsDir, "recording-42")], "trash"),
			).resolves.toEqual({ success: true });

			expect(trashItem).toHaveBeenCalledTimes(2);
			await expect(fs.access(video)).rejects.toThrow();
			await expect(fs.access(other)).resolves.toBeUndefined();
			expect(
				await findMediaLinksByFingerprint(recordingsDir, path.join(root, "probe.mp4")),
			).toBeNull();
		});

		it("refuses an id outside the recordings folders and deletes nothing", async () => {
			const outside = path.join(root, "recording-42.mp4");
			await fs.writeFile(outside, "video");

			await expect(
				service().deleteRecordings([path.join(root, "recording-42")], "permanent"),
			).resolves.toMatchObject({ success: false, trashFailed: false });
			await expect(fs.access(outside)).resolves.toBeUndefined();
		});

		it("keeps the links of files the Trash refused, then deletes them permanently", async () => {
			await fs.writeFile(path.join(root, "probe.mp4"), "video");
			trashItem.mockRejectedValueOnce(new Error("no trash on this filesystem"));
			const id = path.join(recordingsDir, "recording-42");

			await expect(service().deleteRecordings([id], "trash")).resolves.toMatchObject({
				success: false,
				trashFailed: true,
			});
			await expect(fs.access(video)).resolves.toBeUndefined();
			expect(
				await findMediaLinksByFingerprint(recordingsDir, path.join(root, "probe.mp4")),
			).not.toBeNull();

			await expect(service().deleteRecordings([id], "permanent")).resolves.toEqual({
				success: true,
			});
			await expect(fs.access(video)).rejects.toThrow();
			await expect(fs.access(cursor)).rejects.toThrow();
		});
	});
});
