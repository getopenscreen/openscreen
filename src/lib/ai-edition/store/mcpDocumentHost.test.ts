// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument } from "../schema";
import { answerMcpHostRequest, useMcpDocumentHost } from "./mcpDocumentHost";
import { useProjectStore } from "./projectStore";
import { clearHistory, undo } from "./undo";

const saveMock = vi.hoisted(() => vi.fn());

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		aiEdition: { save: saveMock },
	},
}));

function openProject(revision: number) {
	const document = createEmptyDocument({ projectId: "project_1", title: "Before" });
	useProjectStore.setState({ projectId: "project_1", document, revision });
	return document;
}

describe("answerMcpHostRequest", () => {
	beforeEach(() => {
		useProjectStore.getState().clear();
		clearHistory();
		saveMock.mockReset();
		saveMock.mockImplementation(async (document) => ({ success: true, document }));
	});

	it("snapshots the live document with its revision", async () => {
		const document = openProject(4);
		await expect(answerMcpHostRequest({ requestId: "r", op: "snapshot" })).resolves.toEqual({
			document,
			revision: 4,
		});
	});

	it("answers null when no project is open", async () => {
		await expect(answerMcpHostRequest({ requestId: "r", op: "snapshot" })).resolves.toBeNull();
	});

	it("applies an edit made against the current revision, as one undo step", async () => {
		const before = openProject(4);
		const edited = { ...before, project: { ...before.project, title: "MCP edit" } };
		await expect(
			answerMcpHostRequest({ requestId: "r", op: "apply", document: edited, expectedRevision: 4 }),
		).resolves.toBe("applied");
		expect(useProjectStore.getState().document?.project.title).toBe("MCP edit");
		undo();
		expect(useProjectStore.getState().document?.project.title).toBe("Before");
	});

	it("refuses an edit made against a stale revision", async () => {
		const before = openProject(5);
		const edited = { ...before, project: { ...before.project, title: "MCP edit" } };
		await expect(
			answerMcpHostRequest({ requestId: "r", op: "apply", document: edited, expectedRevision: 4 }),
		).resolves.toBe("conflict");
		expect(saveMock).not.toHaveBeenCalled();
	});

	it("refuses another project's document even at a matching revision", async () => {
		openProject(1);
		const other = createEmptyDocument({ projectId: "project_2", title: "Other" });
		await expect(
			answerMcpHostRequest({ requestId: "r", op: "apply", document: other, expectedRevision: 1 }),
		).resolves.toBe("conflict");
		expect(useProjectStore.getState().document?.project.title).toBe("Before");
	});

	it("reports no live document when the project was closed", async () => {
		const other = createEmptyDocument({ projectId: "project_1", title: "x" });
		await expect(
			answerMcpHostRequest({ requestId: "r", op: "apply", document: other, expectedRevision: 0 }),
		).resolves.toBe("no-live-document");
	});
});

describe("useMcpDocumentHost", () => {
	it("tells the main process which project the editor holds, and when it holds none (#1138)", () => {
		useProjectStore.getState().clear();
		const setAiEditionOpenProject = vi.fn();
		vi.stubGlobal("electronAPI", { setAiEditionOpenProject });
		try {
			const { unmount } = renderHook(() => useMcpDocumentHost());
			expect(setAiEditionOpenProject).toHaveBeenLastCalledWith(null);
			act(() => {
				openProject(0);
			});
			expect(setAiEditionOpenProject).toHaveBeenLastCalledWith("project_1");
			unmount();
			expect(setAiEditionOpenProject).toHaveBeenLastCalledWith(null);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
