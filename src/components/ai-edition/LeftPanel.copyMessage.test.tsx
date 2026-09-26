// @vitest-environment jsdom
// Issue #738: the chat panel's Copy message button resolved the copy through
// `navigator.clipboard.writeText`, which Electron denies in the renderer
// (NotAllowedError: Write permission denied — clipboard-sanitized-write), so
// every click landed on the "Couldn't copy" toast and the clipboard kept its
// old content. The button must route through the preload bridge into main's
// `clipboard.writeText` when the bridge offers it, and fall back to the
// navigator path only where the bridge is absent (shim/web contexts).
//
// The distinguishing case is the first one: a navigator clipboard that
// rejects exactly the way Electron's does, with the bridge available. The
// pre-fix handler failed it (it called the navigator and showed the error
// toast); the post-fix handler passes it (bridge write with the exact
// message content, success toast).

import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ASSISTANT_CONTENT =
	"Stub assistant reply for issue 738.\nSecond line with unicode: ✓ 🎬 — em dash, accént, 中文.";

const llmGetSnapshot = vi.fn(() =>
	Promise.resolve({
		config: null,
		connectedProviders: [],
		availableProviders: [],
		credentialSummary: [],
	}),
);
const chatListSessions = vi.fn(() =>
	Promise.resolve([
		{
			id: "session-1",
			title: "Conversation 1",
			messageCount: 2,
			createdAt: "2026-09-23T00:00:00Z",
		},
	]),
);
const chatSelectSession = vi.fn(() =>
	Promise.resolve({
		id: "session-1",
		projectId: "project-1",
		title: "Conversation 1",
		createdAt: "2026-09-23T00:00:00Z",
		updatedAt: "2026-09-23T00:00:00Z",
		messages: [
			{
				id: "m1",
				role: "user",
				content: "Reply with exactly: stub reply ok",
				createdAt: "2026-09-23T00:00:01Z",
			},
			{
				id: "m2",
				role: "assistant",
				content: ASSISTANT_CONTENT,
				createdAt: "2026-09-23T00:00:02Z",
			},
			{
				id: "m3",
				role: "assistant",
				content: "",
				createdAt: "2026-09-23T00:00:03Z",
			},
		],
	}),
);

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		aiEdition: {
			llmGetSnapshot: () => llmGetSnapshot(),
			chatListSessions: () => chatListSessions(),
			chatSelectSession: () => chatSelectSession(),
			chatBudget: () => Promise.resolve(null),
		},
	},
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
	toast: {
		success: (...args: unknown[]) => toastSuccess(...args),
		error: (...args: unknown[]) => toastError(...args),
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

// Electron's actual renderer-side rejection on Windows (captured from a dev
// run against the failing build): the async clipboard write is denied even
// with the window focused, because the renderer never holds
// clipboard-sanitized-write.
const electronRejection = () =>
	Promise.reject(
		new DOMException(
			"Failed to execute 'writeText' on 'Clipboard': Write permission denied.",
			"NotAllowedError",
		),
	);

const navigatorWriteText = vi.fn();
const copyToClipboard = vi.fn();

function stubClipboard(bridgeCopy: ((text: string) => Promise<void>) | undefined) {
	navigatorWriteText.mockReset().mockImplementation(electronRejection);
	copyToClipboard.mockReset().mockImplementation((text: string) => Promise.resolve(text));
	Object.defineProperty(navigator, "clipboard", {
		value: { writeText: navigatorWriteText },
		configurable: true,
	});
	(window as unknown as { electronAPI?: unknown }).electronAPI = {
		onAiEditionChatEvent: () => () => {
			/* unsubscribe */
		},
		...(bridgeCopy ? { copyToClipboard: bridgeCopy } : {}),
	};
}

beforeEach(() => {
	llmGetSnapshot.mockClear();
	chatListSessions.mockClear();
	chatSelectSession.mockClear();
	toastSuccess.mockClear();
	toastError.mockClear();
	// jsdom implements no scrolling at all, and the transcript pins itself to the bottom on
	// every render.
	Element.prototype.scrollTo = () => {
		/* no scrolling in jsdom */
	};
});

afterEach(() => {
	cleanup();
	(window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
	Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
});

async function renderPanelWithAssistantMessage() {
	const { useProjectStore } = await import("@/lib/ai-edition/store/projectStore");
	useProjectStore.setState({ projectId: "project-1" });
	const { EditorDialogsProvider } = await import("@/contexts/EditorDialogsContext");
	const { ChatStripPanel } = await import("./LeftPanel");
	const view = render(
		<EditorDialogsProvider>
			<ChatStripPanel />
		</EditorDialogsProvider>,
	);
	// Flush the session load so the assistant bubble (and its copy button) is on screen.
	await waitFor(() => {
		expect(view.getAllByTitle("chat.copyMessage").length).toBeGreaterThan(0);
	});
	return view;
}

describe("ChatStripPanel Copy message (issue #738)", () => {
	it("copies the full message through the preload bridge and reports success, never touching the denied navigator clipboard", async () => {
		stubClipboard(copyToClipboard);
		const view = await renderPanelWithAssistantMessage();

		// Two copy buttons (user + assistant); the assistant message is the last one rendered.
		const copyButtons = view.getAllByTitle("chat.copyMessage");
		// user + assistant + the empty trailing assistant turn.
		expect(copyButtons).toHaveLength(3);
		await act(async () => {
			fireEvent.click(copyButtons[1]);
			await Promise.resolve();
		});

		await waitFor(() => {
			expect(toastSuccess).toHaveBeenCalledWith("chat.copiedToClipboard");
		});
		expect(copyToClipboard).toHaveBeenCalledTimes(1);
		expect(copyToClipboard).toHaveBeenCalledWith(ASSISTANT_CONTENT);
		expect(navigatorWriteText).not.toHaveBeenCalled();
		expect(toastError).not.toHaveBeenCalled();
	});

	it("falls back to navigator.clipboard when the bridge offers no copy (shim/web), surfacing its failure", async () => {
		stubClipboard(undefined);
		const view = await renderPanelWithAssistantMessage();

		const copyButtons = view.getAllByTitle("chat.copyMessage");
		// The fallback inherits Electron's denial in a bare context: the click
		// lands on the navigator path and reports the failure toast.
		await act(async () => {
			fireEvent.click(copyButtons[1]);
			await Promise.resolve();
		});
		await waitFor(() => {
			expect(toastError).toHaveBeenCalledWith("chat.copyFailed");
		});
		expect(navigatorWriteText).toHaveBeenCalledTimes(1);
		expect(navigatorWriteText).toHaveBeenCalledWith(ASSISTANT_CONTENT);
		expect(toastSuccess).not.toHaveBeenCalled();
		const failuresAfterDeniedClick = toastError.mock.calls.length;

		// When the navigator allows the write, the same fallback reports success.
		navigatorWriteText.mockImplementation((text: string) => Promise.resolve(text));
		await act(async () => {
			fireEvent.click(copyButtons[1]);
			await Promise.resolve();
		});
		await waitFor(() => {
			expect(toastSuccess).toHaveBeenCalledWith("chat.copiedToClipboard");
		});
		expect(navigatorWriteText).toHaveBeenCalledTimes(2);
		expect(toastError.mock.calls.length).toBe(failuresAfterDeniedClick);
	});

	it("passes empty message content through to the bridge untouched, per the product's existing semantics", async () => {
		stubClipboard(copyToClipboard);
		const view = await renderPanelWithAssistantMessage();

		// The empty trailing assistant turn renders a bubble with no text; its
		// copy button sits last. The handler must not branch on content — an
		// empty string crosses to the bridge exactly like any other content and
		// still reports success.
		const copyButtons = view.getAllByTitle("chat.copyMessage");
		await act(async () => {
			fireEvent.click(copyButtons[copyButtons.length - 1]);
			await Promise.resolve();
		});

		await waitFor(() => {
			expect(toastSuccess).toHaveBeenCalledWith("chat.copiedToClipboard");
		});
		expect(copyToClipboard).toHaveBeenCalledWith("");
		expect(navigatorWriteText).not.toHaveBeenCalled();
		expect(toastError).not.toHaveBeenCalled();
	});
});
