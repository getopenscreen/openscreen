// The OpenScreen MCP server: the in-app agent's tools, offered to any MCP client
// (Claude Code, Codex, Cursor…) that the user runs themselves, on any of the
// user's projects — not only the one open in the editor.
//
// Nothing here is a second implementation. The tool list, argument schemas,
// descriptions and guidance are the in-app agent's own (`TOOL_ARG_SCHEMAS`,
// `TOOL_DESCRIPTIONS`, `buildSystemPrompt`), and every call runs through
// `runDocumentTool` — the same executor, consent gate and cursor read the
// in-app agent uses. The one difference is where the document comes from: the
// in-app agent is handed a snapshot per chat turn, while here each call reads
// the live document from the editor window and writes the result back through
// the same revision-guarded apply, so a user edit landing mid-call is never
// overwritten and every edit is one undo step.
//
// A call can name another project with `projectId` (see `listProjects`). The
// project open in the editor is still only ever edited through the editor; any
// other one is read from and saved to its file, refused if anything read or saved
// that project while the call ran (`saveProjectIfUnchanged`).
//
// Two tools exist only here: `createCheckpoint` / `restoreCheckpoint`. A client
// chains several edits per turn, and undo is per call, so they give it one step
// back to where the turn started. For a project that is not open they are the
// only way back, so an edit to one is refused until it has a checkpoint. The
// in-app agent has no need for them: its whole turn is already a single apply.
//
// The HTTP layer is local-only: bound to 127.0.0.1, a bearer token on every
// request, and a Host/Origin check so a web page cannot reach it by DNS
// rebinding.

import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { type AxcutDocument, documentSchema } from "../../src/lib/ai-edition/schema";
import { type AgentToolExecution, isMutatingTool } from "../ai-edition/agent-tools";
import {
	buildSystemPrompt,
	type CursorTelemetryReader,
	probeCursorTelemetry,
	runDocumentTool,
	TOOL_ARG_SCHEMAS,
	TOOL_DESCRIPTIONS,
} from "../ai-edition/deep-agent/service";
import {
	DocumentNotFoundError,
	type ProjectSummary,
	type ProjectVersion,
} from "../ai-edition/document-service";

export const MCP_SERVER_NAME = "openscreen";
export const MCP_ENDPOINT_PATH = "/mcp";

export interface McpDocumentSnapshot {
	document: unknown;
	/** The editor's revision when the snapshot was taken — the apply guard. */
	revision: number;
}

/** Mirrors the renderer's `AgentDocumentApplyResult`, plus the editor having gone
 *  away or not answering in time. */
export type McpApplyResult =
	| "applied"
	| "conflict"
	| "save-failed"
	| "no-live-document"
	| "no-editor"
	| "timeout";

/** The live document, as held by the editor window. */
export interface McpDocumentHost {
	/** `null` when no editor window is open or it has no project loaded. */
	snapshot(): Promise<McpDocumentSnapshot | null>;
	apply(document: AxcutDocument, expectedRevision: number): Promise<McpApplyResult>;
}

/** Every project on disk — the subset of `DocumentService` the server needs. */
export interface McpProjectStore {
	listProjects(): Promise<ProjectSummary[]>;
	/** Throws `DocumentNotFoundError` for an unknown id. */
	getProjectForUpdate(
		projectId: string,
	): Promise<{ document: AxcutDocument; version: ProjectVersion }>;
	/** `null`, and nothing written, when the project was read or saved since `version`. */
	saveProjectIfUnchanged(
		document: AxcutDocument,
		version: ProjectVersion,
	): Promise<AxcutDocument | null>;
}

type ProjectRead = Awaited<ReturnType<McpProjectStore["getProjectForUpdate"]>>;

export interface McpToolDeps {
	host: McpDocumentHost;
	projects: McpProjectStore;
	/** The "Project edits" setting — the same one the in-app agent obeys. */
	editsAllowed(): boolean;
	cursor?: CursorTelemetryReader;
	version: string;
}

export const LIST_PROJECTS_TOOL = "listProjects";

const LIST_PROJECTS_DESCRIPTION =
	"List every OpenScreen project: id, title, last update, asset count, and whether it is the one open in the editor. Pass a project's id as `projectId` to any other tool to read or edit that project.";

const PROJECT_ID_ARG = z
	.string()
	.optional()
	.describe(
		"The project to act on, from listProjects. Omit it for the project open in the editor.",
	);

const NO_PROJECT_MESSAGE =
	"No project is open in the OpenScreen editor. Call listProjects and pass a projectId, or ask the user to open one in OpenScreen.";

