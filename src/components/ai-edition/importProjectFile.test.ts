import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AxcutDocument, createEmptyDocument } from "@/lib/ai-edition/schema";
import { DocumentService } from "../../../electron/ai-edition/document-service";
import { importProjectFile } from "./importProjectFile";

// The bridge's save is the main process's: the real DocumentService, on a temp folder.
const bridge = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("@/native", () => ({ nativeBridgeClient: { aiEdition: bridge } }));

describe("importProjectFile", () => {
	let projectsDir: string;
	let otherDir: string;
	let service: DocumentService;

	beforeEach(async () => {
		projectsDir = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-projects-"));
		otherDir = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-elsewhere-"));
		service = new DocumentService(projectsDir, otherDir);
		bridge.save.mockImplementation(async (doc: AxcutDocument) => ({
			success: true,
			document: await service.saveProject(doc),
		}));
	});

	afterEach(async () => {
		await fs.rm(projectsDir, { recursive: true, force: true });
		await fs.rm(otherDir, { recursive: true, force: true });
	});

	it("keeps an MCP edit made between the dialog reading a project's own file and opening it", async () => {
		const created = await service.createProject("As read");
		const file = path.join(projectsDir, `${created.project.id}.openscreen`);
		const read: unknown = JSON.parse(await fs.readFile(file, "utf8"));

		const { document, version } = await service.getProjectForUpdate(created.project.id);
		const edited = { ...document, project: { ...document.project, title: "Edited over MCP" } };
		expect(await service.saveProjectIfUnchanged(edited, version)).not.toBeNull();

		const { projectId } = await importProjectFile(read, service.storedProjectId(file));

		expect(projectId).toBe(created.project.id);
		expect((await service.getProject(projectId)).project.title).toBe("Edited over MCP");
	});

	it("saves a file from outside the projects folder as a project", async () => {
		const doc = createEmptyDocument({ projectId: "proj_imported", title: "Imported" });
		const file = path.join(otherDir, "proj_imported.openscreen");

		const { projectId } = await importProjectFile(doc, service.storedProjectId(file));

		expect((await service.getProject(projectId)).project.title).toBe("Imported");
	});
});
