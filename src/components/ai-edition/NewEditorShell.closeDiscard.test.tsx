// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const importMock = vi.hoisted(() => ({
	importPendingRecording: vi.fn<() => Promise<string | null>>(async () => null),
	maybeSaveFreshRecordingAutoZooms: vi.fn(),
}));

vi.mock("./recordingImport", () => ({
	importPendingRecording: importMock.importPendingRecording,
	maybeSaveFreshRecordingAutoZooms: importMock.maybeSaveFreshRecordingAutoZooms,
}));

const bridgeMock = vi.hoisted(() => ({
	recordings: vi.fn(async () => ({
		success: true,
		count: 1,
		sizeBytes: 1024,
		keptFor: [],
		unreadable: 0,
	})),
}));

vi.mock("@/native/client", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/native/client")>();
	return {
		...actual,
		nativeBridgeClient: {
			...actual.nativeBridgeClient,
			aiEdition: {
				...actual.nativeBridgeClient.aiEdition,
				recordings: bridgeMock.recordings,
			},
		},
	};
});

vi.mock("@/contexts/ShortcutsContext", async () => {
	const { DEFAULT_SHORTCUTS } = await import("@/lib/shortcuts");
	return {
		useShortcuts: () => ({
			shortcuts: DEFAULT_SHORTCUTS,
			isMac: false,
			isConfigOpen: false,
			openConfig: vi.fn(),
			closeConfig: vi.fn(),
			setShortcuts: vi.fn(),
			persistShortcuts: () => Promise.resolve(true),
		}),
	};
});

