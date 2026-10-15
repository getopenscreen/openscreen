// How `openscreen mcp` reaches the running app, so the app stays the one writer of
// its projects (#1174). The project open in the editor is then edited through the
// editor, live and one Ctrl/Cmd+Z step per call, and both transports share the
// app's one tool runner: its queue and its checkpoints.
//
// The channel is MCP itself. The app serves the same `createOpenScreenMcpServer` on
// a named pipe (Windows) or a Unix socket, and `openscreen mcp` is its client: each
// document tool call is forwarded as a `tools/call` and its result handed back
// untouched. No second protocol to keep in step with the tools, and the handshake
// says which tools this app has, so a tool an older app lacks runs locally instead.
//
// Discovery: the app writes `<userData>/mcp-app.json` ({ pid, endpoint, token }) once
// it listens, and removes it as it quits. `openscreen mcp` shares that userData, reads
// the file on every call it is not connected for, and ignores it when the pid is gone
// or the endpoint does not answer: a crashed app's file is just stale.
//
// Trust: the endpoint answers only a client that first sends the token from that
// file. Node cannot set a named pipe's DACL, and the default one lets every user open
// it for reading (not writing); the token is what limits the channel to the current
// user, as the file sits in their profile (0600 on Unix, the socket too). Admins and
// SYSTEM can read it, but they can do anything the user can already. Any process of
// this user may connect, which grants nothing new: it could run `openscreen mcp`.
// So calls over this channel edit as `openscreen mcp` does, whatever the in-app
// server's switches say: those guard the HTTP port, which is not ours to bypass.

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { isMutatingTool } from "../ai-edition/agent-tools";
import { isProcessAlive } from "../ai-edition/document-service";
import { renameSyncWithFallback } from "../atomic-rename";
import {
	FORWARDED_POINTER_TRACK_SCHEMA,
	POINTER_TRACK_TOOL,
	pointerTrackEdit,
} from "./media-tools";
import {
	createOpenScreenMcpServer,
	LIST_PROJECTS_TOOL,
	type McpToolDeps,
	type McpToolRunner,
	TRANSCRIBE_TOOL,
} from "./openscreen-mcp-server";
import { PROJECT_EDIT_TOOLS } from "./project-tools";

const DISCOVERY_FILE = "mcp-app.json";
/** Connect, token and MCP handshake: the app answers in milliseconds when it is alive. */
const CONNECT_TIMEOUT_MS = 3_000;
// Above the editor's own 30 s for a snapshot plus 30 s for an apply.
const CALL_TIMEOUT_MS = 90_000;
// Whisper over a whole recording: above the editor's own hour for it.
const TRANSCRIBE_TIMEOUT_MS = 65 * 60_000;
const MAX_TOKEN_LINE_BYTES = 256;
const MAX_ANSWER_BYTES = 256 * 1024 * 1024;

const LOST_MESSAGE =
	"OpenScreen stopped answering during this call, so whether it took effect is unknown. Call getCurrentDocument with the same projectId to check before retrying.";

interface Discovery {
	pid: number;
	endpoint: string;
	token: string;
}

export function discoveryFilePath(userDataDir: string): string {
	return path.join(userDataDir, DISCOVERY_FILE);
}

function newEndpoint(userDataDir: string): string {
	// A fresh pipe name per launch: no other user can create it first to pose as the app.
	if (process.platform === "win32") return `\\\\.\\pipe\\openscreen-mcp-${randomUUID()}`;
	// ponytail: a socket path is capped near 104 bytes; a longer userData fails to listen
	// and `openscreen mcp` keeps working on files. Move it to the runtime dir if that bites.
	return path.join(userDataDir, "mcp.sock");
}

function sameSecret(presented: string, token: string): boolean {
	const a = Buffer.from(presented);
	const b = Buffer.from(token);
	return a.length === b.length && timingSafeEqual(a, b);
}

export interface AppChannel {
	endpoint: string;
	/** Synchronous, so it completes as the app quits. */
	close(): void;
}

/**
 * The app's side: serve the document tools to `openscreen mcp` through `runTool`, the
 * runner the in-app server uses too. Started by the GUI only, under its single-instance
 * lock, so no other process serves this userData.
 */
