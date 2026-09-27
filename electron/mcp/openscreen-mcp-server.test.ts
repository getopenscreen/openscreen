// End-to-end over real HTTP: the SDK's own client against the server on an
// ephemeral port, with an in-memory stand-in for the editor window.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AxcutDocument,
	createEmptyDocument,
	documentSchema,
} from "../../src/lib/ai-edition/schema";
import { OPENSCREEN_TOOL_NAMES } from "../ai-edition/agent-tools";
import { TOOL_DESCRIPTIONS } from "../ai-edition/deep-agent/service";
import {
	MCP_ENDPOINT_PATH,
	type McpApplyResult,
	type McpDocumentHost,
	type RunningMcpServer,
	startMcpHttpServer,
} from "./openscreen-mcp-server";

const TOKEN = "test-token-0123456789";

function fixtureDocument(): AxcutDocument {
	const base = createEmptyDocument({
		title: "Test",
		projectId: "proj_1",
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

afterEach(async () => {
	await client?.close();
	await running?.close();
	client = null;
	running = null;
});

async function connect(
	editor: FakeEditor,
	options: { editsAllowed?: boolean; headers?: Record<string, string> } = {},
) {
	running = await startMcpHttpServer({
		port: 0,
		token: TOKEN,
		deps: { host: editor, editsAllowed: () => options.editsAllowed ?? true, version: "0.0.0" },
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
	it("is exactly the in-app agent's tools, with its descriptions", async () => {
		const mcp = await connect(new FakeEditor());
		const { tools } = await mcp.listTools();
		expect(tools.map((t) => t.name)).toEqual([
			...OPENSCREEN_TOOL_NAMES,
			"createCheckpoint",
			"restoreCheckpoint",
		]);
		for (const tool of tools.slice(0, OPENSCREEN_TOOL_NAMES.length)) {
			expect(tool.description).toBe(TOOL_DESCRIPTIONS[tool.name]);
			expect(tool.inputSchema.type).toBe("object");
		}
		// The zod schemas survive the trip to JSON Schema with their fields intact.
		const addTrim = tools.find((t) => t.name === "addTrim");
		expect(Object.keys(addTrim?.inputSchema.properties ?? {})).toEqual(
			expect.arrayContaining(["startSec", "endSec"]),
		);
		const removeFillerWords = tools.find((t) => t.name === "removeFillerWords");
		expect(Object.keys(removeFillerWords?.inputSchema.properties ?? {})).toEqual(
			expect.arrayContaining(["assetId", "wordIds"]),
		);
	});

	it("marks reads read-only and deletions destructive", async () => {
		const mcp = await connect(new FakeEditor());
		const { tools } = await mcp.listTools();
		const byName = new Map(tools.map((t) => [t.name, t.annotations]));
		expect(byName.get("getCurrentDocument")?.readOnlyHint).toBe(true);
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
			name: "removeFillerWords",
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
			name: "removeFillerWords",
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
			name: "removeFillerWords",
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

describe("the HTTP guard", () => {
	async function post(headers: Record<string, string>, path = MCP_ENDPOINT_PATH) {
		running = await startMcpHttpServer({
			port: 0,
			token: TOKEN,
			deps: { host: new FakeEditor(), editsAllowed: () => true, version: "0.0.0" },
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
