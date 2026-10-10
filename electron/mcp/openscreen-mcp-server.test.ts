// End-to-end over real HTTP: the SDK's own client against the server on an
// ephemeral port, with an in-memory stand-in for the editor window and a real
// DocumentService on a temp directory for the projects that are not open.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AxcutDocument,
	createEmptyDocument,
	documentSchema,
} from "../../src/lib/ai-edition/schema";
import { OPENSCREEN_TOOL_NAMES } from "../ai-edition/agent-tools";
import { TOOL_DESCRIPTIONS } from "../ai-edition/deep-agent/service";
import { DocumentService } from "../ai-edition/document-service";
import {
	LIST_PROJECTS_TOOL,
	MCP_ENDPOINT_PATH,
	type McpApplyResult,
	type McpDocumentHost,
	type RunningMcpServer,
	startMcpHttpServer,
} from "./openscreen-mcp-server";

const TOKEN = "test-token-0123456789";

function fixtureDocument(projectId = "proj_1"): AxcutDocument {
	const base = createEmptyDocument({
		title: `Test ${projectId}`,
		projectId,
		createdAt: "2026-01-01T00:00:00.000Z",
	});
	return documentSchema.parse({
		...base,
		project: { ...base.project, primaryAssetId: "asset_1" },
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "Recording",
				originalPath: "/tmp/rec.mp4",
				durationSec: 30,
			},
		],
		timeline: {
			...base.timeline,
			clips: [
				{
					id: "clip_1",
					assetId: "asset_1",
					sourceStartSec: 0,
					sourceEndSec: 30,
					timelineStartSec: 0,
					timelineEndSec: 30,
					wordRefs: [],
					origin: "user",
					reason: "",
				},
			],
		},
	});
}

/** The editor window, reduced to a document and the revision guarding it. */
class FakeEditor implements McpDocumentHost {
	document: AxcutDocument | null = fixtureDocument();
	revision = 1;
	applied: AxcutDocument[] = [];
	/** Runs between the snapshot and the apply — where a user edit would land. */
	onSnapshot?: () => void;

	async snapshot() {
		if (!this.document) return null;
		const snapshot = { document: structuredClone(this.document), revision: this.revision };
		this.onSnapshot?.();
		return snapshot;
	}

	async apply(document: AxcutDocument, expectedRevision: number): Promise<McpApplyResult> {
		if (!this.document) return "no-live-document";
		if (expectedRevision !== this.revision) return "conflict";
		this.document = document;
		this.revision += 1;
		this.applied.push(document);
		return "applied";
	}
}

function fillerEditor(): FakeEditor {
	const editor = new FakeEditor();
	editor.document = documentSchema.parse({
		...editor.document,
		transcripts: [
			{
				assetId: "asset_1",
				language: "en",
				segments: [
					{
						id: "seg_1",
						kind: "speech",
						startSec: 0,
						endSec: 5,
						text: "like I like",
						wordIds: ["filler", "meaningful"],
					},
				],
				words: [
					{ id: "filler", segmentId: "seg_1", startSec: 1, endSec: 1.2, text: "like" },
					{ id: "meaningful", segmentId: "seg_1", startSec: 3, endSec: 3.2, text: "like" },
				],
			},
		],
	});
	return editor;
}

let running: RunningMcpServer | null = null;
let client: Client | null = null;
let dir: string;
let projects: DocumentService;

beforeEach(() => {
	dir = mkdtempSync(path.join(os.tmpdir(), "openscreen-mcp-projects-"));
	projects = new DocumentService(path.join(dir, "projects"), dir);
});

afterEach(async () => {
	await client?.close();
	await running?.close();
	client = null;
	running = null;
	rmSync(dir, { recursive: true, force: true });
});

async function connect(
	editor: FakeEditor,
	options: { editsAllowed?: boolean; headers?: Record<string, string> } = {},
) {
	running = await startMcpHttpServer({
		port: 0,
		token: TOKEN,
		deps: {
			host: editor,
			projects,
			editsAllowed: () => options.editsAllowed ?? true,
			version: "0.0.0",
		},
	});
	client = new Client({ name: "test", version: "0.0.0" });
	const url = new URL(`http://127.0.0.1:${running.port}${MCP_ENDPOINT_PATH}`);
	await client.connect(
		new StreamableHTTPClientTransport(url, {
			requestInit: { headers: options.headers ?? { Authorization: `Bearer ${TOKEN}` } },
		}),
	);
	return client;
}

