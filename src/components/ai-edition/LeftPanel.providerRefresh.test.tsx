// @vitest-environment jsdom
// Issue #420: the provider dialog's open state moved out of `ChatStripPanel` and into
// EditorDialogsContext, and the `onClose` that used to re-read the LLM snapshot went with it.
// Connecting a provider in that dialog is what enables the composer here and what fills the
// model pill, so the panel now refreshes whenever the dialog is NOT open — on mount, and again
// on every close.
//
// That re-read is the one behaviour the lift had to re-establish by hand rather than move, and
// it cannot be seen from the dialog's own tests (they never mount this panel), so it is pinned
// here: refreshed once on mount, not again when the dialog opens, once more when it closes.

import "@testing-library/jest-dom";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiEditionChatResult, AiEditionLlmSnapshot } from "@/native/contracts";

const noProviders: AiEditionLlmSnapshot = {
	config: null,
	connectedProviders: [],
	availableProviders: [],
	credentialSummary: [],
};
const llmGetSnapshot = vi.fn<() => Promise<AiEditionLlmSnapshot>>();
const chatCreateSession = vi.fn(async () => ({ id: "session-qa", messages: [] }));
const chatRun = vi.fn(() => new Promise<AiEditionChatResult>(() => undefined));

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		aiEdition: {
			llmGetSnapshot: () => llmGetSnapshot(),
			chatListSessions: () => Promise.resolve([]),
			chatBudget: () => Promise.resolve(null),
			llmListProviderModels: () => Promise.resolve({ models: [] }),
			chatCreateSession: () => chatCreateSession(),
			chatRun: () => chatRun(),
			chatCancel: () => Promise.resolve(),
		},
	},
}));

// The panel's copy is not what is under test, and an echoing translator keeps this file off
// the critical path of a copy edit.
vi.mock("@/contexts/I18nContext", () => ({
	useI18n: () => ({
		locale: "en",
		setLocale: () => {
			/* fixed locale */
		},
	}),
	useScopedT: () => (key: string) => key,
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import {
	EditorDialogsProvider,
	useEditorDialogActions,
	useEditorDialogSection,
} from "@/contexts/EditorDialogsContext";
import { createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { useChatPromptBus } from "@/lib/ai-edition/store/useChatPromptBus";
import { ChatStripPanel } from "./LeftPanel";

let dialogActions: ReturnType<typeof useEditorDialogActions> | null = null;
let dialogSection: ReturnType<typeof useEditorDialogSection> = null;

/** Hands the test the context's openers, which the app menu and the panel's own gear share. */
function CaptureDialogActions() {
	dialogActions = useEditorDialogActions();
	dialogSection = useEditorDialogSection();
	return null;
}

beforeEach(() => {
	llmGetSnapshot.mockReset().mockResolvedValue(noProviders);
	chatCreateSession.mockClear();
	chatRun.mockClear();
	useChatPromptBus.setState({ pending: null });
	useProjectStore.setState({ projectId: null, document: null });
	dialogActions = null;
	dialogSection = null;
	// The panel subscribes to streamed chat events on mount; there is no preload in jsdom.
	(window as unknown as { electronAPI?: unknown }).electronAPI = {
		onAiEditionChatEvent: () => () => {
			/* unsubscribe */
		},
	};
	// jsdom implements no scrolling at all, and the transcript pins itself to the bottom on
	// every render.
	Element.prototype.scrollTo = () => {
		/* no scrolling in jsdom */
	};
});

afterEach(() => {
	cleanup();
	useChatPromptBus.setState({ pending: null });
	(window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
});

describe("ChatStripPanel, against the lifted provider dialog", () => {
	function renderQueuedPrompt() {
		useProjectStore.setState({
			projectId: "project-qa",
			document: createEmptyDocument({ projectId: "project-qa", title: "QA" }),
		});
		useChatPromptBus.getState().submit("Smart cuts QA prompt");
		return render(
			<TooltipProvider>
				<EditorDialogsProvider>
					<CaptureDialogActions />
					<ChatStripPanel />
				</EditorDialogsProvider>
			</TooltipProvider>,
		);
	}

	it("waits for the provider snapshot before consuming a queued Smart cuts prompt", async () => {
		let resolveSnapshot: (value: AiEditionLlmSnapshot) => void = () => undefined;
		llmGetSnapshot.mockReturnValue(
			new Promise((resolve) => {
				resolveSnapshot = resolve;
			}),
		);
		renderQueuedPrompt();
		await act(async () => {
			await Promise.resolve();
		});
		expect(useChatPromptBus.getState().pending).toBe("Smart cuts QA prompt");
		expect(chatCreateSession).not.toHaveBeenCalled();
		await act(async () => {
			resolveSnapshot(noProviders);
		});
		expect(dialogSection).toBe("providers");
		expect(useChatPromptBus.getState().pending).toBeNull();
		expect(chatCreateSession).not.toHaveBeenCalled();
		expect(chatRun).not.toHaveBeenCalled();
	});

	it("sends the queued prompt once when the delayed snapshot has a connected provider", async () => {
		let resolveSnapshot: (value: AiEditionLlmSnapshot) => void = () => undefined;
		llmGetSnapshot.mockReturnValue(
			new Promise((resolve) => {
				resolveSnapshot = resolve;
			}),
		);
		renderQueuedPrompt();
		await act(async () => {
			await Promise.resolve();
		});
		expect(chatCreateSession).not.toHaveBeenCalled();
		await act(async () => {
			resolveSnapshot({
				...noProviders,
				config: { provider: "openai", model: "test" },
				connectedProviders: ["openai"],
			});
		});
		await waitFor(() => expect(chatRun).toHaveBeenCalledTimes(1));
		expect(chatCreateSession).toHaveBeenCalledTimes(1);
		expect(dialogSection).toBeNull();
		expect(useChatPromptBus.getState().pending).toBeNull();
	});

	it("keeps the existing optimistic send fallback if reading the snapshot fails", async () => {
		llmGetSnapshot.mockRejectedValue(new Error("Snapshot unavailable"));
		renderQueuedPrompt();
		await waitFor(() => expect(chatRun).toHaveBeenCalledTimes(1));
		expect(dialogSection).toBeNull();
		expect(useChatPromptBus.getState().pending).toBeNull();
	});

	it("re-reads the LLM snapshot when the dialog closes, and not when it opens", async () => {
		render(
			<TooltipProvider>
				<EditorDialogsProvider>
					<CaptureDialogActions />
					<ChatStripPanel />
				</EditorDialogsProvider>
			</TooltipProvider>,
		);
		// Mount: the dialog is closed, so the same effect that watches for a close seeds the
		// composer's view of the provider config.
		await act(async () => {
			await Promise.resolve();
		});
		expect(llmGetSnapshot).toHaveBeenCalledTimes(1);

		// Opening it must not refresh — nothing has been connected yet, and the old code's
		// `onClose` did not fire here either.
		await act(async () => {
			dialogActions?.openDialog("providers");
		});
		expect(llmGetSnapshot).toHaveBeenCalledTimes(1);

		// Closing is the event that used to be `onClose` -> `refreshLlm()`.
		await act(async () => {
			dialogActions?.closeDialog();
		});
		expect(llmGetSnapshot).toHaveBeenCalledTimes(2);
	});
});
