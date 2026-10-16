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
// that project while the call ran (`saveProjectIfUnchanged`), or if the editor of
// another OpenScreen process holds it (`projectOpenInEditor`: the app, seen from
// `openscreen mcp`).
//
// Two tools exist only here: `createCheckpoint` / `restoreCheckpoint`. A client
// chains several edits per turn, and undo is per call, so they give it one step
// back to where the turn started. For a project that is not open they are the
// only way back, so an edit to one is refused until it has a checkpoint. The
// in-app agent has no need for them: its whole turn is already a single apply.
// Nor for the project's own edits (project-tools.ts: its name, its media), which
// reach a file on disk the in-app agent has no way to name.
//
// Two transports serve these tools: the in-app server over HTTP (below) and
// `openscreen mcp` over stdio (`stdio-server.ts`), both with the media tools around
// them (media-tools.ts: record, export, look). The
// runner and the tools are the same; the texts a client reads are composed per
// transport (`mcpInstructions`, the `*_MESSAGES` tables), so each says what is true
// on the server that serves it. While the app runs, `openscreen mcp` forwards its document
// calls to it (`app-channel.ts`), so the app's one runner serves both. A media tool that edits a project
// (setPointerTrack) hands its change to the runner too, so it meets the same
// refusals and checkpoints, sidecar included.
//
// The HTTP layer is local-only: bound to 127.0.0.1, a bearer token on every
// request, and a Host/Origin check so a web page cannot reach it by DNS
// rebinding.

import { randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
	applyTranscriptionResult,
	withTranscript,
} from "../../src/lib/ai-edition/document/transcript";
import { type AxcutDocument, documentSchema } from "../../src/lib/ai-edition/schema";
import type { ShaderEffectChecker } from "../../src/lib/ai-edition/shaderEffects";
import {
	segmentsFromStt,
	transcriptFromSegments,
} from "../../src/lib/ai-edition/transcription/fromStt";
import {
	classifyTranscriptionError,
	withTranscriptionFailure,
} from "../../src/lib/ai-edition/transcription/status";
import type { AiEditionMcpTranscription, SegmentationSupport } from "../../src/native/contracts";
import {
	type AgentToolExecution,
	consentRequired,
	isMutatingTool,
} from "../ai-edition/agent-tools";
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
	ProjectOpenInEditorError,
	type ProjectSummary,
	type ProjectVersion,
} from "../ai-edition/document-service";
import type { SttTranscribeRequest, SttTranscribeResponse } from "../stt/transcriptionContract";
import { EFFECTS_CONTRACT, EFFECTS_CONTRACT_URI, EFFECTS_NOTE } from "./effects-contract";
import type { MediaTools } from "./media-tools";
import {
	IMPORT_MEDIA_TOOL,
	type ImportMediaDeps,
	PROJECT_EDIT_TOOLS,
	PROJECT_TOOLS,
	prepareImportMedia,
	REMOVE_MEDIA_TOOL,
	removeMedia,
	SET_PROJECT_INFO_TOOL,
	setProjectInfo,
} from "./project-tools";

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
	/**
	 * The editor's own transcription of an asset of the project it holds (`projectId`): a
	 * job of its own already under way is waited for rather than run twice. Absent where
	 * there is no editor to ask.
	 */
	transcribe?(
		projectId: string,
		assetId: string,
		language: string | undefined,
	): Promise<AiEditionMcpTranscription | "no-editor" | "timeout">;
}

/** Every project on disk — the subset of `DocumentService` the server needs. */
export interface McpProjectStore {
	listProjects(): Promise<ProjectSummary[]>;
	/** Throws `DocumentNotFoundError` for an unknown id. */
	getProjectForUpdate(
		projectId: string,
	): Promise<{ document: AxcutDocument; version: ProjectVersion }>;
	/** The project an OpenScreen editor holds, this process's or another's (`openscreen mcp`
	 *  runs beside the app), or `null`. */
	projectOpenInEditor(): Promise<string | null>;
	/** `null`, and nothing written, when the project was read or saved since `version`.
	 *  Rejects with `ProjectOpenInEditorError` when an editor holds it. */
	saveProjectIfUnchanged(
		document: AxcutDocument,
		version: ProjectVersion,
	): Promise<AxcutDocument | null>;
}

type ProjectRead = Awaited<ReturnType<McpProjectStore["getProjectForUpdate"]>>;

