import { useEffect } from "react";
import type { AiEditionMcpHostRequest, AiEditionMcpHostResponse } from "@/native/contracts";
import { applyAgentDocumentIfCurrent } from "./agentDocumentApply";
import { useProjectStore } from "./projectStore";

/**
 * The editor's side of the MCP server (electron/mcp/): hand it the live document
 * and apply what its tools return, through the same revision-guarded apply an
 * in-app chat turn uses — so an MCP edit is saved, is one undo step, and never
 * lands on top of a change the user made while the call was running.
 */
export async function answerMcpHostRequest(
	request: AiEditionMcpHostRequest,
): Promise<AiEditionMcpHostResponse["result"]> {
	const { document, revision } = useProjectStore.getState();
	if (request.op === "snapshot") {
		return document ? { document, revision } : null;
	}
	if (!document) return "no-live-document";
	// The revision counter restarts when a project is closed, so a quick close
	// and reopen of ANOTHER project can land on the revision the call was given.
	// The id is what tells the two apart.
	const incoming = request.document as { project?: { id?: unknown } } | null;
	if (incoming?.project?.id !== document.project.id) return "conflict";
	try {
		return await applyAgentDocumentIfCurrent(request.document, request.expectedRevision);
	} catch {
		return "save-failed";
	}
}

/** Makes this editor window the one the MCP server reads and writes, while mounted. */
export function useMcpDocumentHost(): void {
	useEffect(() => window.electronAPI?.onAiEditionMcpRequest?.(answerMcpHostRequest), []);
	// `openscreen mcp` runs in a process of its own and cannot ask this window, so the
	// main process records the open project where it can read it (#1138).
	const openProjectId = useProjectStore((state) => state.document?.project.id ?? null);
	useEffect(() => window.electronAPI?.setAiEditionOpenProject?.(openProjectId), [openProjectId]);
	useEffect(() => () => window.electronAPI?.setAiEditionOpenProject?.(null), []);
}