vi.mock("@/contexts/I18nContext", () => ({
	useI18n: () => ({
		locale: "en",
		setLocale: vi.fn(),
	}),
	useScopedT: () => (key: string) => key,
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { EditorDialogsProvider } from "@/contexts/EditorDialogsContext";
import { createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { NewEditorShell } from "./NewEditorShell";

let nativeClose: () => void = () => undefined;
let nativeSaveBeforeClose: () => Promise<boolean> | boolean = () => true;
const setHasDiscardableProject = vi.fn();
const sendCloseConfirmResponse = vi.fn();
const originalSave = useProjectStore.getState().saveDocument;

function renderShell() {
	return render(
		<TooltipProvider>
			<EditorDialogsProvider>
				<NewEditorShell />
			</EditorDialogsProvider>
		</TooltipProvider>,
	);
}

beforeEach(() => {
	importMock.importPendingRecording.mockReset().mockResolvedValue(null);
	bridgeMock.recordings.mockClear();
	setHasDiscardableProject.mockClear();
	sendCloseConfirmResponse.mockClear();
	useProjectStore.setState({ document: null, projectId: null, dirty: false });

	(window as unknown as { electronAPI?: unknown }).electronAPI = {
		onAiEditionChatEvent: () => () => undefined,
		setTitleBarOverlay: vi.fn(),
		setHasUnsavedChanges: vi.fn(),
		setHasDiscardableProject,
		onRequestCloseConfirm: (listener: () => void) => {
			nativeClose = listener;
			return () => undefined;
		},
		onRequestSaveBeforeClose: (listener: () => Promise<boolean> | boolean) => {
			nativeSaveBeforeClose = listener;
			return () => undefined;
		},
		sendCloseConfirmResponse,
		findRecordingCamera: () => Promise.resolve(null),
		preparePreviewAudioTrack: () => Promise.resolve(null),
	};
	Element.prototype.scrollTo = () => undefined;
	(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver = class {
		observe() {
			/* no layout in jsdom */
		}
		unobserve() {
			/* no layout in jsdom */
		}
		disconnect() {
			/* no layout in jsdom */
		}
	};
});

afterEach(() => {
	cleanup();
	useProjectStore.setState({
		document: null,
		projectId: null,
		dirty: false,
		saveDocument: originalSave,
	});
	(window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
});

describe("NewEditorShell close discard flow", () => {
	it("marks fresh recording discardable and sends discard-project on confirm", async () => {
		const doc = createEmptyDocument({ projectId: "proj_fresh_rec", title: "Fresh" });
		importMock.importPendingRecording.mockImplementationOnce(async () => {
			useProjectStore.setState({ document: doc, projectId: doc.project.id, dirty: false });
			return doc.project.id;
		});

		renderShell();
		await waitFor(() => expect(setHasDiscardableProject).toHaveBeenCalledWith(true));

		await act(async () => {
			nativeClose();
		});

		expect(screen.getByRole("dialog")).toHaveTextContent("closeProject.title");
		const discardBtn = screen.getByRole("button", { name: "closeProject.discardProject" });
		await waitFor(() => expect(discardBtn).not.toBeDisabled());

		await act(async () => {
			fireEvent.click(discardBtn);
		});

		expect(sendCloseConfirmResponse).toHaveBeenCalledWith({
			choice: "discard-project",
			projectId: "proj_fresh_rec",
			recordings: "trash",
		});
	});

	it("clears discardable state on explicit save", async () => {
		const doc = createEmptyDocument({ projectId: "proj_fresh_save", title: "Fresh" });
		const saveDocument = vi.fn(async () => {
			useProjectStore.setState({ dirty: false });
			return true;
		});
		useProjectStore.setState({ saveDocument });
		importMock.importPendingRecording.mockImplementationOnce(async () => {
			useProjectStore.setState({ document: doc, projectId: doc.project.id, dirty: false });
			return doc.project.id;
		});

		renderShell();
		await waitFor(() => expect(setHasDiscardableProject).toHaveBeenCalledWith(true));

		await act(async () => {
			fireEvent.keyDown(document.body, { key: "s", ctrlKey: true });
		});

		await waitFor(() => expect(saveDocument).toHaveBeenCalledOnce());
		expect(setHasDiscardableProject).toHaveBeenLastCalledWith(false);
	});

	it("cancels an open close-discard prompt when an in-flight explicit save completes", async () => {
		const doc = createEmptyDocument({ projectId: "proj_save_race", title: "Fresh" });
		let resolveSave!: (saved: boolean) => void;
		const saveDocument = vi.fn(
			() =>
				new Promise<boolean>((resolve) => {
					resolveSave = resolve;
				}),
		);
		useProjectStore.setState({ saveDocument });
		importMock.importPendingRecording.mockImplementationOnce(async () => {
			useProjectStore.setState({ document: doc, projectId: doc.project.id, dirty: false });
			return doc.project.id;
		});

		renderShell();
		await waitFor(() => expect(setHasDiscardableProject).toHaveBeenCalledWith(true));

		await act(async () => {
			fireEvent.keyDown(document.body, { key: "s", ctrlKey: true });
		});
		await act(async () => {
			nativeClose();
		});
		expect(screen.getByRole("dialog")).toHaveTextContent("closeProject.title");

		await act(async () => {
			resolveSave(true);
		});

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(sendCloseConfirmResponse).toHaveBeenCalledWith("cancel");
	});

	it("does not mark a switched-to project discardable when import resolves late", async () => {
		const otherDoc = createEmptyDocument({ projectId: "proj_other", title: "Other" });
		importMock.importPendingRecording.mockImplementationOnce(async () => {
			useProjectStore.setState({
				document: otherDoc,
				projectId: otherDoc.project.id,
				dirty: false,
			});
			return "proj_imported_stale";
		});

		renderShell();
		await waitFor(() => expect(importMock.importPendingRecording).toHaveBeenCalledOnce());
		expect(setHasDiscardableProject).not.toHaveBeenCalledWith(true);
	});

	it("does not restore discardable state when explicit save happened while import was pending", async () => {
		const doc = createEmptyDocument({ projectId: "proj_saved_mid_import", title: "Fresh" });
		let resolveImport!: (id: string | null) => void;
		const saveDocument = vi.fn(async () => {
			useProjectStore.setState({ dirty: false });
			return true;
		});
		useProjectStore.setState({ saveDocument });
		importMock.importPendingRecording.mockImplementationOnce(
			() =>
				new Promise<string | null>((resolve) => {
					useProjectStore.setState({ document: doc, projectId: doc.project.id, dirty: false });
					resolveImport = resolve;
				}),
		);

		renderShell();
		await act(async () => {
			fireEvent.keyDown(document.body, { key: "s", ctrlKey: true });
		});
		await waitFor(() => expect(saveDocument).toHaveBeenCalledOnce());

		await act(async () => {
			resolveImport(doc.project.id);
		});

		expect(setHasDiscardableProject).not.toHaveBeenCalledWith(true);
	});

	it("protects live edits in save-before-close", async () => {
		const doc = createEmptyDocument({ projectId: "proj_save_close", title: "SaveClose" });
		const saveDocument = vi.fn(async () => true);
		useProjectStore.setState({ document: doc, projectId: doc.project.id, saveDocument });

		renderShell();
		await act(async () => {
			await nativeSaveBeforeClose();
		});

		expect(saveDocument).toHaveBeenCalledWith(doc, { history: true, protectLiveEdits: true });
	});

	it("uses UnsavedChangesModal for existing dirty non-fresh projects", async () => {
		const doc = createEmptyDocument({ projectId: "proj_existing", title: "Existing" });
		renderShell();
		await act(async () => {
			useProjectStore.setState({ document: doc, projectId: doc.project.id, dirty: true });
			nativeClose();
		});

		expect(screen.getByRole("dialog")).toHaveTextContent("unsavedChanges.modal.closeTitle");
		expect(setHasDiscardableProject).not.toHaveBeenCalledWith(true);
	});
});