/**
 * Which server this is. The tools are the same; what differs is what a call can reach:
 * the in-app server (`http`) has the editor, its undo stack, the app's recording bar and
 * a switch for edits; `openscreen mcp` (`stdio`) is a process of its own, with no editor
 * and no switch, recording in a hidden runner.
 * Every text the client reads says what is true on the one it is connected to.
 */
export type McpTransport = "http" | "stdio";

export interface McpToolDeps extends ImportMediaDeps {
	transport: McpTransport;
	host: McpDocumentHost;
	projects: McpProjectStore;
	/** The MCP server's own edit switch ("MCP edits"), separate from the in-app agent's. */
	editsAllowed(): boolean;
	cursor?: CursorTelemetryReader;
	/** Whether this machine can cut out the camera background; absent where nothing can ask. */
	cameraSegmentation?: () => SegmentationSupport;
	/** The compositor's check of an agent-written effect's WGSL; absent where nothing can ask. */
	checkShaderEffect?: ShaderEffectChecker;
	/** The main process's on-device Whisper (`SttManager.transcribe`). Absent: no transcribe tool. */
	transcribe?(request: SttTranscribeRequest): Promise<SttTranscribeResponse>;
	version: string;
}

export const LIST_PROJECTS_TOOL = "listProjects";
export const TRANSCRIBE_TOOL = "transcribe";

const transcribeArgs = z.object({
	assetId: z
		.string()
		.min(1)
		.optional()
		.describe("The asset to transcribe, from getCurrentDocument. Default: the primary asset."),
	language: z
		.string()
		.regex(/^(auto|[a-z]{2,3})$/, 'an ISO 639-1 code such as "en", or "auto"')
		.optional()
		.describe(
			'Transcribe again in this language (ISO 639-1, such as "en" or "fr"), or "auto" to let Whisper detect it. Omit it to keep a transcript the asset already has.',
		),
});

const TRANSCRIBE_DESCRIPTION =
	"Transcribe one asset's speech with OpenScreen's on-device Whisper, as the editor does when it opens a project, and store the transcript in the project: getTranscript, getTranscriptWords, setWordText, removeWords and the captions all read it. A take from stopRecording has none until this runs. Without `language`, an asset that already has a transcript keeps it, and a transcription the editor is already running is waited for rather than run twice; with `language`, the asset is transcribed again in it (a run of the editor already in that language is waited for instead), and the word corrections that still match are carried over. The project's vocabulary (setVocabulary) primes Whisper. It runs on this computer and can take minutes on a long recording, more the first time, when the speech model downloads. Media with no audio fails with failure.kind `no-audio`, which the asset then remembers (assets[].transcriptionFailure in getCurrentDocument). The result gives the language and the word count; it needs no checkpoint, and restoreCheckpoint keeps a transcript made after its checkpoint.";

const TRANSCRIBE_NOTE =
	"Speech: transcribe makes an asset's transcript with OpenScreen's on-device Whisper. Everything that reads speech needs it (getTranscript, getTranscriptWords, removeWords, the captions); a fresh take has none until you call it.";

/** The in-app server's edit switch, as AI settings label it (`mcpServer.editsLabel`). */
export const MCP_EDITS_SETTING = "'MCP edits' under MCP server in AI settings";

const LIST_PROJECTS_DESCRIPTION =
	"List every OpenScreen project: id, title, last update, asset count, and `open`: whether the OpenScreen editor has it open, in which case an edit to it goes through the editor, shows there live and the user can undo it with Ctrl/Cmd+Z. Pass a project's id as `projectId` to any other tool to read or edit that project.";

const PROJECT_ID_DESCRIPTIONS: Record<McpTransport, string> = {
	http: "The project to act on, from listProjects. Omit it for the project open in the editor.",
	stdio:
		"The project to act on, from listProjects. Omit it only for the project open in the OpenScreen editor, which works only while the app runs.",
};

// stdio's are only met on its own, with no app to forward to (app-channel.ts).
const NO_PROJECT_MESSAGES: Record<McpTransport, string> = {
	http: "No project is open in the OpenScreen editor. Call listProjects and pass a projectId, or ask the user to open one in OpenScreen.",
	stdio:
		"Pass a projectId: OpenScreen is not running (or not answering), so there is no project open in its editor to act on. Call listProjects for the ids.",
};

// The editor would overwrite a file edit with its own copy on its next save, so a
// project it opened mid-call is left to it; the retry then goes through the editor.
const PROJECT_CHANGED_MESSAGE =
	"The edit was NOT applied: the project was opened in the editor or saved elsewhere while this call ran. Call getCurrentDocument with the same projectId to re-read it, then retry.";

