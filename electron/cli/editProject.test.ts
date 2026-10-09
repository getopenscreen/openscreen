import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	normalizeProjectEditor,
	PROJECT_VERSION,
} from "../../src/components/video-editor/projectPersistence";
import { migrateProjectDataToAxcutDocument } from "../../src/lib/ai-edition/document/migrate";
import { saveEditedProject } from "./editProject";

let root: string;
const document = () =>
	migrateProjectDataToAxcutDocument({
		version: PROJECT_VERSION,
		media: { screenVideoPath: path.join(root, "recording.mp4") },
		editor: normalizeProjectEditor({}),
	});

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-edit-test-"));
});
afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(root, { recursive: true, force: true });
});

describe("saveEditedProject", () => {
	it("saves the current document and creates output parents", async () => {
		const target = path.join(root, "output", "edited.openscreen");
		const doc = document();
		await saveEditedProject(target, doc);
		expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual(doc);
		expect(await fs.readdir(path.dirname(target))).toEqual(["edited.openscreen"]);
	});

	it("replaces an earlier project only after the complete new file is written", async () => {
		const target = path.join(root, "original.openscreen");
		await fs.writeFile(target, "earlier project");
		const rename = fs.rename.bind(fs);
		// Stable ids/timestamps: use one document for the write and assertion.
		const doc = document();
		vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			expect(await fs.readFile(target, "utf8")).toBe("earlier project");
			expect(JSON.parse(await fs.readFile(from, "utf8"))).toEqual(doc);
			await rename(from, to);
		});
		await saveEditedProject(target, doc);
		expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual(doc);
	});

	it("rejects invalid documents without touching the existing output", async () => {
		const target = path.join(root, "original.openscreen");
		await fs.writeFile(target, "earlier project");
		await expect(saveEditedProject(target, {})).rejects.toThrow();
		expect(await fs.readFile(target, "utf8")).toBe("earlier project");
		expect(await fs.readdir(root)).toEqual(["original.openscreen"]);
	});

	it("retries a transient Windows file lock before publishing", async () => {
		const target = path.join(root, "edited.openscreen");
		const rename = fs.rename.bind(fs);
		const spy = vi
			.spyOn(fs, "rename")
			.mockRejectedValueOnce(Object.assign(new Error("File locked"), { code: "EBUSY" }))
			.mockImplementation(rename);
		await saveEditedProject(target, document());
		expect(spy).toHaveBeenCalledTimes(2);
		expect(await fs.readdir(root)).toEqual(["edited.openscreen"]);
	});

	it("preserves the destination and removes temporary files when publication fails", async () => {
		const target = path.join(root, "original.openscreen");
		await fs.writeFile(target, "earlier project");
		vi.spyOn(fs, "rename").mockRejectedValue(new Error("Disk error"));
		await expect(saveEditedProject(target, document())).rejects.toThrow("Disk error");
		expect(await fs.readFile(target, "utf8")).toBe("earlier project");
		expect(await fs.readdir(root)).toEqual(["original.openscreen"]);
	});
});