function resultText(result: Awaited<ReturnType<Client["callTool"]>>): string {
	const content = result.content as Array<{ type: string; text?: string }>;
	return content.map((part) => part.text ?? "").join("");
}

describe("the MCP tool surface", () => {
	it("is listProjects, then exactly the in-app agent's tools with its descriptions, then the checkpoints", async () => {
		const mcp = await connect(new FakeEditor());
		const { tools } = await mcp.listTools();
		expect(tools.map((t) => t.name)).toEqual([
			LIST_PROJECTS_TOOL,
			...OPENSCREEN_TOOL_NAMES,
			"createCheckpoint",
			"restoreCheckpoint",
		]);
		for (const tool of tools.slice(1, 1 + OPENSCREEN_TOOL_NAMES.length)) {
			expect(tool.description).toBe(TOOL_DESCRIPTIONS[tool.name]);
			expect(tool.inputSchema.type).toBe("object");
			expect(Object.keys(tool.inputSchema.properties ?? {})).toContain("projectId");
			expect(tool.inputSchema.required ?? []).not.toContain("projectId");
		}
		for (const tool of tools.slice(-2)) {
			expect(Object.keys(tool.inputSchema.properties ?? {})).toContain("projectId");
		}
		// The zod schemas survive the trip to JSON Schema with their fields intact.
		const addTrim = tools.find((t) => t.name === "addTrim");
		expect(Object.keys(addTrim?.inputSchema.properties ?? {})).toEqual(
			expect.arrayContaining(["startSec", "endSec"]),
		);
		const removeWords = tools.find((t) => t.name === "removeWords");
		expect(Object.keys(removeWords?.inputSchema.properties ?? {})).toEqual(
			expect.arrayContaining(["assetId", "wordIds"]),
		);
	});

	it("marks reads read-only and deletions destructive", async () => {
		const mcp = await connect(new FakeEditor());
		const { tools } = await mcp.listTools();
		const byName = new Map(tools.map((t) => [t.name, t.annotations]));
		expect(byName.get("getCurrentDocument")?.readOnlyHint).toBe(true);
		expect(byName.get(LIST_PROJECTS_TOOL)?.readOnlyHint).toBe(true);
		expect(byName.get("addTrim")?.readOnlyHint).toBe(false);
		expect(byName.get("removeClip")?.destructiveHint).toBe(true);
		expect(byName.get("createCheckpoint")?.readOnlyHint).toBe(true);
		expect(byName.get("restoreCheckpoint")?.destructiveHint).toBe(true);
	});

	it("hands the client the in-app agent's guidance as server instructions", async () => {
		const mcp = await connect(new FakeEditor());
		expect(mcp.getInstructions()).toContain("Time-bases (do not mix them up)");
	});
});

