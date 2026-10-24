import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentService } from "./document-service";
import {
	findProjectRecordings,
	listRecordings,
	removeRecordingSets,
	resolveRecordingIds,
} from "./project-recordings";

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

		const { owned, keptFor } = await findProjectRecordings(
			id,
			await documents.readAllProjectsReport(),
			[recordingsDir],
		);

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

		const { owned, keptFor } = await findProjectRecordings(
			id,
			await documents.readAllProjectsReport(),
			[recordingsDir],
		);

		expect(owned.map((set) => set.stem)).toEqual(["recording-2"]);
		expect(keptFor).toEqual(["Demo v2"]);
	});

	it("keeps every recording while a project file does not parse", async () => {
		const video = await touch(path.join(recordingsDir, "recording-9.mp4"));
		const id = await projectWith("Mine", video);
		// Could be a project using recording-9: a newer schema, or a save cut short.
		await touch(path.join(root, "projects", "broken.openscreen"), "{ not json");

		const { owned, keptFor, unreadable } = await findProjectRecordings(
			id,
			await documents.readAllProjectsReport(),
			[recordingsDir],
		);

		expect(owned).toEqual([]);
		expect(keptFor).toEqual([]);
		expect(unreadable).toBe(1);
	});

	it("reports no unreadable projects when it has no recordings to keep", async () => {
		const imported = await touch(path.join(elsewhere, "clip.mp4"));
		const id = await projectWith("Imported", imported);
		await touch(path.join(root, "projects", "broken.openscreen"), "{ not json");

		const { unreadable } = await findProjectRecordings(
			id,
			await documents.readAllProjectsReport(),
			[recordingsDir],
		);

		expect(unreadable).toBe(0);
	});

	it("never owns a video outside the recordings folders", async () => {
		const imported = await touch(path.join(elsewhere, "recording-5.mp4"));
		const id = await projectWith("Imported", imported);

		const { owned } = await findProjectRecordings(id, await documents.readAllProjectsReport(), [
			recordingsDir,
		]);

		expect(owned).toEqual([]);
	});

	it("trashes each file, or removes it for good when asked", async () => {
		const video = await touch(path.join(recordingsDir, "recording-7.mp4"));
		const cursor = await touch(`${video}.cursor.json`);
		const id = await projectWith("Mine", video);
		const { owned } = await findProjectRecordings(id, await documents.readAllProjectsReport(), [
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

	describe("listing every take", () => {
		async function at(filePath: string, isoDate: string): Promise<string> {
			await touch(filePath);
			const when = new Date(isoDate);
			await fs.utimes(filePath, when, when);
			return filePath;
		}

		it("lists each take once with its files, newest first, and who uses it", async () => {
			const older = await at(path.join(recordingsDir, "recording-1.mp4"), "2026-01-01");
			await at(`${older}.cursor.json`, "2026-01-01");
			const newer = await at(path.join(recordingsDir, "recording-2.mp4"), "2026-02-01");
			await touch(path.join(recordingsDir, "media-links.registry.json"));
			await touch(path.join(recordingsDir, "notes.txt"));
			await projectWith("Demo", older);
			await projectWith("Demo v2", older);

			const { takes, unreadable } = await listRecordings(
				await documents.readAllProjectsReport(),
				// The same folder twice, as when the current folder is the default one.
				[recordingsDir, `${recordingsDir}${path.sep}`],
			);

			expect(takes.map((take) => take.stem)).toEqual(["recording-2", "recording-1"]);
			expect(takes[0].usedBy).toEqual([]);
			expect(takes[0].files).toEqual([newer]);
			expect(takes[1].usedBy.sort()).toEqual(["Demo", "Demo v2"]);
			expect(takes[1].files).toHaveLength(2);
			expect(takes[1].id).toBe(path.join(recordingsDir, "recording-1"));
			expect(unreadable).toBe(0);
		});

		it("counts project files that do not parse", async () => {
			await touch(path.join(recordingsDir, "recording-3.mp4"));
			await fs.mkdir(path.join(root, "projects"), { recursive: true });
			await touch(path.join(root, "projects", "broken.openscreen"), "{ not json");

			const { takes, unreadable } = await listRecordings(await documents.readAllProjectsReport(), [
				recordingsDir,
			]);

			expect(takes).toHaveLength(1);
			expect(unreadable).toBe(1);
		});

		it("skips a recordings folder that is gone", async () => {
			const { takes } = await listRecordings(await documents.readAllProjectsReport(), [
				path.join(root, "unplugged"),
			]);

			expect(takes).toEqual([]);
		});
	});

	describe("resolving the ids a delete names", () => {
		it("resolves a take in a recordings folder to its files", async () => {
			const video = await touch(path.join(recordingsDir, "recording-4.mp4"));

			const sets = await resolveRecordingIds(
				[path.join(recordingsDir, "recording-4")],
				[recordingsDir],
			);

			expect(sets.map((set) => set.files)).toEqual([[video]]);
		});

		it.each([
			["a take outside the recordings folders", () => path.join(elsewhere, "recording-4")],
			["a file name instead of a take", () => path.join(recordingsDir, "recording-4.mp4")],
			["something that is not a take", () => path.join(recordingsDir, "media-links")],
			["a path that climbs out", () => path.join(recordingsDir, "..", "recording-4")],
		])("refuses %s", async (_label, id) => {
			await touch(path.join(elsewhere, "recording-4.mp4"));
			await touch(path.join(root, "recording-4.mp4"));

			await expect(resolveRecordingIds([id()], [recordingsDir])).rejects.toThrow(/Not a recording/);
		});
	});
});