const CHECKPOINT_REQUIRED_MESSAGES: Record<McpTransport, string> = {
	http: "The edit was NOT applied: this project is not open in the editor, so the user cannot undo an edit to it with Ctrl/Cmd+Z. Call createCheckpoint with this projectId first, so restoreCheckpoint can take your edits back in one step, then retry.",
	stdio:
		"The edit was NOT applied: OpenScreen is not running (or not answering), so this server saves each edit straight to the project's file, where Ctrl/Cmd+Z cannot reach it. Call createCheckpoint with this projectId first, so restoreCheckpoint can take your edits back in one step, then retry.",
};

// ponytail: kept in memory, last 20 only. In the app one store serves the in-app server
// and every `openscreen mcp` session it answers; persist them per project if agents need
// them across sessions.
const MAX_CHECKPOINTS = 20;

const CHECKPOINT_LIFETIMES: Record<McpTransport, string> = {
	http: `Checkpoints live in OpenScreen's memory: only the ${MAX_CHECKPOINTS} most recent are kept, and all of them are lost when OpenScreen quits.`,
	stdio: `Checkpoints live in OpenScreen's memory while the app runs, and in this server's when it does not: only the ${MAX_CHECKPOINTS} most recent are kept, they are lost when the one holding them exits (OpenScreen quitting, or this server when the client disconnects), and neither knows the other's.`,
};