describe("calling a tool", () => {
	it("cuts the selected filler occurrence through the shared tool surface", async () => {
		const editor = fillerEditor();
		const mcp = await connect(editor);
		const result = await mcp.callTool({
			name: "removeWords",
			arguments: { wordIds: ["filler"] },
		});
		expect(result.isError).toBeFalsy();
		expect(editor.applied).toHaveLength(1);
		const trim = editor.document?.timeline.trimRanges.at(-1);
		expect(trim).toMatchObject({ assetId: "asset_1", clipId: "clip_1", origin: "agent" });
		expect(trim?.endSec).toBeLessThan(3);
		expect(JSON.parse(resultText(result)).removed[0]).toMatchObject({
			wordId: "filler",
			trimRangeId: trim?.id,
			startSec: trim?.startSec,
			endSec: trim?.endSec,
		});
	});

	it("keeps the asset qualifier when MCP words have duplicate IDs across recordings", async () => {
		const editor = fillerEditor();
		const before = editor.document as AxcutDocument;
		before.assets.push({ ...before.assets[0], id: "asset_2" });
		before.timeline.clips.push({ ...before.timeline.clips[0], id: "clip_2", assetId: "asset_2" });
		before.transcripts.push({ ...before.transcripts[0], assetId: "asset_2" });
		const mcp = await connect(editor);
		const result = await mcp.callTool({
			name: "removeWords",
			arguments: { assetId: "asset_2", wordIds: ["filler"] },
		});
		expect(result.isError).toBeFalsy();
		expect(editor.applied).toHaveLength(1);
		expect(editor.document?.timeline.trimRanges).toHaveLength(1);
		expect(editor.document?.timeline.trimRanges[0]).toMatchObject({
			assetId: "asset_2",
			clipId: "clip_2",
		});
	});

	it("refuses filler removal when MCP project edits are disabled", async () => {
		const editor = fillerEditor();
		const before = editor.document;
		const mcp = await connect(editor, { editsAllowed: false });
		const result = await mcp.callTool({
			name: "removeWords",
			arguments: { wordIds: ["filler"] },
		});
		expect(result.isError).toBe(true);
		expect(resultText(result)).toMatch(/consent_required/);
		expect(editor.document).toBe(before);
		expect(editor.applied).toHaveLength(0);
	});
	it("reads the live editor document", async () => {
		const mcp = await connect(new FakeEditor());
		const result = await mcp.callTool({ name: "getCurrentDocument", arguments: {} });
		expect(result.isError).toBeFalsy();
		expect(resultText(result)).toContain("clip_1");
	});

	it("applies an edit to the editor, against the revision it read", async () => {
		const editor = new FakeEditor();
		const mcp = await connect(editor);
		const result = await mcp.callTool({
			name: "addTrim",
			arguments: { assetId: "asset_1", startSec: 5, endSec: 6 },
		});
		expect(result.isError).toBeFalsy();
		expect(editor.applied).toHaveLength(1);
		expect(editor.document?.timeline.trimRanges).toHaveLength(1);
		expect(editor.revision).toBe(2);
	});

	it("does not touch the editor for a read", async () => {
		const editor = new FakeEditor();
		const mcp = await connect(editor);
		await mcp.callTool({ name: "getTranscript", arguments: {} });
		expect(editor.applied).toHaveLength(0);
	});

	it("refuses a write when the user has turned project edits off", async () => {
		const editor = new FakeEditor();
		const mcp = await connect(editor, { editsAllowed: false });
		const result = await mcp.callTool({
			name: "addTrim",
			arguments: { assetId: "asset_1", startSec: 5, endSec: 6 },
		});
		expect(result.isError).toBe(true);
		expect(editor.applied).toHaveLength(0);
	});

	it("reports a conflict instead of overwriting a user edit made mid-call", async () => {
		const editor = new FakeEditor();
		editor.onSnapshot = () => {
			editor.revision += 1;
		};
		const mcp = await connect(editor);
		const result = await mcp.callTool({
			name: "addTrim",
			arguments: { assetId: "asset_1", startSec: 5, endSec: 6 },
		});
		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain("NOT applied");
		expect(editor.applied).toHaveLength(0);
	});

	it("says so when no project is open", async () => {
		const editor = new FakeEditor();
		editor.document = null;
		const mcp = await connect(editor);
		const result = await mcp.callTool({ name: "getCurrentDocument", arguments: {} });
		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain("No project is open");
	});
});

