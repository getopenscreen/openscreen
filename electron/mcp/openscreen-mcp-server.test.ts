// End-to-end over real HTTP: the SDK's own client against the server on an
// ephemeral port, with an in-memory stand-in for the editor window and a real
// DocumentService on a temp directory for the projects that are not open.

import { spawnSync } from "node:child_process";
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
import { createMediaTools } from "./media-tools";
import {
	LIST_PROJECTS_TOOL,
	MCP_ENDPOINT_PATH,
	type McpApplyResult,
	type McpDocumentHost,
	type McpToolDeps,
	mcpInstructions,
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
	options: {
		editsAllowed?: boolean;
		headers?: Record<string, string>;
		media?: Pick<McpToolDeps, "openVideo" | "approveMedia">;
	} = {},
) {
	const editsAllowed = () => options.editsAllowed ?? true;
	const deps = {
		transport: "http" as const,
		host: editor,
		projects,
		editsAllowed,
		version: "0.0.0",
		...options.media,
	};
	const unused = () => {
		throw new Error("not used by these tests");
	};
	running = await startMcpHttpServer({
		port: 0,
		token: TOKEN,
		deps,
		// As the app serves them; media-tools.test.ts calls them.
		media: createMediaTools({
			transport: "http",
			editsAllowed,
			recorder: { start: unused },
			runners: { start: unused },
			documents: projects,
			openVideo: unused,
			readCursor: unused,
			runTool: unused,
		}),
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
	it("edits layout passages through the same document operations and exposes their result", async () => {
		const editor = new FakeEditor();
		const mcp = await connect(editor);
		const changed = await mcp.callTool({
			name: "addLayoutChange",
			arguments: { timeSec: 5, preset: "no-webcam" },
		});
		expect(changed.isError).not.toBe(true);
		expect(editor.applied).toHaveLength(1);
		expect(editor.document?.layoutRegions?.some((r) => r.preset === "no-webcam")).toBe(true);
		const snapshot = await mcp.callTool({ name: "getCurrentDocument", arguments: {} });
		const segments = JSON.parse(resultText(snapshot)).layoutSegments;
		expect(
			segments.map((r: { startSec: number; preset: string }) => [r.startSec, r.preset]),
		).toEqual([
			[0, "picture-in-picture"],
			[5, "no-webcam"],
		]);
		const removed = await mcp.callTool({
			name: "removeModifier",
			arguments: { id: segments[1].id },
		});
		expect(removed.isError).not.toBe(true);
		expect(editor.document?.layoutRegions).toEqual([]);
		const { tools } = await mcp.listTools();
		expect(tools.map((t) => t.name)).toContain("moveLayoutBoundary");
		expect(tools.map((t) => t.name)).not.toContain("addCameraFullscreen");
	});

	it("is listProjects, then exactly the in-app agent's tools with its descriptions, then the checkpoints and the media tools", async () => {
		const mcp = await connect(new FakeEditor());
		const { tools } = await mcp.listTools();
		expect(tools.map((t) => t.name)).toEqual([
			LIST_PROJECTS_TOOL,
			...OPENSCREEN_TOOL_NAMES,
			"setProjectInfo",
			"importMedia",
			"removeMedia",
			"createCheckpoint",
			"restoreCheckpoint",
			// The same as `openscreen mcp` serves (#1174).
			"listSources",
			"startRecording",
			"stopRecording",
			"setPointerTrack",
			"exportVideo",
			"exportAudio",
			"getFrames",
			"createProject",
		]);
		for (const tool of tools.slice(1, 1 + OPENSCREEN_TOOL_NAMES.length)) {
			expect(tool.description).toBe(TOOL_DESCRIPTIONS[tool.name]);
			expect(tool.inputSchema.type).toBe("object");
			expect(Object.keys(tool.inputSchema.properties ?? {})).toContain("projectId");
			expect(tool.inputSchema.required ?? []).not.toContain("projectId");
		}
		for (const name of ["createCheckpoint", "restoreCheckpoint"]) {
			const tool = tools.find((t) => t.name === name);
			expect(Object.keys(tool?.inputSchema.properties ?? {})).toContain("projectId");
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
		expect(byName.get("removeMedia")?.destructiveHint).toBe(true);
		expect(byName.get("importMedia")?.readOnlyHint).toBe(false);
		expect(byName.get("createCheckpoint")?.readOnlyHint).toBe(true);
		expect(byName.get("restoreCheckpoint")?.destructiveHint).toBe(true);
	});

	it("hands the client the in-app agent's guidance as server instructions", async () => {
		const mcp = await connect(new FakeEditor());
		expect(mcp.getInstructions()).toContain("Time-bases (do not mix them up)");
	});

	it("tells the client what is true here: an editor, its undo, its recording bar, and its own switch", async () => {
		const mcp = await connect(new FakeEditor(), { editsAllowed: false });
		const instructions = mcp.getInstructions() ?? "";
		expect(instructions).toContain(
			"Without a projectId they act on the project open in the editor",
		);
		expect(instructions).toContain("startRecording hands over to OpenScreen's recording bar");
		expect(instructions).toContain(
			"startRecording, exportVideo, exportAudio and createProject are refused too",
		);
		expect(instructions).toContain("all of them are lost when OpenScreen quits.");
		expect(instructions).toContain("turn on 'MCP edits' under MCP server in AI settings");
		expect(instructions).not.toContain("Agent edits");
		const { tools } = await mcp.listTools();
		const restore = tools.find((t) => t.name === "restoreCheckpoint");
		expect(restore?.description).toContain("one undo step");
		expect(restore?.description).toContain("pointer track");
	});
});

describe("the instructions, composed per transport", () => {
	const media = "MEDIA BLOCK";
	it("puts the media block first, then the same checkpoint rule on both transports", () => {
		const stdio = mcpInstructions({ transport: "stdio", editsAllowed: true, media });
		const http = mcpInstructions({ transport: "http", editsAllowed: true, media });
		for (const instructions of [stdio, http]) {
			expect(instructions.startsWith(media)).toBe(true);
			expect(instructions).toContain("Before a series of edits, call createCheckpoint");
			expect(instructions).toContain("Time-bases (do not mix them up)");
			// Both export, so exporting is no example of a request without a tool.
			expect(instructions).not.toContain("exporting)");
		}
		// stdio reaches the editor only through the app.
		expect(stdio).not.toContain("Without a projectId they act");
		expect(stdio).toContain("While the OpenScreen app runs, this server hands each call to it");
		expect(stdio).toContain("in OpenScreen's memory while the app runs");
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
		// The MCP server's switch, not the in-app agent's.
		expect(resultText(result)).toContain("'MCP edits' under MCP server in AI settings");
		expect(resultText(result)).not.toContain("Agent edits");
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
		expect(resultText(result)).toContain("'MCP edits'");
		expect(editor.applied).toHaveLength(0);
	});

	it("refuses an unknown checkpoint, saying when they are lost", async () => {
		const editor = new FakeEditor();
		const mcp = await connect(editor);
		const result = await mcp.callTool({
			name: "restoreCheckpoint",
			arguments: { checkpointId: "cp_nope" },
		});
		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain("lost when OpenScreen quits");
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

describe("the project's name and media", () => {
	function probe(durationSec = 12) {
		return vi.fn(async () => ({
			durationSec,
			width: 1920,
			height: 1080,
			close: () => undefined,
			capture: async () => ({ mimeType: "image/jpeg" as const, data: "" }),
		}));
	}

	function mediaFile(name: string): string {
		const file = path.join(dir, name);
		writeFileSync(file, "media");
		return file;
	}

	it("renames the open project through the editor, trimmed as the editor commits it", async () => {
		const editor = new FakeEditor();
		const mcp = await connect(editor);
		const result = await mcp.callTool({
			name: "setProjectInfo",
			arguments: { title: "  Launch demo " },
		});
		expect(result.isError).toBeFalsy();
		expect(editor.applied).toHaveLength(1);
		expect(editor.document?.project.title).toBe("Launch demo");

		const empty = await mcp.callTool({ name: "setProjectInfo", arguments: { title: "  " } });
		expect(empty.isError).toBe(true);
		expect(editor.applied).toHaveLength(1);
	});

	it("imports a video into the open project, measured and readable by the editor", async () => {
		const editor = new FakeEditor();
		const openVideo = probe();
		const approveMedia = vi.fn();
		const mcp = await connect(editor, { media: { openVideo, approveMedia } });
		const file = mediaFile("broll.mp4");
		const result = await mcp.callTool({ name: "importMedia", arguments: { path: file } });
		expect(result.isError).toBeFalsy();
		const { assetId, kind, durationSec } = JSON.parse(resultText(result));
		expect([kind, durationSec]).toEqual(["video", 12]);
		expect(editor.applied).toHaveLength(1);
		const asset = editor.document?.assets.find((a) => a.id === assetId);
		expect(asset).toMatchObject({ originalPath: file, label: "broll.mp4", durationSec: 12 });
		expect(asset?.video).toMatchObject({ width: 1920, height: 1080 });
		// The project already has its footage: an import never takes its place.
		expect(editor.document?.project.primaryAssetId).toBe("asset_1");
		expect(approveMedia).toHaveBeenCalledWith(file);
	});

	it("files an audio-only extension as audio, and still imports a file it cannot measure", async () => {
		const editor = new FakeEditor();
		const openVideo = vi.fn(async () => {
			throw new Error("media error 4");
		});
		const mcp = await connect(editor, { media: { openVideo } });
		const result = await mcp.callTool({
			name: "importMedia",
			arguments: { path: mediaFile("voice.mp3"), label: "Voiceover" },
		});
		expect(result.isError).toBeFalsy();
		expect(JSON.parse(resultText(result))).toMatchObject({
			kind: "audio",
			label: "Voiceover",
			durationSec: null,
		});
		expect(editor.document?.assets.at(-1)?.kind).toBe("audio");
	});

	it("refuses a relative, missing or unsupported path before probing anything", async () => {
		const editor = new FakeEditor();
		const openVideo = probe();
		const mcp = await connect(editor, { media: { openVideo } });
		for (const [filePath, says] of [
			["broll.mp4", "must be absolute"],
			[path.join(dir, "missing.mp4"), "No file"],
			[mediaFile("notes.txt"), "Unsupported video extension"],
		]) {
			const result = await mcp.callTool({ name: "importMedia", arguments: { path: filePath } });
			expect(result.isError).toBe(true);
			expect(resultText(result)).toContain(says);
		}
		expect(openVideo).not.toHaveBeenCalled();
		expect(editor.applied).toHaveLength(0);
	});

	it("imports nothing while MCP edits is off", async () => {
		const editor = new FakeEditor();
		const openVideo = probe();
		const mcp = await connect(editor, { editsAllowed: false, media: { openVideo } });
		const refused = await mcp.callTool({
			name: "importMedia",
			arguments: { path: mediaFile("ok.mp4") },
		});
		expect(refused.isError).toBe(true);
		expect(resultText(refused)).toContain("'MCP edits'");
		expect(openVideo).not.toHaveBeenCalled();
		expect(editor.applied).toHaveLength(0);
	});

	it("removes media only once the timeline no longer uses it", async () => {
		const editor = new FakeEditor();
		const mcp = await connect(editor, { media: { openVideo: probe() } });
		const inUse = await mcp.callTool({ name: "removeMedia", arguments: { assetId: "asset_1" } });
		expect(inUse.isError).toBe(true);
		expect(resultText(inUse)).toContain("clip_1 (removeClip)");
		expect(editor.applied).toHaveLength(0);

		const imported = await mcp.callTool({
			name: "importMedia",
			arguments: { path: mediaFile("unused.mov") },
		});
		const { assetId } = JSON.parse(resultText(imported));
		const removed = await mcp.callTool({ name: "removeMedia", arguments: { assetId } });
		expect(removed.isError).toBeFalsy();
		expect(editor.document?.assets.map((a) => a.id)).toEqual(["asset_1"]);
	});

	it("edits a project that is not open on its file, once it has a checkpoint", async () => {
		await projects.saveProject(fixtureDocument("proj_2"));
		const editor = new FakeEditor();
		const mcp = await connect(editor, { media: { openVideo: probe() } });
		const args = { projectId: "proj_2", path: mediaFile("music.wav") };
		const refused = await mcp.callTool({ name: "importMedia", arguments: args });
		expect(resultText(refused)).toContain("createCheckpoint");
		await mcp.callTool({ name: "createCheckpoint", arguments: { projectId: "proj_2" } });
		const result = await mcp.callTool({ name: "importMedia", arguments: args });
		expect(result.isError).toBeFalsy();
		await mcp.callTool({
			name: "setProjectInfo",
			arguments: { projectId: "proj_2", title: "Renamed" },
		});
		const saved = await projects.getProject("proj_2");
		expect(saved.assets.map((a) => a.kind)).toEqual(["video", "audio"]);
		expect(saved.project.title).toBe("Renamed");
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

// `openscreen mcp` beside an app that does not answer it (#1138; forwarding to one that
// does is app-channel.test.ts): this server's own editor holds nothing, the app's editor
// holds proj_2, and only the marker the app leaves says so.
describe("a project open in another process's editor", () => {
	const addTrimArgs = { assetId: "asset_1", startSec: 5, endSec: 6, projectId: "proj_2" };

	async function connectBesideTheApp(): Promise<Client> {
		await projects.saveProject(fixtureDocument("proj_2"));
		const editor = new FakeEditor();
		editor.document = null;
		const mcp = await connect(editor);
		const result = await mcp.callTool({
			name: "createCheckpoint",
			arguments: { projectId: "proj_2" },
		});
		expect(result.isError).toBeFalsy();
		return mcp;
	}

	/** The app's own DocumentService, on the same projects folder. */
	const theApp = () => new DocumentService(path.join(dir, "projects"), dir);

	it("lists it as open", async () => {
		const mcp = await connectBesideTheApp();
		theApp().markOpenInEditor("proj_2");
		const result = await mcp.callTool({ name: LIST_PROJECTS_TOOL, arguments: {} });
		const listed = JSON.parse(resultText(result)).projects as Array<{ id: string; open: boolean }>;
		expect(listed).toEqual([expect.objectContaining({ id: "proj_2", open: true })]);
	});

	it("refuses an edit to it, saying how to make one, and leaves its file alone", async () => {
		const mcp = await connectBesideTheApp();
		theApp().markOpenInEditor("proj_2");
		const result = await mcp.callTool({ name: "addTrim", arguments: addTrimArgs });
		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain("open in the OpenScreen editor");
		expect(resultText(result)).toContain("close the project in OpenScreen");
		expect((await projects.getProject("proj_2")).timeline.trimRanges).toHaveLength(0);
	});

	it("still reads it", async () => {
		const mcp = await connectBesideTheApp();
		theApp().markOpenInEditor("proj_2");
		const result = await mcp.callTool({
			name: "getCurrentDocument",
			arguments: { projectId: "proj_2" },
		});
		expect(result.isError).toBeFalsy();
	});

	it("edits it again once the editor lets go of it", async () => {
		const mcp = await connectBesideTheApp();
		const app = theApp();
		app.markOpenInEditor("proj_2");
		app.markOpenInEditor(null);
		const result = await mcp.callTool({ name: "addTrim", arguments: addTrimArgs });
		expect(result.isError).toBeFalsy();
		expect((await projects.getProject("proj_2")).timeline.trimRanges).toHaveLength(1);
	});

	it("is not blocked by the marker of an app that crashed", async () => {
		const mcp = await connectBesideTheApp();
		const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
		writeFileSync(
			path.join(dir, "projects", ".open-in-editor.json"),
			JSON.stringify({ pid: deadPid, projectId: "proj_2" }),
		);
		const result = await mcp.callTool({ name: "addTrim", arguments: addTrimArgs });
		expect(result.isError).toBeFalsy();
		expect((await projects.getProject("proj_2")).timeline.trimRanges).toHaveLength(1);
	});
});

describe("the HTTP guard", () => {
	async function post(headers: Record<string, string>, path = MCP_ENDPOINT_PATH) {
		running = await startMcpHttpServer({
			port: 0,
			token: TOKEN,
			deps: {
				transport: "http",
				host: new FakeEditor(),
				projects,
				editsAllowed: () => true,
				version: "0.0.0",
			},
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