const APPLY_FAILURE_MESSAGES: Record<Exclude<McpApplyResult, "applied">, string> = {
	conflict:
		"The edit was NOT applied: the project changed in the editor while this call ran. Call getCurrentDocument to re-read it, then retry.",
	"save-failed": "The edit was NOT applied: OpenScreen could not save the project.",
	// Only the in-app server has an editor to apply through.
	"no-live-document": NO_PROJECT_MESSAGES.http,
	"no-editor": NO_PROJECT_MESSAGES.http,
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

/** What both servers say about projects and checkpoints, each in its own terms. */
const CORE_PREAMBLES: Record<McpTransport, readonly string[]> = {
	http: [
		"These tools act on the user's OpenScreen projects. Without a projectId they act on the project open in the editor; call listProjects to find any other project and pass its id as projectId. Every edit is saved straight away. An edit to the open project appears in the editor, where the user can undo it with Ctrl/Cmd+Z; an edit to any other project is saved to its file and is not on the editor's undo stack.",
		"Before a series of edits, call createCheckpoint with the same projectId. Undo is one step per call, so if the result is not what the user wanted, restoreCheckpoint takes the project back in one step instead of many. A project that is not open in the editor cannot be edited until it has a checkpoint, since restoreCheckpoint is its only undo.",
	],
	stdio: [
		"These tools act on the user's OpenScreen projects: call listProjects for their ids, and pass one as projectId. Every edit is saved straight away. While the OpenScreen app runs, this server hands each call to it: an edit to the project open in its editor appears there, where the user can undo it with Ctrl/Cmd+Z, and any other project is saved to its file. When the app is not running, every project is read from and saved to its file, and Ctrl/Cmd+Z cannot reach the edit.",
		"Before a series of edits, call createCheckpoint with the same projectId. Undo is one step per call, so if the result is not what the user wanted, restoreCheckpoint takes the project back in one step instead of many. A project that is not open in the editor cannot be edited until it has a checkpoint, since restoreCheckpoint is its only undo.",
	],
};

/**
 * The server's instructions: the capability block of the media tools, the
 * projects-and-checkpoints rules of this transport, then the in-app agent's editing
 * guidance, naming this server's edit switch, which holds back recording and export too.
 */
export function mcpInstructions(options: {
	transport: McpTransport;
	editsAllowed: boolean;
	/** The media tools' preamble. Both servers register them; only the app's channel for
	 *  `openscreen mcp` (app-channel.ts), which no agent reads, goes without. */
	media?: string;
	/** The transcribe tool is served. */
	transcribe?: boolean;
}): string {
	const { transport, editsAllowed, media } = options;
	const preamble = [
		...(media ? [media] : []),
		...CORE_PREAMBLES[transport],
		CHECKPOINT_LIFETIMES[transport],
		...(media && !editsAllowed
			? [
					`startRecording, exportVideo and createProject are refused too while ${MCP_EDITS_SETTING} is off.`,
				]
			: []),
		...(options.transcribe ? [TRANSCRIBE_NOTE] : []),
		EFFECTS_NOTE,
		"",
	].join("\n");
	return (
		preamble +
		buildSystemPrompt({ editsAllowed, editsSetting: MCP_EDITS_SETTING, canExport: !!media })
	);
}

function checkpointTools(media: boolean) {
	const restore = [
		"Put the project back exactly as it was when createCheckpoint returned this checkpointId, discarding every edit made since, including the user's. Pass the same projectId as to createCheckpoint.",
		...(media ? ["It also puts back the pointer track setPointerTrack replaced."] : []),
		// Over stdio too: while the app runs, the restore goes through its editor.
		"On the project open in the editor it lands as one undo step, so the user can undo the restore itself.",
	].join(" ");
	return [
		{
			name: "createCheckpoint",
			description:
				"Save the current state of the project and return its checkpointId. Changes nothing. Call it before a series of edits so restoreCheckpoint can revert all of them in one step.",
			inputSchema: z.object({}),
			mutating: false,
		},
		{
			name: "restoreCheckpoint",
			description: restore,
			inputSchema: z.object({ checkpointId: z.string() }),
			mutating: true,
		},
	] as const;
}

/** A tool's answer, as both servers' tools give it. */
export function textResult(text: string, isError = false): CallToolResult {
	return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

/** A cursor sidecar an edit rewrites beside its video; `null` deletes it. */
export interface SidecarWrite {
	path: string;
	content: string | null;
}

/**
 * An edit a tool computes itself rather than through the document executor (setPointerTrack):
 * it gets the project as the runner read it and returns the new document, plus the sidecars
 * to write once that document is saved. It must write nothing itself.
 */
export type RunnerEdit = (
	document: AxcutDocument,
) => Promise<AgentToolExecution & { sidecars?: SidecarWrite[] }>;

export interface CallOptions {
	/** Computes the call's change in place of the executor. */
	edit?: RunnerEdit;
	editsAllowed: boolean;
}

/**
 * Runs one tool call. `editsAllowed` overrides `deps.editsAllowed()` for this call: the
 * app's channel for `openscreen mcp` edits whatever the in-app server's switch says.
 */
export type McpToolRunner = (
	name: string,
	args: unknown,
	options?: Partial<CallOptions>,
) => Promise<CallToolResult>;

async function readSidecar(file: string): Promise<string | null> {
	try {
		return await fs.readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
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
 * first just moved — a spurious conflict at best. The app builds one and shares
 * it, queue and checkpoints, between the in-app server and `openscreen mcp`.
 */
export function createToolRunner(deps: McpToolDeps): McpToolRunner {
	let queue: Promise<unknown> = Promise.resolve();
	/**
	 * Each checkpoint's document, and what each sidecar an edit rewrote since held before
	 * the first such write: `null` when there was no file. A sidecar no edit touched since
	 * is already as it was, so it needs no entry.
	 */
	const checkpoints = new Map<
		string,
		{ document: AxcutDocument; sidecars: Map<string, string | null> }
	>();

	function createCheckpoint(document: AxcutDocument): AgentToolExecution {
		const checkpointId = `cp_${randomUUID()}`;
		checkpoints.set(checkpointId, { document, sidecars: new Map() });
		// A Map iterates in insertion order: the first key is the oldest.
		for (const oldest of checkpoints.keys()) {
			if (checkpoints.size <= MAX_CHECKPOINTS) break;
			checkpoints.delete(oldest);
		}
		return { ok: true, resultJson: JSON.stringify({ checkpointId }) };
	}

	/** Hands the checkpoint back as the call's new document, saved like any edit. */
	function restoreCheckpoint(
		document: AxcutDocument,
		args: unknown,
		editsAllowed: boolean,
	): AgentToolExecution & { sidecars?: SidecarWrite[] } {
		if (!editsAllowed) {
			return {
				ok: false,
				resultJson: `Edits by MCP clients are turned off in OpenScreen, so the checkpoint was NOT restored. Ask the user to turn on ${MCP_EDITS_SETTING}, or to undo the edits themselves.`,
			};
		}
		const id = (args as { checkpointId?: unknown } | null)?.checkpointId;
		const checkpoint = typeof id === "string" ? checkpoints.get(id) : undefined;
		if (!checkpoint) {
			return {
				ok: false,
				resultJson: `Unknown checkpointId. ${CHECKPOINT_LIFETIMES[deps.transport]}`,
			};
		}
		if (checkpoint.document.project.id !== document.project.id) {
			return {
				ok: false,
				resultJson: `The edit was NOT applied: this checkpoint belongs to another project than the one this call acts on. Pass projectId "${checkpoint.document.project.id}".`,
			};
		}
		return {
			ok: true,
			resultJson: JSON.stringify({ ok: true, restored: id }),
			document: keepTranscriptsMadeSince(checkpoint.document, document),
			sidecars: [...checkpoint.sidecars].map(([path, content]) => ({ path, content })),
		};
	}

	function hasCheckpoint(projectId: string): boolean {
		for (const checkpoint of checkpoints.values()) {
			if (checkpoint.document.project.id === projectId) return true;
		}
		return false;
	}

	/**
	 * Writes an edit's sidecars, first keeping what each held for the project's checkpoints.
	 * Runs once the document is saved, so a failure here is a partial edit, said as one.
	 */
	async function writeSidecars(
		projectId: string,
		writes: readonly SidecarWrite[] = [],
	): Promise<CallToolResult | null> {
		try {
			for (const { path, content } of writes) {
				const before = await readSidecar(path);
				for (const checkpoint of checkpoints.values()) {
					if (checkpoint.document.project.id === projectId && !checkpoint.sidecars.has(path)) {
						checkpoint.sidecars.set(path, before);
					}
				}
				if (content === null) await fs.rm(path, { force: true });
				else await fs.writeFile(path, content, "utf8");
			}
			return null;
		} catch (error) {
			return textResult(
				`The project was saved, but the pointer track beside its video was NOT written: ${errorMessage(error)}. Call this tool again to write it, or restoreCheckpoint to take the project back.`,
				true,
			);
		}
	}

	async function listProjects(): Promise<CallToolResult> {
		const [projects, snapshot, openElsewhereId] = await Promise.all([
			deps.projects.listProjects(),
			deps.host.snapshot(),
			deps.projects.projectOpenInEditor(),
		]);
		const openId = openProjectId(snapshot);
		const listed = projects.map((project) => ({
			...project,
			open: project.id === openId || project.id === openElsewhereId,
		}));
		return textResult(JSON.stringify({ projects: listed }), false);
	}

	/** The project open in the editor: read and written through the editor itself. */
	async function runOnEditor(
		snapshot: McpDocumentSnapshot,
		name: string,
		args: unknown,
		call: CallOptions,
	): Promise<CallToolResult> {
		const parsed = documentSchema.safeParse(snapshot.document);
		if (!parsed.success) {
			return textResult("The project open in the editor could not be read.", true);
		}
		const execution = await execute(parsed.data, name, args, call);
		if (execution.document) {
			const applied = await deps.host.apply(execution.document, snapshot.revision);
			if (applied !== "applied") return textResult(APPLY_FAILURE_MESSAGES[applied], true);
			const partial = await writeSidecars(execution.document.project.id, execution.sidecars);
			if (partial) return partial;
		}
		return textResult(execution.resultJson, !execution.ok);
	}

	/** Any other project: read from and saved to its file. */
	async function runOnFile(
		projectId: string,
		read: ProjectRead,
		name: string,
		args: unknown,
		call: CallOptions,
	): Promise<CallToolResult> {
		const execution = await execute(read.document, name, args, call);
		if (execution.document) {
			// An editor this server cannot reach (the app, beside `openscreen mcp`) holds
			// it and would save over this edit. Checked again just before the write.
			if ((await deps.projects.projectOpenInEditor()) === projectId) {
				return textResult(new ProjectOpenInEditorError(projectId).message, true);
			}
			// A restore IS the way back, so it needs no checkpoint of its own; a transcript is
			// no edit to take back (restoreCheckpoint keeps it), so it needs none either.
			if (name !== "restoreCheckpoint" && name !== TRANSCRIBE_TOOL && !hasCheckpoint(projectId)) {
				return textResult(CHECKPOINT_REQUIRED_MESSAGES[deps.transport], true);
			}
			// Refused if anything read the project since (the editor opening it would
			// otherwise drop this edit on its next save) or saved it, inside the app or
			// not: see saveProjectIfUnchanged.
			if (!(await deps.projects.saveProjectIfUnchanged(execution.document, read.version))) {
				return textResult(PROJECT_CHANGED_MESSAGE, true);
			}
			// After the save, so an edit refused above has written nothing at all.
			const partial = await writeSidecars(projectId, execution.sidecars);
			if (partial) return partial;
		}
		return textResult(execution.resultJson, !execution.ok);
	}

	async function execute(
		document: AxcutDocument,
		name: string,
		args: unknown,
		{ edit, editsAllowed }: CallOptions,
	): Promise<AgentToolExecution & { sidecars?: SidecarWrite[] }> {
		if (name === "createCheckpoint") return createCheckpoint(document);
		if (name === "restoreCheckpoint") return restoreCheckpoint(document, args, editsAllowed);
		// This server's own switch, so the refusal names it rather than the in-app agent's.
		if ((edit || isMutatingTool(name) || PROJECT_EDIT_TOOLS.has(name)) && !editsAllowed) {
			return consentRequired(name, args, MCP_EDITS_SETTING);
		}
		if (edit) return edit(document);
		if (name === SET_PROJECT_INFO_TOOL) return setProjectInfo(document, args);
		if (name === REMOVE_MEDIA_TOOL) return removeMedia(document, args);
		const availableByAssetId = await probeCursorTelemetry(document, deps.cursor);
		return runDocumentTool(document, name, args, editsAllowed, {
			cursor: deps.cursor,
			availableByAssetId,
			cameraSegmentation: deps.cameraSegmentation,
			checkShaderEffect: deps.checkShaderEffect,
		});
	}

	async function run(name: string, rawArgs: unknown, call: CallOptions): Promise<CallToolResult> {
		if (name === LIST_PROJECTS_TOOL) return listProjects();
		const { projectId, args } = splitProjectId(rawArgs);
		if (projectId === undefined) {
			const snapshot = await deps.host.snapshot();
			return snapshot
				? runOnEditor(snapshot, name, args, call)
				: textResult(NO_PROJECT_MESSAGES[deps.transport], true);
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
			return runOnEditor(snapshot, name, args, call);
		}
		if (!read) {
			return textResult(
				`No project has the id "${projectId}". Call listProjects for the valid ids.`,
				true,
			);
		}
		return runOnFile(projectId, read, name, args, call);
	}

	/** Whisper runs one transcription at a time; this runner's wait their turn here. */
	let whisperQueue: Promise<unknown> = Promise.resolve();

	/** Lands a change computed outside the queue, as an edit of the project as it is by then. */
	function landEdit(projectId: string, editsAllowed: boolean, edit: RunnerEdit) {
		return runner(TRANSCRIBE_TOOL, { projectId }, { editsAllowed, edit });
	}

	/**
	 * The transcribe tool. Whisper takes minutes, so it runs OUTSIDE the queue: other calls
	 * go on meanwhile, and only the landing of the transcript is queued, as an edit of the
	 * project as it is by then. The project open in the editor is transcribed by the editor's
	 * own job instead, so the two never run the same transcription side by side.
	 */
	async function transcribe(rawArgs: unknown, editsAllowed: boolean): Promise<CallToolResult> {
		const { projectId, args } = splitProjectId(rawArgs);
		const parsed = transcribeArgs.safeParse(args ?? {});
		if (!parsed.success) return textResult(JSON.stringify({ error: parsed.error.message }), true);
		if (!editsAllowed) {
			return textResult(consentRequired(TRANSCRIBE_TOOL, args, MCP_EDITS_SETTING).resultJson, true);
		}
		const { language } = parsed.data;
		const snapshot = await deps.host.snapshot();
		const openId = openProjectId(snapshot);
		const targetId = projectId ?? openId;
		if (!targetId) return textResult(NO_PROJECT_MESSAGES[deps.transport], true);
		const onEditor = openId === targetId;
		let document: AxcutDocument;
		if (onEditor) {
			const read = documentSchema.safeParse(snapshot?.document);
			if (!read.success) {
				return textResult("The project open in the editor could not be read.", true);
			}
			document = read.data;
		} else {
			const read = await deps.projects.getProjectForUpdate(targetId).catch((error) => {
				if (error instanceof DocumentNotFoundError) return null;
				throw error;
			});
			if (!read) {
				return textResult(
					`No project has the id "${targetId}". Call listProjects for the valid ids.`,
					true,
				);
			}
			document = read.document;
		}
		const assetId =
			parsed.data.assetId ?? document.project.primaryAssetId ?? document.assets[0]?.id;
		const asset = document.assets.find((a) => a.id === assetId);
		if (!asset) {
			return textResult(
				JSON.stringify({
					error: `Unknown asset: ${assetId ?? "(none)"}. The project has: ${document.assets.map((a) => a.id).join(", ") || "no assets"}.`,
				}),
				true,
			);
		}
		if (onEditor && deps.host.transcribe) {
			return editorTranscription(
				await deps.host.transcribe(targetId, asset.id, language),
				asset.id,
			);
		}
		const existing = document.transcripts.find((t) => t.assetId === asset.id);
		if (language === undefined && existing) {
			return textResult(JSON.stringify({ ...transcriptSummary(existing), unchanged: true }));
		}
		// An editor this process cannot reach would save over the transcript: say so now,
		// not after minutes of Whisper.
		if ((await deps.projects.projectOpenInEditor()) === targetId) {
			return textResult(new ProjectOpenInEditorError(targetId).message, true);
		}
		const whisper = deps.transcribe;
		if (!whisper) return textResult("Transcription is not available here.", true);
		const started = whisperQueue.then(async () => {
			// Read again once it is this call's turn: a vocabulary set while it waited counts.
			const current = await deps.projects
				.getProjectForUpdate(targetId)
				.then((read) => read.document)
				.catch((error) => {
					// Deleted while it waited: no Whisper on a file nobody owns any more.
					if (error instanceof DocumentNotFoundError) throw error;
					return document;
				});
			const media = current.assets.find((a) => a.id === asset.id);
			if (!media) throw new Error(`Asset ${asset.id} was removed from the project.`);
			return whisper({
				sourcePath: media.originalPath,
				language: language === "auto" ? undefined : language,
				prompt: current.project.vocabulary,
			});
		});
		whisperQueue = started.catch(() => undefined);
		let response: SttTranscribeResponse;
		try {
			response = await started;
		} catch (error) {
			if (error instanceof DocumentNotFoundError) {
				return textResult(
					`Project ${targetId} was deleted before its transcription started.`,
					true,
				);
			}
			const failure = classifyTranscriptionError(error);
			// Remembered on the asset as the editor remembers it: best effort, the answer stands.
			await landEdit(targetId, editsAllowed, async (current) => {
				const next = withTranscriptionFailure(current, asset.id, failure);
				return { ok: true, resultJson: "", ...(next === current ? {} : { document: next }) };
			});
			return textResult(
				JSON.stringify({
					error: `The transcription failed: ${failure.message}`,
					failure: { kind: failure.kind, message: failure.message },
				}),
				true,
			);
		}
		const transcript = transcriptFromSegments(
			asset.id,
			segmentsFromStt(response).segments,
			response.detectedLanguage ?? language,
		);
		return landEdit(targetId, editsAllowed, async (current) => {
			if (!current.assets.some((a) => a.id === asset.id)) {
				return {
					ok: false,
					resultJson: JSON.stringify({
						error: `Asset ${asset.id} was removed from the project while it was transcribed.`,
					}),
				};
			}
			const landed = applyTranscriptionResult(current, transcript);
			return {
				ok: true,
				document: landed.document,
				resultJson: JSON.stringify({
					...transcriptSummary(transcript),
					...(landed.dropped > 0 ? { correctionsLost: landed.dropped } : {}),
				}),
			};
		});
	}

	const runner: McpToolRunner = (name, args, options = {}) => {
		if (name === TRANSCRIBE_TOOL && !options.edit) {
			return transcribe(args, options.editsAllowed ?? deps.editsAllowed()).catch((error) =>
				textResult(`Tool failed: ${errorMessage(error)}`, true),
			);
		}
		// The setting is read when the call's turn comes: it may change while it waits.
		const runNow = async () => {
			const editsAllowed = options.editsAllowed ?? deps.editsAllowed();
			let edit = options.edit;
			// The file is checked and probed before the project is read: see prepareImportMedia.
			if (name === IMPORT_MEDIA_TOOL && !edit && editsAllowed) {
				const prepared = await prepareImportMedia(splitProjectId(args).args, deps);
				if (typeof prepared === "string") return textResult(prepared, true);
				edit = prepared;
			}
			return run(name, args, { edit, editsAllowed });
		};
		const next = queue.then(runNow, runNow);
		queue = next.catch(() => undefined);
		return next.catch((error) => textResult(`Tool failed: ${errorMessage(error)}`, true));
	};
	return runner;
}

/** What a transcription made, in the terms a caller acts on. */
function transcriptSummary(transcript: AxcutDocument["transcripts"][number]) {
	return {
		assetId: transcript.assetId,
		language: transcript.language,
		words: transcript.words.length,
		...(transcript.words.length === 0 ? { note: "No speech was found in this media." } : {}),
	};
}

/** The editor's answer about a transcription it ran or waited for, as this tool's result. */
function editorTranscription(
	outcome: AiEditionMcpTranscription | "no-editor" | "timeout",
	assetId: string,
): CallToolResult {
	if (outcome === "timeout") {
		return textResult(
			"OpenScreen did not finish this transcription in time; it may still be running in the editor. Call getCurrentDocument later: assets[].hasTranscript says when it has landed.",
			true,
		);
	}
	if (outcome === "no-editor" || outcome.status === "unavailable") {
		return textResult(
			"The editor closed the project before its transcription finished. Call transcribe again with its projectId.",
			true,
		);
	}
	if (outcome.status === "failed") {
		return textResult(
			JSON.stringify({
				error: `The transcription failed: ${outcome.failure.message}`,
				failure: outcome.failure,
			}),
			true,
		);
	}
	return textResult(
		JSON.stringify({
			assetId,
			language: outcome.language,
			words: outcome.words,
			...(outcome.words === 0 ? { note: "No speech was found in this media." } : {}),
		}),
	);
}

/**
 * A transcript is the media read, not an edit to take back: a restore keeps the one an
 * asset was given since the checkpoint, where the checkpoint had none for it.
 */
function keepTranscriptsMadeSince(
	checkpoint: AxcutDocument,
	current: AxcutDocument,
): AxcutDocument {
	let restored = checkpoint;
	for (const transcript of current.transcripts) {
		const { assetId } = transcript;
		if (!restored.assets.some((a) => a.id === assetId)) continue;
		if (restored.transcripts.some((t) => t.assetId === assetId)) continue;
		restored = withTranscript(restored, transcript);
	}
	return restored;
}

export function createOpenScreenMcpServer(
	deps: McpToolDeps,
	runTool: McpToolRunner,
	/** The media tools (media-tools.ts), served by both servers but not the app's channel. */
	media?: MediaTools,
): McpServer {
	const server = new McpServer(
		{ name: MCP_SERVER_NAME, version: deps.version },
		{
			instructions: mcpInstructions({
				transport: deps.transport,
				editsAllowed: deps.editsAllowed(),
				media: media?.preamble,
				transcribe: deps.transcribe !== undefined,
			}),
		},
	);
	const projectIdArg = z.string().optional().describe(PROJECT_ID_DESCRIPTIONS[deps.transport]);
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
				inputSchema: schema.extend({ projectId: projectIdArg }),
				annotations: {
					readOnlyHint: !mutating,
					destructiveHint: DESTRUCTIVE_TOOLS.has(name),
					openWorldHint: false,
				},
			},
			(args: unknown) => runTool(name, args),
		);
	}
	for (const tool of PROJECT_TOOLS) {
		server.registerTool(
			tool.name,
			{
				description: tool.description,
				inputSchema: tool.inputSchema.extend({ projectId: projectIdArg }),
				annotations: {
					readOnlyHint: false,
					destructiveHint: tool.destructive,
					openWorldHint: false,
				},
			},
			(args: unknown) => runTool(tool.name, args),
		);
	}
	if (deps.transcribe) {
		server.registerTool(
			TRANSCRIBE_TOOL,
			{
				description: TRANSCRIBE_DESCRIPTION,
				inputSchema: transcribeArgs.extend({ projectId: projectIdArg }),
				annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			},
			(args: unknown) => runTool(TRANSCRIBE_TOOL, args),
		);
	}
	for (const tool of checkpointTools(media !== undefined)) {
		server.registerTool(
			tool.name,
			{
				description: tool.description,
				inputSchema: tool.inputSchema.extend({ projectId: projectIdArg }),
				annotations: {
					readOnlyHint: !tool.mutating,
					destructiveHint: tool.mutating,
					openWorldHint: false,
				},
			},
			(args: unknown) => runTool(tool.name, args),
		);
	}
	media?.register(server);
	// The effect contract: too long for addEffect's description, and versioned with the contract.
	server.registerResource(
		"effects-contract",
		EFFECTS_CONTRACT_URI,
		{
			title: "Shader effect contract",
			description:
				"The WGSL contract of addEffect: the inputs an effect reads, its parameters, the rules, the cost tiers and two examples.",
			mimeType: "text/markdown",
		},
		async (uri) => ({
			contents: [{ uri: uri.href, mimeType: "text/markdown", text: EFFECTS_CONTRACT }],
		}),
	);
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
	/** The app's shared runner (see createToolRunner); a fresh one when omitted. */
	runTool?: McpToolRunner;
	/** The media tools, built once: the take and the exports outlive each request. */
	media?: MediaTools;
}): Promise<RunningMcpServer> {
	const { token, deps } = options;
	const shared = options.runTool ?? createToolRunner(deps);
	// This server obeys its own switch: never pass an override through.
	const runTool = (name: string, args: unknown) => shared(name, args);
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
		// on every call, and what the media tools hold (the take, the exports) lives in
		// `media`, built once, so there is nothing a session would need to remember.
		const server = createOpenScreenMcpServer(deps, runTool, options.media);
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