describe("checkpoints", () => {
	async function checkpoint(mcp: Client): Promise<string> {
		const result = await mcp.callTool({ name: "createCheckpoint", arguments: {} });
		expect(result.isError).toBeFalsy();
		return JSON.parse(resultText(result)).checkpointId;
	}

	function addTrim(mcp: Client, startSec: number) {
		return mcp.callTool({
			name: "addTrim",
			arguments: { assetId: "asset_1", startSec, endSec: startSec + 1 },
		});
	}

	it("reverts several edits in one apply", async () => {
		const editor = new FakeEditor();
		const before = structuredClone(editor.document);
		const mcp = await connect(editor);
		const checkpointId = await checkpoint(mcp);
		expect(editor.applied).toHaveLength(0);
		await addTrim(mcp, 5);
		await addTrim(mcp, 10);
		expect(editor.document?.timeline.trimRanges).toHaveLength(2);

		const result = await mcp.callTool({ name: "restoreCheckpoint", arguments: { checkpointId } });
		expect(result.isError).toBeFalsy();
		expect(editor.applied).toHaveLength(3);
		expect(editor.document).toEqual(before);
	});

	it("refuses to restore when the user has turned project edits off", async () => {
		const editor = new FakeEditor();
		const mcp = await connect(editor, { editsAllowed: false });
		const checkpointId = await checkpoint(mcp);
		const result = await mcp.callTool({ name: "restoreCheckpoint", arguments: { checkpointId } });
		expect(result.isError).toBe(true);
		expect(editor.applied).toHaveLength(0);
	});

	it("refuses an unknown checkpoint", async () => {
		const editor = new FakeEditor();
		const mcp = await connect(editor);
		const result = await mcp.callTool({
			name: "restoreCheckpoint",
			arguments: { checkpointId: "cp_nope" },
		});
		expect(result.isError).toBe(true);
		expect(editor.applied).toHaveLength(0);
	});

	it("never restores one project's checkpoint over another project", async () => {
		const editor = new FakeEditor();
		const mcp = await connect(editor);
		const checkpointId = await checkpoint(mcp);
		const other = fixtureDocument();
		editor.document = { ...other, project: { ...other.project, id: "proj_2" } };
		const result = await mcp.callTool({ name: "restoreCheckpoint", arguments: { checkpointId } });
		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain("another project");
		expect(editor.applied).toHaveLength(0);
	});
});