// The editor would overwrite a file edit with its own copy on its next save, so a
// project it opened mid-call is left to it; the retry then goes through the editor.
const PROJECT_CHANGED_MESSAGE =
	"The edit was NOT applied: the project was opened in the editor or saved elsewhere while this call ran. Call getCurrentDocument with the same projectId to re-read it, then retry.";

const CHECKPOINT_REQUIRED_MESSAGE =
	"The edit was NOT applied: this project is not open in the editor, so the user cannot undo an edit to it with Ctrl/Cmd+Z. Call createCheckpoint with this projectId first, so restoreCheckpoint can take your edits back in one step, then retry.";

const APPLY_FAILURE_MESSAGES: Record<Exclude<McpApplyResult, "applied">, string> = {
	conflict:
		"The edit was NOT applied: the project changed in the editor while this call ran. Call getCurrentDocument to re-read it, then retry.",
	"save-failed": "The edit was NOT applied: OpenScreen could not save the project.",
	"no-live-document": NO_PROJECT_MESSAGE,
	"no-editor": NO_PROJECT_MESSAGE,
	// Not "NOT applied": the editor may have saved it and only the answer was lost.
	timeout:
		"OpenScreen did not confirm this edit in time. Call getCurrentDocument to see whether it landed before retrying.",
};

const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set([
	"replaceTimeline",
	"removeTrim",
	"removeModifier",
	"removeClip",
]);

const MCP_PREAMBLE = [
	"These tools act on the user's OpenScreen projects. Without a projectId they act on the project open in the editor; call listProjects to find any other project and pass its id as projectId. Every edit is saved straight away. An edit to the open project appears in the editor, where the user can undo it with Ctrl/Cmd+Z; an edit to any other project is saved to its file and is not on the editor's undo stack. Nothing here records, exports or imports media.",
	"Before a series of edits, call createCheckpoint with the same projectId. Undo is one step per call, so if the result is not what the user wanted, restoreCheckpoint takes the project back in one step instead of many. A project that is not open in the editor cannot be edited until it has a checkpoint, since restoreCheckpoint is its only undo.",
	"",
].join("\n");

// ponytail: kept in memory, last 20 only. Lost when OpenScreen quits or the MCP
// server is turned off; persist them per project if agents need them across sessions.
const MAX_CHECKPOINTS = 20;

const CHECKPOINT_TOOLS = [
	{
		name: "createCheckpoint",
		description:
			"Save the current state of the project and return its checkpointId. Changes nothing. Call it before a series of edits so restoreCheckpoint can revert all of them in one step.",
		inputSchema: z.object({}),
		mutating: false,
	},
	{
		name: "restoreCheckpoint",
		description:
			"Put the project back exactly as it was when createCheckpoint returned this checkpointId, discarding every edit made since, including the user's. Pass the same projectId as to createCheckpoint. On the project open in the editor it lands as one undo step, so the user can undo the restore itself.",
		inputSchema: z.object({ checkpointId: z.string() }),
		mutating: true,
	},
] as const;

