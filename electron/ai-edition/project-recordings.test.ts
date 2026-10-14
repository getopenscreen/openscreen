import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentService } from "./document-service";
import { findProjectRecordings, removeRecordingSets } from "./project-recordings";

async function touch(filePath: string, content = "x"): Promise<string> {
	await fs.writeFile(filePath, content);
	return filePath;
}

describe("project recordings", () => {
	let root: string;
	let recordingsDir: string;
	let elsewhere: string;
	let documents: DocumentService;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-project-recordings-"));
		recordingsDir = path.join(root, "recordings");
		elsewhere = path.join(root, "Desktop");
		await fs.mkdir(recordingsDir);
		await fs.mkdir(elsewhere);
		documents = new DocumentService(path.join(root, "projects"), root);
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	async function projectWith(title: string, ...videoPaths: string[]): Promise<string> {
		const doc = await documents.createProject(title);
		for (const videoPath of videoPaths) {
			await documents.addAsset(doc.project.id, {
				path: videoPath,
				label: path.basename(videoPath),
			});
		}
		return doc.project.id;
	}

	it("owns every file recorded beside the screen video", async () => {
		const video = await touch(path.join(recordingsDir, "recording-12.mp4"), "12345");
		const companions = [
			await touch(`${video}.cursor.json`),
			await touch(path.join(recordingsDir, "recording-12.session.json")),
			await touch(path.join(recordingsDir, "recording-12-webcam.webm")),
		];
		await touch(path.join(recordingsDir, "recording-123.mp4"));
		const id = await projectWith("Mine", video);

		const { owned, keptFor } = await findProjectRecordings(id, await documents.readAllProjects(), [
			recordingsDir,
		]);

		expect(owned).toHaveLength(1);
		expect(owned[0].files.sort()).toEqual([video, ...companions].sort());
		expect(owned[0].sizeBytes).toBe(5 + 3);
		expect(keptFor).toEqual([]);
	});

	it("keeps a recording another project uses, and names that project", async () => {
		const shared = await touch(path.join(recordingsDir, "recording-1.mp4"));
		const own = await touch(path.join(recordingsDir, "recording-2.mp4"));
		const id = await projectWith("Mine", shared, own);
		await projectWith("Demo v2", shared);

		const { owned, keptFor } = await findProjectRecordings(id, await documents.readAllProjects(), [
			recordingsDir,
		]);

		expect(owned.map((set) => set.stem)).toEqual(["recording-2"]);
		expect(keptFor).toEqual(["Demo v2"]);
	});

	it("never owns a video outside the recordings folders", async () => {
		const imported = await touch(path.join(elsewhere, "recording-5.mp4"));
		const id = await projectWith("Imported", imported);

		const { owned } = await findProjectRecordings(id, await documents.readAllProjects(), [
			recordingsDir,
		]);

		expect(owned).toEqual([]);
	});

	it("trashes each file, or removes it for good when asked", async () => {
		const video = await touch(path.join(recordingsDir, "recording-7.mp4"));
		const cursor = await touch(`${video}.cursor.json`);
		const id = await projectWith("Mine", video);
		const { owned } = await findProjectRecordings(id, await documents.readAllProjects(), [
			recordingsDir,
		]);

		const trashItem = vi.fn(async (_filePath: string) => {});
		await removeRecordingSets(owned, "trash", trashItem);
		expect(trashItem.mock.calls.map(([p]) => p).sort()).toEqual([video, cursor].sort());
		await expect(fs.access(video)).resolves.toBeUndefined();

		await removeRecordingSets(owned, "permanent", trashItem);
		await expect(fs.access(video)).rejects.toThrow();
		await expect(fs.access(cursor)).rejects.toThrow();
	});
});
