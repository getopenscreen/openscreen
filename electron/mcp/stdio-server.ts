// `openscreen mcp`: the MCP tools on stdin/stdout, for the agent that started
// this process. The document tools are the in-app server's own, run by the same
// executor; the media tools around them record, export and look at the result.
//
// No port and no token: the client launched this process itself, with the
// user's rights, as it would launch `openscreen record` or `openscreen export`.
// For the same reason it may edit, where the in-app server waits for the user to
// allow it: there is no other caller to keep out.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { DocumentService } from "../ai-edition/document-service";
import { openStdin } from "../cli/stdin";
import { MEDIA_PREAMBLE, type MediaToolDeps, registerMediaTools } from "./media-tools";
import {
	createOpenScreenMcpServer,
	createToolRunner,
	type McpToolDeps,
} from "./openscreen-mcp-server";

export async function serveMcpOverStdio(options: {
	mcpToolDeps: McpToolDeps;
	documents: DocumentService;
	readCursorTelemetry: MediaToolDeps["readCursor"];
	runners: MediaToolDeps["runners"];
	openVideo: MediaToolDeps["openVideo"];
	/** The client went away: nothing is left to serve. */
	onClose(): void;
}): Promise<void> {
	const deps: McpToolDeps = { ...options.mcpToolDeps, editsAllowed: () => true };
	const runTool = createToolRunner(deps);
	const server = createOpenScreenMcpServer(deps, runTool, MEDIA_PREAMBLE);
	registerMediaTools(server, {
		runners: options.runners,
		documents: options.documents,
		openVideo: options.openVideo,
		readCursor: options.readCursorTelemetry,
		runTool,
	});
	const stdin = openStdin();
	// The transport only reads stdin; a client that exits just closes it.
	stdin.once("end", options.onClose);
	await server.connect(new StdioServerTransport(stdin, process.stdout));
}