export async function serveAppChannel(options: {
	userDataDir: string;
	deps: McpToolDeps;
	runTool: McpToolRunner;
}): Promise<AppChannel> {
	const token = randomBytes(32).toString("hex");
	const endpoint = newEndpoint(options.userDataDir);
	const deps: McpToolDeps = { ...options.deps, editsAllowed: () => true };
	const runTool = (name: string, args: unknown) =>
		options.runTool(name, args, { editsAllowed: true });
	const sockets = new Set<net.Socket>();

	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		socket.on("error", () => socket.destroy());
		// A client that never says the token is cut off.
		socket.setTimeout(CONNECT_TIMEOUT_MS, () => socket.destroy());
		let head = Buffer.alloc(0);
		const onData = (chunk: Buffer) => {
			head = Buffer.concat([head, chunk]);
			const end = head.indexOf(0x0a);
			if (end < 0) {
				if (head.length > MAX_TOKEN_LINE_BYTES) socket.destroy();
				return;
			}
			socket.off("data", onData);
			socket.setTimeout(0);
			if (!sameSecret(head.subarray(0, end).toString("utf8"), token)) {
				socket.destroy();
				return;
			}
			// What followed the token on the wire is already MCP.
			const input = new PassThrough();
			input.write(head.subarray(end + 1));
			socket.pipe(input);
			const session = createOpenScreenMcpServer(deps, runTool);
			// Not the media tools' own setPointerTrack: `openscreen mcp` records its takes itself,
			// so the call carries their start times. The edit is computed in this process from
			// them, then run like any edit.
			session.registerTool(
				POINTER_TRACK_TOOL,
				{ inputSchema: FORWARDED_POINTER_TRACK_SCHEMA },
				({ projectId, events, takes }) =>
					options.runTool(
						POINTER_TRACK_TOOL,
						{ projectId },
						{ editsAllowed: true, edit: (document) => pointerTrackEdit(document, events, takes) },
					),
			);
			socket.once("close", () => void session.close());
			// A JSON-RPC-lines transport over any stream pair, despite its name.
			session.connect(new StdioServerTransport(input, socket)).catch(() => socket.destroy());
		};
		socket.on("data", onData);
	});

	if (process.platform !== "win32") rmSync(endpoint, { force: true }); // a crashed app's
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(endpoint, () => {
			server.off("error", reject);
			resolve();
		});
	});
	if (process.platform !== "win32") chmodSync(endpoint, 0o600);

	const file = discoveryFilePath(options.userDataDir);
	const temp = `${file}.tmp-${process.pid}`;
	writeFileSync(temp, JSON.stringify({ pid: process.pid, endpoint, token } satisfies Discovery), {
		encoding: "utf8",
		mode: 0o600,
	});
	renameSyncWithFallback(temp, file);

	return {
		endpoint,
		close() {
			rmSync(file, { force: true });
			server.close();
			for (const socket of sockets) socket.destroy();
		},
	};
}

async function readDiscovery(userDataDir: string): Promise<Discovery | null> {
	const raw = await fs.readFile(discoveryFilePath(userDataDir), "utf8").catch(() => null);
	if (raw === null) return null;
	try {
		const found = JSON.parse(raw) as Partial<Discovery>;
		if (
			typeof found.pid !== "number" ||
			typeof found.endpoint !== "string" ||
			typeof found.token !== "string"
		) {
			return null;
		}
		return isProcessAlive(found.pid) ? (found as Discovery) : null;
	} catch {
		return null;
	}
}

interface AppConnection {
	client: Client;
	/** The tools this app serves: an older app may lack one. */
	tools: Set<string>;
	closed: boolean;
	drop(): void;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error("timed out")), ms);
	});
	return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

/** The running app, or `null` when there is none or it does not answer. */
export async function connectToApp(
	userDataDir: string,
	version: string,
): Promise<AppConnection | null> {
	const found = await readDiscovery(userDataDir);
	if (!found) return null;
	const socket = net.createConnection(found.endpoint);
	const client = new Client({ name: "openscreen-mcp", version });
	const connection: AppConnection = {
		client,
		tools: new Set(),
		closed: false,
		drop() {
			connection.closed = true;
			socket.destroy();
		},
	};
	socket.on("error", () => socket.destroy());
	// Rejects whatever is in flight at once, rather than at its timeout.
	socket.once("close", () => {
		connection.closed = true;
		void client.close();
	});
	try {
		await withTimeout(
			new Promise<void>((resolve, reject) => {
				socket.once("connect", resolve);
				socket.once("error", reject);
			}),
			CONNECT_TIMEOUT_MS,
		);
		socket.write(`${found.token}\n`);
		// Answers carry whole documents: well above the SDK's 10 MiB default.
		const transport = new StdioServerTransport(socket, socket, { maxBufferSize: MAX_ANSWER_BYTES });
		await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
		const { tools } = await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS });
		for (const tool of tools) connection.tools.add(tool.name);
		return connection;
	} catch {
		connection.drop();
		return null;
	}
}

/** A call that changes nothing, so running it again here after a lost answer is safe. */
function isReadOnly(name: string): boolean {
	if (name === LIST_PROJECTS_TOOL) return true;
	if (name === "createCheckpoint" || name === "restoreCheckpoint" || name === TRANSCRIBE_TOOL) {
		return false;
	}
	return !isMutatingTool(name) && !PROJECT_EDIT_TOOLS.has(name);
}

/**
 * `openscreen mcp`'s runner: each call goes to the running app when there is one, and
 * to `local` (this process, on files) when there is none. Routed per call, so the app
 * starting or quitting mid-session is picked up on the next call. A call the app
 * received but never answered is not run again here unless it changes nothing: it may
 * have landed, and running it twice is worse than saying so.
 */
export function routeToApp(options: {
	userDataDir: string;
	version: string;
	local: McpToolRunner;
}): McpToolRunner {
	let current: AppConnection | null = null;
	let connecting: Promise<AppConnection | null> | null = null;

	async function app(): Promise<AppConnection | null> {
		if (current && !current.closed) return current;
		connecting ??= connectToApp(options.userDataDir, options.version).finally(() => {
			connecting = null;
		});
		current = await connecting;
		return current;
	}

	return async (name, args, call) => {
		const connection = await app();
		// A runner edit is a closure: it travels only as a tool the app serves (setPointerTrack's
		// args carry what it needs), and `call` is dropped once forwarded.
		if (!connection?.tools.has(name)) return options.local(name, args, call);
		try {
			return (await connection.client.callTool(
				{ name, arguments: (args ?? {}) as Record<string, unknown> },
				undefined,
				{ timeout: name === TRANSCRIBE_TOOL ? TRANSCRIBE_TIMEOUT_MS : CALL_TIMEOUT_MS },
			)) as CallToolResult;
		} catch {
			// Closed or timed out: a hung app must not hold every later call too.
			connection.drop();
			if (!call?.edit && isReadOnly(name)) return options.local(name, args, call);
			return { content: [{ type: "text", text: LOST_MESSAGE }], isError: true };
		}
	};
}
