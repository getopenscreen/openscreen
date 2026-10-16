// `openscreen mcp`: the MCP tools on stdin/stdout, for the agent that started
// this process. The document tools are the in-app server's own, run by the same
// executor; the media tools around them record, export and look at the result.
//
// When the OpenScreen app runs, it is the authority: each document tool call is
// forwarded to it (app-channel.ts), so the project open in its editor is edited
// there, live, and checkpoints live in one place. With no app, the calls run here
// on the project files, where no editor can hold one.
//
// No port and no token: the client launched this process itself, with the
// user's rights, as it would launch `openscreen record` or `openscreen export`.
// For the same reason it may edit, record and export, where the in-app server waits
// for the user to allow it: there is no other caller to keep out.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { DocumentService } from "../ai-edition/document-service";
import { openStdin } from "../cli/stdin";
import { routeToApp } from "./app-channel";
import { createMediaTools, type MediaToolDeps } from "./media-tools";
import {
	createOpenScreenMcpServer,
	createToolRunner,
	type McpToolDeps,
} from "./openscreen-mcp-server";

export async function serveMcpOverStdio(options: {
	mcpToolDeps: McpToolDeps;
	documents: DocumentService;
	/** Shared with the app: where its channel is announced. */
	userDataDir: string;
	readCursorTelemetry: MediaToolDeps["readCursor"];
	runners: MediaToolDeps["runners"];
	openVideo: MediaToolDeps["openVideo"];
	renderFrames?: MediaToolDeps["renderFrames"];
	/** The client went away: nothing is left to serve. */
	onClose(): void;
}): Promise<void> {
	const deps: McpToolDeps = {
		...options.mcpToolDeps,
		transport: "stdio",
		editsAllowed: () => true,
	};
	// The media tools' own document calls (stopRecording's checkpoint, setPointerTrack)
	// take the same route.
	const runTool = routeToApp({
		userDataDir: options.userDataDir,
		version: deps.version,
		local: createToolRunner(deps),
	});
	const media = createMediaTools({
		transport: "stdio",
		editsAllowed: () => true,
		runners: options.runners,
		documents: options.documents,
		openVideo: options.openVideo,
		renderFrames: options.renderFrames,
		readCursor: options.readCursorTelemetry,
		runTool,
	});
	const server = createOpenScreenMcpServer(deps, runTool, media);
	const stdin = openStdin();
	// The transport only reads stdin; a client that exits just closes it. A pipe can
	// report that as "end", "close" or "error", depending on how the client went.
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		options.onClose();
	};
	stdin.once("end", close);
	stdin.once("close", close);
	stdin.once("error", close);
	await server.connect(new StdioServerTransport(stdin, process.stdout));
}
