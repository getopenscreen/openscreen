// `openscreen mcp` forwarding to the running app (#1174), over the real channel: a
// named pipe on Windows, a Unix socket elsewhere. The "app" is `serveAppChannel` with
// an in-memory editor and a real DocumentService; the "stdio process" is `routeToApp`
// with its own local runner, as stdio-server.ts wires them.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AxcutDocument,
	createEmptyDocument,
	documentSchema,
} from "../../src/lib/ai-edition/schema";
import { DocumentService } from "../ai-edition/document-service";
import { type AppChannel, discoveryFilePath, routeToApp, serveAppChannel } from "./app-channel";
import {
	createToolRunner,
	LIST_PROJECTS_TOOL,
	MCP_ENDPOINT_PATH,
	type McpApplyResult,
	type McpDocumentHost,
	type McpToolDeps,
	type McpToolRunner,
	type RunningMcpServer,
	startMcpHttpServer,
} from "./openscreen-mcp-server";

function fixtureDocument(projectId: string, video = "/tmp/rec.mp4"): AxcutDocument {
	const base = createEmptyDocument({
		title: `Test ${projectId}`,
		projectId,
		createdAt: "2026-01-01T00:00:00.000Z",
	});
	return documentSchema.parse({
		...base,
		project: { ...base.project, primaryAssetId: "asset_1" },
		assets: [{ id: "asset_1", kind: "video", label: "Rec", originalPath: video, durationSec: 30 }],
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

/** The app's editor window: a document and the revision guarding it. */
class FakeEditor implements McpDocumentHost {
	document: AxcutDocument | null = fixtureDocument("proj_open");
	revision = 1;
	applied = 0;
	/** Runs between the snapshot and the apply, where a user edit would land. */
	onSnapshot?: () => void;
	/** Holds the apply until resolved: an app that stops answering mid-call. */
	hold?: Promise<void>;
	applying = false;

	async snapshot() {
		if (!this.document) return null;
		const snapshot = { document: structuredClone(this.document), revision: this.revision };
		this.onSnapshot?.();
		return snapshot;
	}

	async apply(document: AxcutDocument, expectedRevision: number): Promise<McpApplyResult> {
		this.applying = true;
		await this.hold;
		if (expectedRevision !== this.revision) return "conflict";
		this.document = document;
		this.revision += 1;
		this.applied += 1;
		return "applied";
	}
}

const trimArgs = (projectId?: string) => ({
	assetId: "asset_1",
	startSec: 5,
	endSec: 6,
	...(projectId ? { projectId } : {}),
});

function text(result: CallToolResult): string {
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

let dir: string;
let userData: string;
/** The app's projects, and the CLI's own view of the same folder. */
let appProjects: DocumentService;
let cliProjects: DocumentService;
let editor: FakeEditor;
let appDeps: McpToolDeps;
let appRunTool: McpToolRunner;
let channel: AppChannel | null;
let http: RunningMcpServer | null;
let localCalls: string[];

function cliRouter() {
	const local = createToolRunner({
		transport: "stdio",
		host: { snapshot: async () => null, apply: async () => "no-editor" },
		projects: cliProjects,
		editsAllowed: () => true,
		version: "0.0.0",
	});
	return routeToApp({
		userDataDir: userData,
		version: "0.0.0",
		local: (name, args, call) => {
			localCalls.push(name);
			return local(name, args, call);
		},
	});
}

async function startApp() {
	channel = await serveAppChannel({ userDataDir: userData, deps: appDeps, runTool: appRunTool });
	appProjects.markOpenInEditor("proj_open");
}

beforeEach(async () => {
	dir = mkdtempSync(path.join(os.tmpdir(), "openscreen-app-channel-"));
	userData = path.join(dir, "userData");
	const projectsDir = path.join(userData, "projects");
	appProjects = new DocumentService(projectsDir, dir);
	cliProjects = new DocumentService(projectsDir, dir);
	await appProjects.saveProject(fixtureDocument("proj_open"));
	await appProjects.saveProject(fixtureDocument("proj_closed", path.join(dir, "take.mp4")));
	editor = new FakeEditor();
	// The in-app server's own switch is off: the channel must not depend on it.
	appDeps = {
		transport: "http",
		host: editor,
		projects: appProjects,
		editsAllowed: () => false,
		version: "0.0.0",
	};
	appRunTool = createToolRunner(appDeps);
	channel = null;
	http = null;
	localCalls = [];
});

afterEach(async () => {
	channel?.close();
	await http?.close();
	appProjects.markOpenInEditor(null);
	rmSync(dir, { recursive: true, force: true });
});

describe("discovery", () => {
	it("runs locally when no app announced itself", async () => {
		const route = cliRouter();
		const result = await route(LIST_PROJECTS_TOOL, {});
		expect(result.isError).toBeFalsy();
		expect(localCalls).toEqual([LIST_PROJECTS_TOOL]);
	});

	it("ignores a crashed app's file: a dead pid, or a live pid with no endpoint", async () => {
		const dead = spawnSync(process.execPath, ["-e", ""]).pid;
		const file = discoveryFilePath(userData);
		const route = cliRouter();
		for (const pid of [dead, process.pid]) {
			const endpoint =
				process.platform === "win32"
					? "\\\\.\\pipe\\openscreen-mcp-gone"
					: path.join(userData, "gone.sock");
			writeFileSync(file, JSON.stringify({ pid, endpoint, token: "x" }));
			expect((await route(LIST_PROJECTS_TOOL, {})).isError).toBeFalsy();
		}
		expect(localCalls).toHaveLength(2);
	});

	it("gives up on an endpoint that accepts and never answers", async () => {
		const endpoint =
			process.platform === "win32"
				? `\\\\.\\pipe\\openscreen-mcp-mute-${process.pid}`
				: path.join(userData, "mute.sock");
		const mute = net.createServer(() => undefined);
		await new Promise<void>((resolve) => mute.listen(endpoint, resolve));
		try {
			writeFileSync(
				discoveryFilePath(userData),
				JSON.stringify({ pid: process.pid, endpoint, token: "x" }),
			);
			const started = Date.now();
			expect((await cliRouter()(LIST_PROJECTS_TOOL, {})).isError).toBeFalsy();
			expect(localCalls).toEqual([LIST_PROJECTS_TOOL]);
			expect(Date.now() - started).toBeLessThan(10_000);
		} finally {
			mute.close();
		}
	}, 15_000);

	it("finds a running app and removes its announcement when it closes", async () => {
		await startApp();
		const result = await cliRouter()(LIST_PROJECTS_TOOL, {});
		const listed = JSON.parse(text(result)).projects as Array<{ id: string; open: boolean }>;
		expect(listed.find((p) => p.id === "proj_open")?.open).toBe(true);
		expect(localCalls).toEqual([]);
		channel?.close();
		channel = null;
		expect(() => statSync(discoveryFilePath(userData))).toThrow();
	});
});

describe("forwarding to the app", () => {
	it("edits the project open in the editor through the editor, once", async () => {
		await startApp();
		const route = cliRouter();
		const result = await route("addTrim", trimArgs("proj_open"));
		expect(result.isError).toBeFalsy();
		expect(editor.applied).toBe(1);
		expect(editor.document?.timeline.trimRanges).toHaveLength(1);
		// Without a projectId too: the open project is the app's, not this process's.
		expect(
			(await route("addTrim", { ...trimArgs(), startSec: 10, endSec: 11 })).isError,
		).toBeFalsy();
		expect(editor.applied).toBe(2);
		expect(localCalls).toEqual([]);
	});

	it("keeps the editor's revision guard", async () => {
		await startApp();
		editor.onSnapshot = () => {
			editor.revision += 1;
		};
		const result = await cliRouter()("addTrim", trimArgs("proj_open"));
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("NOT applied");
		expect(editor.applied).toBe(0);
	});

	it("serves several stdio clients at once, one call at a time", async () => {
		await startApp();
		const results = await Promise.all(
			[0, 1, 2].map((i) =>
				cliRouter()("addTrim", { ...trimArgs("proj_open"), startSec: i * 3, endSec: i * 3 + 1 }),
			),
		);
		expect(results.every((result) => !result.isError)).toBe(true);
		expect(editor.applied).toBe(3);
		expect(editor.document?.timeline.trimRanges).toHaveLength(3);
	});

	it("has the app compute and write setPointerTrack, under its checkpoints", async () => {
		await startApp();
		const route = cliRouter();
		const video = path.join(dir, "take.mp4");
		const created = await route("createCheckpoint", { projectId: "proj_closed" });
		const { checkpointId } = JSON.parse(text(created));
		const result = await route(
			"setPointerTrack",
			{
				projectId: "proj_closed",
				events: [{ at: 6_000, x: 0.5, y: 0.5, click: true }],
				takes: { [video]: 1_000 },
			},
			// Forwarded: this closure never runs, the app computes the edit from the args.
			{ edit: () => Promise.reject(new Error("ran locally")) },
		);
		expect(result.isError).toBeFalsy();
		expect(JSON.parse(text(result)).samples).toBeGreaterThan(0);
		expect(statSync(`${video}.cursor.json`).isFile()).toBe(true);
		expect(localCalls).toEqual([]);

		await route("restoreCheckpoint", { projectId: "proj_closed", checkpointId });
		expect(() => statSync(`${video}.cursor.json`)).toThrow();
	});

	it("has the app place the track on the client's own clock, for a video no take recorded", async () => {
		await startApp();
		const route = cliRouter();
		const video = path.join(dir, "take.mp4");
		await route("createCheckpoint", { projectId: "proj_closed" });
		const result = await route(
			"setPointerTrack",
			{
				projectId: "proj_closed",
				events: [{ at: 6_000, x: 0.5, y: 0.5, click: true }],
				takes: {},
				recordingStartedAt: 1_000,
			},
			{ edit: () => Promise.reject(new Error("ran locally")) },
		);
		expect(result.isError).toBeFalsy();
		const { samples } = JSON.parse(readFileSync(`${video}.cursor.json`, "utf8")) as {
			samples: Array<{ timeMs: number; interactionType: string }>;
		};
		expect(samples.find((s) => s.interactionType === "click")?.timeMs).toBe(5_000);
		expect(localCalls).toEqual([]);
	});

	it("runs a tool the app does not serve locally", async () => {
		await startApp();
		await cliRouter()("notAnAppTool", {});
		expect(localCalls).toEqual(["notAnAppTool"]);
	});
});

describe("checkpoints", () => {
	it("are one store for the in-app server and forwarded sessions", async () => {
		await startApp();
		http = await startMcpHttpServer({ port: 0, token: "t", deps: appDeps, runTool: appRunTool });
		const client = new Client({ name: "test", version: "0.0.0" });
		await client.connect(
			new StreamableHTTPClientTransport(
				new URL(`http://127.0.0.1:${http.port}${MCP_ENDPOINT_PATH}`),
				{ requestInit: { headers: { Authorization: "Bearer t" } } },
			),
		);
		try {
			const created = (await client.callTool({
				name: "createCheckpoint",
				arguments: { projectId: "proj_closed" },
			})) as CallToolResult;
			const { checkpointId } = JSON.parse(text(created));

			// The closed project needs a checkpoint before an edit: the HTTP one counts.
			const route = cliRouter();
			expect((await route("addTrim", trimArgs("proj_closed"))).isError).toBeFalsy();
			const edited = await appProjects.getProject("proj_closed");
			expect(edited.timeline.trimRanges).toHaveLength(1);

			const restored = await route("restoreCheckpoint", { projectId: "proj_closed", checkpointId });
			expect(restored.isError).toBeFalsy();
			expect((await appProjects.getProject("proj_closed")).timeline.trimRanges).toHaveLength(0);
			expect(localCalls).toEqual([]);
		} finally {
			await client.close();
		}
	});
});

describe("the app going away", () => {
	it("falls back to the files, refusing the project a live app's editor holds", async () => {
		await startApp();
		const route = cliRouter();
		expect((await route("addTrim", trimArgs("proj_open"))).isError).toBeFalsy();
		channel?.close();
		channel = null;
		// The marker stays, as when the app is alive but not answering.
		appProjects.markOpenInEditor("proj_open");
		await vi.waitFor(async () => {
			const result = await route("addTrim", { ...trimArgs("proj_open"), startSec: 20, endSec: 21 });
			expect(localCalls).toContain("addTrim");
			expect(result.isError).toBe(true);
			expect(text(result)).toContain("open in the OpenScreen editor");
		});
		expect(editor.applied).toBe(1);
	});

	it("never runs again here an edit the app received but did not answer", async () => {
		await startApp();
		let release: () => void = () => undefined;
		editor.hold = new Promise((resolve) => {
			release = resolve;
		});
		const route = cliRouter();
		const pending = route("addTrim", trimArgs("proj_open"));
		await vi.waitFor(() => expect(editor.applying).toBe(true));
		channel?.close();
		channel = null;
		const result = await pending;
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("whether it took effect is unknown");
		expect(localCalls).toEqual([]);
		release();
	});

	it("reruns a read locally when its answer is lost", async () => {
		await startApp();
		const route = cliRouter();
		await route(LIST_PROJECTS_TOOL, {});
		// A read that reaches the editor's snapshot, then loses the app.
		const snapshot = editor.snapshot.bind(editor);
		editor.snapshot = async () => {
			channel?.close();
			channel = null;
			await new Promise(() => undefined);
			return snapshot();
		};
		const result = await route("getCurrentDocument", { projectId: "proj_closed" });
		expect(result.isError).toBeFalsy();
		expect(localCalls).toEqual(["getCurrentDocument"]);
	});
});

describe("access", () => {
	it("hangs up on a client without the token", async () => {
		await startApp();
		const socket = net.createConnection(channel?.endpoint ?? "");
		socket.on("error", () => undefined);
		socket.write("wrong-token\n");
		socket.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })}\n`,
		);
		const received: Buffer[] = [];
		socket.on("data", (chunk) => received.push(chunk));
		await new Promise((resolve) => socket.once("close", resolve));
		expect(Buffer.concat(received).length).toBe(0);
	});

	it.skipIf(process.platform === "win32")(
		"keeps the socket and the token file private",
		async () => {
			await startApp();
			expect(statSync(discoveryFilePath(userData)).mode & 0o077).toBe(0);
			expect(statSync(channel?.endpoint ?? "").mode & 0o077).toBe(0);
		},
	);
});