function textResult(text: string, isError: boolean): CallToolResult {
	return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function openProjectId(snapshot: McpDocumentSnapshot | null): string | null {
	const project = (snapshot?.document as { project?: { id?: unknown } } | null)?.project;
	return typeof project?.id === "string" ? project.id : null;
}

/** `projectId` is the server's argument, not the tool's: the executor never sees it. */
function splitProjectId(rawArgs: unknown): { projectId: string | undefined; args: unknown } {
	if (!rawArgs || typeof rawArgs !== "object") return { projectId: undefined, args: rawArgs };
	const { projectId, ...args } = rawArgs as Record<string, unknown>;
	return { projectId: typeof projectId === "string" ? projectId : undefined, args };
}

/**
 * Runs tool calls one at a time. Each call is snapshot → execute → apply, and
 * two of those interleaving would make the second apply against a revision the
 * first just moved — a spurious conflict at best.
 */
export function createToolRunner(deps: McpToolDeps) {
	let queue: Promise<unknown> = Promise.resolve();
	const checkpoints = new Map<string, AxcutDocument>();

	function createCheckpoint(document: AxcutDocument): AgentToolExecution {
		const checkpointId = `cp_${randomUUID()}`;
		checkpoints.set(checkpointId, document);
		// A Map iterates in insertion order: the first key is the oldest.
		for (const oldest of checkpoints.keys()) {
			if (checkpoints.size <= MAX_CHECKPOINTS) break;
			checkpoints.delete(oldest);
		}
		return { ok: true, resultJson: JSON.stringify({ checkpointId }) };
	}

	/** Hands the checkpoint back as the call's new document, saved like any edit. */
	function restoreCheckpoint(document: AxcutDocument, args: unknown): AgentToolExecution {
		if (!deps.editsAllowed()) {
			return {
				ok: false,
				resultJson:
					"Project edits are turned off in OpenScreen, so the checkpoint was NOT restored. Ask the user to re-enable 'Project edits' in Settings → AI, or to undo the edits themselves.",
			};
		}
		const id = (args as { checkpointId?: unknown } | null)?.checkpointId;
		const checkpoint = typeof id === "string" ? checkpoints.get(id) : undefined;
		if (!checkpoint) {
			return {
				ok: false,
				resultJson:
					"Unknown checkpointId. Checkpoints last until OpenScreen quits, and only the 20 most recent are kept.",
			};
		}
		if (checkpoint.project.id !== document.project.id) {
			return {
				ok: false,
				resultJson: `The edit was NOT applied: this checkpoint belongs to another project than the one this call acts on. Pass projectId "${checkpoint.project.id}".`,
			};
		}
		return {
			ok: true,
			resultJson: JSON.stringify({ ok: true, restored: id }),
			document: checkpoint,
		};
	}

	function hasCheckpoint(projectId: string): boolean {
		for (const checkpoint of checkpoints.values()) {
			if (checkpoint.project.id === projectId) return true;
		}
		return false;
	}

	async function listProjects(): Promise<CallToolResult> {
		const [projects, snapshot] = await Promise.all([
			deps.projects.listProjects(),
			deps.host.snapshot(),
		]);
		const openId = openProjectId(snapshot);
		const listed = projects.map((project) => ({ ...project, open: project.id === openId }));
		return textResult(JSON.stringify({ projects: listed }), false);
	}

	/** The project open in the editor: read and written through the editor itself. */
	async function runOnEditor(
		snapshot: McpDocumentSnapshot,
		name: string,
		args: unknown,
	): Promise<CallToolResult> {
		const parsed = documentSchema.safeParse(snapshot.document);
		if (!parsed.success) {
			return textResult("The project open in the editor could not be read.", true);
		}
		const execution = await execute(parsed.data, name, args);
		if (execution.document) {
			const applied = await deps.host.apply(execution.document, snapshot.revision);
			if (applied !== "applied") return textResult(APPLY_FAILURE_MESSAGES[applied], true);
		}
		return textResult(execution.resultJson, !execution.ok);
	}

	/** Any other project: read from and saved to its file. */
	async function runOnFile(
		projectId: string,
		read: ProjectRead,
		name: string,
		args: unknown,
	): Promise<CallToolResult> {
		const execution = await execute(read.document, name, args);
		if (execution.document) {
			// A restore IS the way back, so it needs no checkpoint of its own.
			if (name !== "restoreCheckpoint" && !hasCheckpoint(projectId)) {
				return textResult(CHECKPOINT_REQUIRED_MESSAGE, true);
			}
			// Refused if anything read the project since (the editor opening it would
			// otherwise drop this edit on its next save) or saved it, inside the app or
			// not: see saveProjectIfUnchanged.
			if (!(await deps.projects.saveProjectIfUnchanged(execution.document, read.version))) {
				return textResult(PROJECT_CHANGED_MESSAGE, true);
			}
		}
		return textResult(execution.resultJson, !execution.ok);
	}

	async function execute(
		document: AxcutDocument,
		name: string,
		args: unknown,
	): Promise<AgentToolExecution> {
		if (name === "createCheckpoint") return createCheckpoint(document);
		if (name === "restoreCheckpoint") return restoreCheckpoint(document, args);
		const availableByAssetId = await probeCursorTelemetry(document, deps.cursor);
		return runDocumentTool(document, name, args, deps.editsAllowed(), {
			cursor: deps.cursor,
			availableByAssetId,
		});
	}

	async function run(name: string, rawArgs: unknown): Promise<CallToolResult> {
		if (name === LIST_PROJECTS_TOOL) return listProjects();
		const { projectId, args } = splitProjectId(rawArgs);
		if (projectId === undefined) {
			const snapshot = await deps.host.snapshot();
			return snapshot ? runOnEditor(snapshot, name, args) : textResult(NO_PROJECT_MESSAGE, true);
		}
		// The file first, the editor second. Reads of a project queue behind each other,
		// so an editor open of it already under way has returned by now, and the editor
		// installs what it read before it answers the snapshot: either the snapshot shows
		// the project, or saveProjectIfUnchanged sees any open that starts after this read.
		const read = await deps.projects.getProjectForUpdate(projectId).catch((error) => {
			if (error instanceof DocumentNotFoundError) return null;
			throw error;
		});
		const snapshot = await deps.host.snapshot();
		if (snapshot && openProjectId(snapshot) === projectId) {
			return runOnEditor(snapshot, name, args);
		}
		if (!read) {
			return textResult(
				`No project has the id "${projectId}". Call listProjects for the valid ids.`,
				true,
			);
		}
		return runOnFile(projectId, read, name, args);
	}

	return (name: string, args: unknown): Promise<CallToolResult> => {
		const next = queue.then(
			() => run(name, args),
			() => run(name, args),
		);
		queue = next.catch(() => undefined);
		return next.catch((error) => textResult(`Tool failed: ${errorMessage(error)}`, true));
	};
}

export function createOpenScreenMcpServer(
	deps: McpToolDeps,
	runTool: (name: string, args: unknown) => Promise<CallToolResult>,
): McpServer {
	const server = new McpServer(
		{ name: MCP_SERVER_NAME, version: deps.version },
		{ instructions: MCP_PREAMBLE + buildSystemPrompt({ editsAllowed: deps.editsAllowed() }) },
	);
	server.registerTool(
		LIST_PROJECTS_TOOL,
		{
			description: LIST_PROJECTS_DESCRIPTION,
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
		},
		() => runTool(LIST_PROJECTS_TOOL, {}),
	);
	for (const [name, schema] of TOOL_ARG_SCHEMAS) {
		const mutating = isMutatingTool(name);
		server.registerTool(
			name,
			{
				description: TOOL_DESCRIPTIONS[name],
				inputSchema: schema.extend({ projectId: PROJECT_ID_ARG }),
				annotations: {
					readOnlyHint: !mutating,
					destructiveHint: DESTRUCTIVE_TOOLS.has(name),
					openWorldHint: false,
				},
			},
			(args: unknown) => runTool(name, args),
		);
	}
	for (const tool of CHECKPOINT_TOOLS) {
		server.registerTool(
			tool.name,
			{
				description: tool.description,
				inputSchema: tool.inputSchema.extend({ projectId: PROJECT_ID_ARG }),
				annotations: {
					readOnlyHint: !tool.mutating,
					destructiveHint: tool.mutating,
					openWorldHint: false,
				},
			},
			(args: unknown) => runTool(tool.name, args),
		);
	}
	return server;
}

function isAllowedHost(hostHeader: string | undefined, port: number): boolean {
	return hostHeader === `127.0.0.1:${port}` || hostHeader === `localhost:${port}`;
}

function isAllowedOrigin(origin: string | undefined, port: number): boolean {
	// MCP clients are not browsers and send no Origin; a browser always does.
	if (origin === undefined) return true;
	return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function hasValidToken(authorization: string | undefined, token: string): boolean {
	const presented = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
	const a = Buffer.from(presented);
	const b = Buffer.from(token);
	return a.length === b.length && timingSafeEqual(a, b);
}

function reject(res: ServerResponse, status: number, message: string, headers = {}): void {
	res.writeHead(status, { "Content-Type": "application/json", ...headers });
	res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

export interface RunningMcpServer {
	port: number;
	close(): Promise<void>;
}

export async function startMcpHttpServer(options: {
	port: number;
	token: string;
	deps: McpToolDeps;
}): Promise<RunningMcpServer> {
	const { token, deps } = options;
	const runTool = createToolRunner(deps);
	let boundPort = options.port;

	const handle = async (req: IncomingMessage, res: ServerResponse) => {
		const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
		if (pathname !== MCP_ENDPOINT_PATH) return reject(res, 404, "Not found");
		if (!isAllowedHost(req.headers.host, boundPort)) return reject(res, 403, "Forbidden host");
		if (!isAllowedOrigin(req.headers.origin, boundPort)) {
			return reject(res, 403, "Forbidden origin");
		}
		if (!hasValidToken(req.headers.authorization, token)) {
			return reject(res, 401, "Unauthorized", { "WWW-Authenticate": "Bearer" });
		}

		// Stateless: one server + transport per request, the SDK's documented shape
		// for a server that keeps no per-session state. Tools read the live editor
		// on every call, so there is nothing a session would need to remember.
		const server = createOpenScreenMcpServer(deps, runTool);
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true,
		});
		res.on("close", () => {
			void transport.close();
			void server.close();
		});
		try {
			await server.connect(transport);
			await transport.handleRequest(req, res);
		} catch (error) {
			if (!res.headersSent) reject(res, 500, errorMessage(error));
		}
	};

	const httpServer: Server = createServer((req, res) => {
		void handle(req, res);
	});
	await new Promise<void>((resolve, reject) => {
		httpServer.once("error", reject);
		httpServer.listen(options.port, "127.0.0.1", () => {
			httpServer.off("error", reject);
			resolve();
		});
	});
	boundPort = (httpServer.address() as AddressInfo).port;

	return {
		port: boundPort,
		close: () =>
			new Promise<void>((resolve) => {
				httpServer.closeAllConnections();
				httpServer.close(() => resolve());
			}),
	};
}