describe("projects other than the open one", () => {
	const addTrimArgs = { assetId: "asset_1", startSec: 5, endSec: 6 };

	/** An edit to a project that is not open is refused until it has one. */
	async function checkpoint(mcp: Client, projectId: string): Promise<string> {
		const result = await mcp.callTool({ name: "createCheckpoint", arguments: { projectId } });
		expect(result.isError).toBeFalsy();
		return JSON.parse(resultText(result)).checkpointId;
	}

	/** Runs `during` right after the next call has read its project from disk. */
	function onNextRead(during: () => unknown) {
		const getProjectForUpdate = projects.getProjectForUpdate.bind(projects);
		projects.getProjectForUpdate = async (id) => {
			projects.getProjectForUpdate = getProjectForUpdate;
			const read = await getProjectForUpdate(id);
			await during();
			return read;
		};
	}

	it("lists every project and flags the one open in the editor", async () => {
		await projects.saveProject(fixtureDocument("proj_1"));
		await projects.saveProject(fixtureDocument("proj_2"));
		const mcp = await connect(new FakeEditor());
		const result = await mcp.callTool({ name: LIST_PROJECTS_TOOL, arguments: {} });
		expect(result.isError).toBeFalsy();
		const listed = JSON.parse(resultText(result)).projects as Array<{ id: string; open: boolean }>;
		expect(listed.map((p) => [p.id, p.open]).sort()).toEqual([
			["proj_1", true],
			["proj_2", false],
		]);
	});

	it("reads a project that is not open", async () => {
		await projects.saveProject(fixtureDocument("proj_2"));
		const mcp = await connect(new FakeEditor());
		const result = await mcp.callTool({
			name: "getCurrentDocument",
			arguments: { projectId: "proj_2" },
		});
		expect(result.isError).toBeFalsy();
		expect(resultText(result)).toContain("Test proj_2");
	});

	it("saves an edit to the project's file and leaves the editor alone", async () => {
		await projects.saveProject(fixtureDocument("proj_2"));
		const editor = new FakeEditor();
		const mcp = await connect(editor);
		await checkpoint(mcp, "proj_2");
		const result = await mcp.callTool({
			name: "addTrim",
			arguments: { ...addTrimArgs, projectId: "proj_2" },
		});
		expect(result.isError).toBeFalsy();
		expect((await projects.getProject("proj_2")).timeline.trimRanges).toHaveLength(1);
		expect(editor.applied).toHaveLength(0);
		expect(editor.document?.timeline.trimRanges).toHaveLength(0);
	});

	it("edits a project with no editor open at all", async () => {
		await projects.saveProject(fixtureDocument("proj_2"));
		const editor = new FakeEditor();
		editor.document = null;
		const mcp = await connect(editor);
		await checkpoint(mcp, "proj_2");
		const result = await mcp.callTool({
			name: "addTrim",
			arguments: { ...addTrimArgs, projectId: "proj_2" },
		});
		expect(result.isError).toBeFalsy();
		expect((await projects.getProject("proj_2")).timeline.trimRanges).toHaveLength(1);
	});

	it("routes the open project's id through the editor, never its file", async () => {
		await projects.saveProject(fixtureDocument("proj_1"));
		const editor = new FakeEditor();
		const mcp = await connect(editor);
		const result = await mcp.callTool({
			name: "addTrim",
			arguments: { ...addTrimArgs, projectId: "proj_1" },
		});
		expect(result.isError).toBeFalsy();
		expect(editor.applied).toHaveLength(1);
		expect((await projects.getProject("proj_1")).timeline.trimRanges).toHaveLength(0);
	});

	it("reports a user edit made mid-call on the open project's id as a conflict", async () => {
		await projects.saveProject(fixtureDocument("proj_1"));
		const editor = new FakeEditor();
		editor.onSnapshot = () => {
			editor.revision += 1;
		};
		const mcp = await connect(editor);
		const result = await mcp.callTool({
			name: "addTrim",
			arguments: { ...addTrimArgs, projectId: "proj_1" },
		});
		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain("NOT applied");
		expect(editor.applied).toHaveLength(0);
		expect((await projects.getProject("proj_1")).timeline.trimRanges).toHaveLength(0);
	});

	it("names listProjects for an unknown id", async () => {
		const mcp = await connect(new FakeEditor());
		const result = await mcp.callTool({
			name: "getCurrentDocument",
			arguments: { projectId: "proj_missing" },
		});
		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain("listProjects");
	});

	it("refuses a write when edits are off", async () => {
		await projects.saveProject(fixtureDocument("proj_2"));
		const mcp = await connect(new FakeEditor(), { editsAllowed: false });
		const result = await mcp.callTool({
			name: "addTrim",
			arguments: { ...addTrimArgs, projectId: "proj_2" },
		});
		expect(result.isError).toBe(true);
		expect((await projects.getProject("proj_2")).timeline.trimRanges).toHaveLength(0);
	});

	it("refuses an edit until the project has a checkpoint, its only undo", async () => {
		await projects.saveProject(fixtureDocument("proj_2"));
		const mcp = await connect(new FakeEditor());
		const result = await mcp.callTool({
			name: "addTrim",
			arguments: { ...addTrimArgs, projectId: "proj_2" },
		});
		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain("createCheckpoint");
		expect((await projects.getProject("proj_2")).timeline.trimRanges).toHaveLength(0);
	});

	it("reverts a series of edits to its file in one restore", async () => {
		await projects.saveProject(fixtureDocument("proj_2"));
		const before = await projects.getProject("proj_2");
		const editor = new FakeEditor();
		const mcp = await connect(editor);
		const checkpointId = await checkpoint(mcp, "proj_2");
		for (const startSec of [5, 10]) {
			await mcp.callTool({
				name: "addTrim",
				arguments: { assetId: "asset_1", startSec, endSec: startSec + 1, projectId: "proj_2" },
			});
		}
		expect((await projects.getProject("proj_2")).timeline.trimRanges).toHaveLength(2);

		const result = await mcp.callTool({
			name: "restoreCheckpoint",
			arguments: { checkpointId, projectId: "proj_2" },
		});
		expect(result.isError).toBeFalsy();
		const after = await projects.getProject("proj_2");
		expect(after.timeline).toEqual(before.timeline);
		expect(editor.applied).toHaveLength(0);
	});

	it("names the projectId a closed project's checkpoint needs, and restores nothing without it", async () => {
		await projects.saveProject(fixtureDocument("proj_2"));
		const editor = new FakeEditor();
		const mcp = await connect(editor);
		const checkpointId = await checkpoint(mcp, "proj_2");
		const result = await mcp.callTool({ name: "restoreCheckpoint", arguments: { checkpointId } });
		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain('"proj_2"');
		expect(editor.applied).toHaveLength(0);
	});

	// The editor was already reading the file when the call came in, and installs what
	// it read as soon as that read returns.
	it("waits out an editor open already under way, then edits through the editor", async () => {
		await projects.saveProject(fixtureDocument("proj_2"));
		const editor = new FakeEditor();
		const mcp = await connect(editor);
		await checkpoint(mcp, "proj_2");
		const readFile = fsPromises.readFile;
		const slowRead = vi.spyOn(fsPromises, "readFile").mockImplementationOnce((async (
			...args: Parameters<typeof readFile>
		) => {
			await new Promise((resolve) => setTimeout(resolve, 100));
			return readFile(...args);
		}) as typeof readFile);
		const opening = projects.getProject("proj_2").then((document) => {
			editor.document = document;
		});
		const result = await mcp.callTool({
			name: "addTrim",
			arguments: { ...addTrimArgs, projectId: "proj_2" },
		});
		await opening;
		slowRead.mockRestore();
		expect(result.isError).toBeFalsy();
		// The editor holds the project now, so the edit has to be in its copy.
		expect(editor.applied).toHaveLength(1);
		expect(editor.document?.timeline.trimRanges).toHaveLength(1);
	});

	// The editor's open has read the file but not yet installed it, so it does not
	// show in a snapshot: only the read itself gives it away.
	it("does not save over a project the editor is opening mid-call", async () => {
		await projects.saveProject(fixtureDocument("proj_2"));
		const mcp = await connect(new FakeEditor());
		await checkpoint(mcp, "proj_2");
		onNextRead(() => projects.getProject("proj_2"));
		const result = await mcp.callTool({
			name: "addTrim",
			arguments: { ...addTrimArgs, projectId: "proj_2" },
		});
		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain("NOT applied");
		expect((await projects.getProject("proj_2")).timeline.trimRanges).toHaveLength(0);
	});

	it("does not save over a project saved elsewhere mid-call, even in the same millisecond", async () => {
		const saved = await projects.saveProject(fixtureDocument("proj_2"));
		const mcp = await connect(new FakeEditor());
		await checkpoint(mcp, "proj_2");
		onNextRead(() =>
			projects.saveProject({ ...saved, project: { ...saved.project, title: "Renamed" } }),
		);
		const result = await mcp.callTool({
			name: "addTrim",
			arguments: { ...addTrimArgs, projectId: "proj_2" },
		});
		expect(result.isError).toBe(true);
		const onDisk = await projects.getProject("proj_2");
		expect(onDisk.project.title).toBe("Renamed");
		expect(onDisk.timeline.trimRanges).toHaveLength(0);
	});

	it("does not save over a change that kept the file's updatedAt", async () => {
		const saved = await projects.saveProject(fixtureDocument("proj_2"));
		const file = path.join(dir, "projects", "proj_2.openscreen");
		const mcp = await connect(new FakeEditor());
		await checkpoint(mcp, "proj_2");
		// A writer outside the app (a sync tool, a restored copy): same stamp, new content.
		onNextRead(() => {
			const renamed = { ...saved, project: { ...saved.project, title: "Renamed" } };
			writeFileSync(file, JSON.stringify(renamed));
		});
		const result = await mcp.callTool({
			name: "addTrim",
			arguments: { ...addTrimArgs, projectId: "proj_2" },
		});
		expect(result.isError).toBe(true);
		const onDisk = await projects.getProject("proj_2");
		expect(onDisk.project.title).toBe("Renamed");
		expect(onDisk.timeline.trimRanges).toHaveLength(0);
	});
});

describe("the HTTP guard", () => {
	async function post(headers: Record<string, string>, path = MCP_ENDPOINT_PATH) {
		running = await startMcpHttpServer({
			port: 0,
			token: TOKEN,
			deps: { host: new FakeEditor(), projects, editsAllowed: () => true, version: "0.0.0" },
		});
		return fetch(`http://127.0.0.1:${running.port}${path}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				...headers,
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
	}

	it("rejects a request without the token", async () => {
		expect((await post({})).status).toBe(401);
	});

	it("rejects a wrong token", async () => {
		expect((await post({ Authorization: "Bearer nope" })).status).toBe(401);
	});

	it("rejects a browser origin", async () => {
		const response = await post({
			Authorization: `Bearer ${TOKEN}`,
			Origin: "https://evil.example",
		});
		expect(response.status).toBe(403);
	});

	it("rejects any path but the endpoint", async () => {
		expect((await post({ Authorization: `Bearer ${TOKEN}` }, "/other")).status).toBe(404);
	});
});
