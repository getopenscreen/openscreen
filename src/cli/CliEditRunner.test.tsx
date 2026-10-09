// @vitest-environment jsdom
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorFileSession } from "@/components/ai-edition/fileSession";
import {
	normalizeProjectEditor,
	PROJECT_VERSION,
} from "@/components/video-editor/projectPersistence";
import { migrateProjectDataToAxcutDocument } from "@/lib/ai-edition/document/migrate";
import CliEditRunner from "./CliEditRunner";

const shell = vi.hoisted(() => ({ session: undefined as EditorFileSession | undefined }));
vi.mock("@/components/ai-edition/NewEditorShell", () => ({
	NewEditorShell: ({ fileSession }: { fileSession: EditorFileSession }) => {
		shell.session = fileSession;
		return null;
	},
}));

beforeEach(() => {
	shell.session = undefined;
	window.electronAPI = {
		cliGetRequest: vi.fn(async () => ({
			kind: "edit",
			projectPath: "/take.openscreen",
			outPath: null,
		})),
		cliDone: vi.fn(async () => undefined),
	} as unknown as typeof window.electronAPI;
});

describe("CliEditRunner", () => {
	it("waits for the editor to finish before returning a document to the main process", async () => {
		render(<CliEditRunner />);
		await waitFor(() => expect(shell.session?.projectPath).toBe("/take.openscreen"));
		expect(window.electronAPI.cliDone).not.toHaveBeenCalled();
		const document = migrateProjectDataToAxcutDocument({
			version: PROJECT_VERSION,
			media: { screenVideoPath: "/take.mp4" },
			editor: normalizeProjectEditor({}),
		});
		await shell.session!.onFinish(document);
		expect(window.electronAPI.cliDone).toHaveBeenCalledWith({
			success: true,
			projectPath: "/take.openscreen",
			projectData: document,
		});
	});

	it("reports a load failure and does not offer a successful completion", async () => {
		render(<CliEditRunner />);
		await waitFor(() => expect(shell.session).toBeDefined());
		shell.session!.onLoadError(new Error("Missing project"));
		expect(window.electronAPI.cliDone).toHaveBeenCalledWith({
			success: false,
			error: "Missing project",
		});
	});

	it("reports a request for the wrong runner", async () => {
		vi.mocked(window.electronAPI.cliGetRequest).mockResolvedValue({ kind: "sources" });
		render(<CliEditRunner />);
		await waitFor(() =>
			expect(window.electronAPI.cliDone).toHaveBeenCalledWith({
				success: false,
				error: "cli-edit window received a sources request",
			}),
		);
		expect(shell.session).toBeUndefined();
	});
});
