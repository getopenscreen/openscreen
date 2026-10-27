// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EditorDialogsProvider } from "@/contexts/EditorDialogsContext";
import { createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { clearHistory, redo, undo } from "@/lib/ai-edition/store/undo";
import { past } from "@/lib/ai-edition/store/undoStack";
import type { AiEditionChatEvent, AiEditionChatResult } from "@/native/contracts";
import { ChatStripPanel } from "./LeftPanel";

const api = vi.hoisted(() => ({
	run: vi.fn(),
	cancel: vi.fn(),
	save: vi.fn(),
	list: vi.fn(),
	select: vi.fn(),
	create: vi.fn(),
	error: vi.fn(),
	warning: vi.fn(),
}));
vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		aiEdition: {
			llmGetSnapshot: async () => ({
				config: { provider: "openai", model: "test" },
				connectedProviders: ["openai"],
			}),
			chatListSessions: api.list,
			chatSelectSession: api.select,
			chatCreateSession: api.create,
			chatRun: api.run,
			chatCancel: api.cancel,
			save: api.save,
			chatBudget: async () => null,
		},
	},
}));
vi.mock("@/contexts/I18nContext", () => ({
	useI18n: () => ({ locale: "en" }),
	useScopedT: () => (key: string) => key,
}));
vi.mock("sonner", () => ({ toast: { error: api.error, warning: api.warning, success: vi.fn() } }));
let onEvent: (event: AiEditionChatEvent) => void;
let replies: ((value: AiEditionChatResult) => void)[];
const doc = (title: string, projectId = "p") => createEmptyDocument({ projectId, title });
const result = (content: string, stopped = false): AiEditionChatResult => ({
	success: true,
	cancelled: stopped,
	assistantMessage: {
		id: "reply",
		role: "assistant",
		createdAt: new Date().toISOString(),
		content,
		stopped,
	},
});
const session = (id = "s") => ({
	id,
	projectId: "p",
	title: id,
	messageCount: 0,
	createdAt: "2026-01-01T00:00:00Z",
	messages: [],
});
beforeEach(() => {
	vi.clearAllMocks();
	clearHistory();
	replies = [];
	Element.prototype.scrollTo = vi.fn();
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe = vi.fn();
			unobserve = vi.fn();
			disconnect = vi.fn();
		},
	);
	window.electronAPI = {
		onAiEditionChatEvent: (listener: typeof onEvent) => {
			onEvent = listener;
			return vi.fn();
		},
	} as unknown as typeof window.electronAPI;
	useProjectStore.setState({ projectId: "p", document: doc("Before"), revision: 1 });
	api.list.mockImplementation(async () => [session()]);
	api.select.mockImplementation(async () => session());
	api.create.mockImplementation(async () => session("new"));
	api.run.mockImplementation(
		() =>
			new Promise<AiEditionChatResult>((resolve) => {
				replies.push(resolve);
			}),
	);
	api.cancel.mockResolvedValue({ accepted: true });
	api.save.mockImplementation(async (document) => ({ success: true, document }));
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});
async function start() {
	await screen.findByText("s");
	const input = screen.getByRole("textbox");
	fireEvent.change(input, { target: { value: "Edit" } });
	fireEvent.keyDown(input, { key: "Enter" });
	await waitFor(() => expect(api.run).toHaveBeenCalled());
	return api.run.mock.calls.at(-1)![4] as string;
}
function panel() {
	return render(
		<TooltipProvider>
			<EditorDialogsProvider>
				<ChatStripPanel />
			</EditorDialogsProvider>
		</TooltipProvider>,
	);
}
function emit(
	runId: string,
	event: { kind: "text"; delta: string } | { kind: "document"; document: unknown },
) {
	act(() => onEvent({ projectId: "p", sessionId: "s", runId, ...event }));
}

describe("composer Stop", () => {
	it("keeps the Stopping tooltip keyboard-accessible without sending another cancel", async () => {
		panel();
		await start();
		const stop = screen.getByRole("button", { name: "chat.stop" });
		fireEvent.click(stop);
		expect(stop).toHaveAttribute("aria-disabled", "true");
		expect(stop).not.toBeDisabled();
		fireEvent.keyDown(window, { key: "Tab" });
		act(() => stop.focus());
		expect(await screen.findByRole("tooltip")).toHaveTextContent("chat.stopping");
		expect(stop).toHaveFocus();
		fireEvent.click(stop);
		expect(api.cancel).toHaveBeenCalledOnce();
		await act(async () => replies[0](result("Partial", true)));
	});

	it("commits stopped edits once, retains the live reply, ignores old events and starts the next turn", async () => {
		panel();
		const id = await start();
		expect(screen.getByRole("button", { name: "chat.stop" })).toBeEnabled();
		emit(id, { kind: "document", document: doc("First") });
		emit(id, { kind: "document", document: doc("Second") });
		emit(id, { kind: "text", delta: "Partial" });
		await act(async () => {
			// Flush event work before checking that no intermediate edits were saved.
		});
		expect(screen.getByText("Partial")).toBeVisible();
		expect(api.save).not.toHaveBeenCalled();
		expect(past).toHaveLength(0);
		expect(useProjectStore.getState().document?.project.title).toBe("Before");
		fireEvent.click(screen.getByRole("button", { name: "chat.stop" }));
		fireEvent.click(screen.getByRole("button", { name: "chat.stop" }));
		expect(api.cancel).toHaveBeenCalledOnce();
		expect(api.cancel).toHaveBeenCalledWith("p", "s", id);
		await act(async () => replies[0]({ ...result("Partial", true), document: doc("Second") }));
		expect(screen.getByText("chat.stopped")).toBeVisible();
		expect(screen.getByText("Partial")).toBeVisible();
		expect(screen.getByRole("button", { name: "chat.send" })).toBeInTheDocument();
		expect(api.save).toHaveBeenCalledOnce();
		expect(past).toHaveLength(1);
		expect(useProjectStore.getState().document?.project.title).toBe("Second");
		act(() => {
			undo();
		});
		expect(useProjectStore.getState().document?.project.title).toBe("Before");
		act(() => {
			redo();
		});
		expect(useProjectStore.getState().document?.project.title).toBe("Second");
		const nextId = await start();
		expect(nextId).not.toBe(id);
		emit(id, { kind: "text", delta: "STALE" });
		emit(id, { kind: "document", document: doc("STALE") });
		expect(screen.queryByText("STALE")).toBeNull();
		expect(screen.getByRole("button", { name: "chat.stop" })).toBeEnabled();
		await act(async () => replies[1](result("Next reply")));
		expect(screen.getByText("Next reply")).toBeVisible();
		expect(api.error).not.toHaveBeenCalled();
	});

	it.each([false, true])("keeps a long turn in one undo step (stopped: %s)", async (stopped) => {
		useProjectStore.getState().setDocument(doc("Pre-turn"), { history: true });
		panel();
		const id = await start();
		for (let i = 0; i < 60; i++) {
			emit(id, { kind: "document", document: doc(`Tool ${i}`) });
		}
		await act(async () => {
			// Let any queued per-tool writes run so the regression cannot hide in microtasks.
		});
		expect(api.save).not.toHaveBeenCalled();
		expect(past).toHaveLength(1);
		if (stopped) fireEvent.click(screen.getByRole("button", { name: "chat.stop" }));
		await act(async () =>
			replies[0]({ ...result("Done", stopped), document: doc("Final aggregate") }),
		);
		expect(api.save).toHaveBeenCalledOnce();
		expect(past).toHaveLength(2);
		expect(useProjectStore.getState().document?.project.title).toBe("Final aggregate");
		act(() => {
			undo();
		});
		expect(useProjectStore.getState().document?.project.title).toBe("Pre-turn");
		act(() => {
			undo();
		});
		expect(useProjectStore.getState().document?.project.title).toBe("Before");
	});

	it("applies a stopped aggregate when no document event arrived", async () => {
		panel();
		await start();
		fireEvent.click(screen.getByRole("button", { name: "chat.stop" }));
		await act(async () =>
			replies[0]({ ...result("Partial", true), document: doc("Completed edit") }),
		);
		expect(api.save).toHaveBeenCalledOnce();
		expect(past).toHaveLength(1);
		expect(useProjectStore.getState().document?.project.title).toBe("Completed edit");
		act(() => {
			undo();
		});
		expect(useProjectStore.getState().document?.project.title).toBe("Before");
	});

	it("keeps manual edits during a turn until Apply anyway commits the aggregate once", async () => {
		panel();
		const id = await start();
		emit(id, { kind: "document", document: doc("First") });
		act(() => useProjectStore.getState().setDocument(doc("Manual"), { history: true }));
		emit(id, { kind: "document", document: doc("Second") });
		await act(async () => replies[0]({ ...result("Done"), document: doc("Second") }));
		expect(api.save).not.toHaveBeenCalled();
		expect(useProjectStore.getState().document?.project.title).toBe("Manual");
		expect(api.warning).toHaveBeenCalledWith("chat.agentEditConflict", expect.any(Object));
		await act(async () => api.warning.mock.calls[0][1].action.onClick());
		await waitFor(() => expect(api.save).toHaveBeenCalledOnce());
		expect(useProjectStore.getState().document?.project.title).toBe("Second");
		act(() => {
			undo();
		});
		expect(useProjectStore.getState().document?.project.title).toBe("Manual");
	});

	it("stops while creating the first session without sending a model request", async () => {
		api.list.mockResolvedValue([]);
		let created!: (value: ReturnType<typeof session>) => void;
		api.create.mockImplementation(
			() =>
				new Promise((resolve) => {
					created = resolve;
				}),
		);
		panel();
		await waitFor(() => expect(screen.getByRole("textbox")).toBeEnabled());
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "Unsent" } });
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
		await waitFor(() => expect(api.create).toHaveBeenCalled());
		fireEvent.click(screen.getByRole("button", { name: "chat.stop" }));
		await act(async () => created(session()));
		expect(api.run).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "chat.send" })).toBeInTheDocument();
		expect(screen.getByRole("textbox")).toHaveValue("Unsent");
	});

	it("cancels on project switch and old cleanup cannot end the new turn", async () => {
		panel();
		const id = await start();
		act(() => useProjectStore.setState({ projectId: "other", document: doc("Other", "other") }));
		await waitFor(() => expect(api.cancel).toHaveBeenCalledWith("p", "s", id));
		await start();
		await act(async () => replies[0]({ ...result("Old reply", true), document: doc("Old") }));
		emit(id, { kind: "document", document: doc("Old") });
		expect(screen.queryByText("Old reply")).toBeNull();
		expect(screen.getByRole("button", { name: "chat.stop" })).toBeEnabled();
		expect(useProjectStore.getState().document?.project.title).toBe("Other");
		expect(api.save).not.toHaveBeenCalled();
		await act(async () => replies[1](result("New reply")));
	});

	it("cancels when selecting a new session or unmounting", async () => {
		const view = panel();
		const id = await start();
		fireEvent.click(screen.getByRole("button", { name: "chat.newConversation" }));
		await waitFor(() => expect(api.cancel).toHaveBeenCalledWith("p", "s", id));
		await act(async () => replies[0]({ ...result("Old", true), document: doc("Old") }));
		expect(screen.queryByText("Old")).toBeNull();
		expect(api.save).not.toHaveBeenCalled();
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "Next" } });
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
		await waitFor(() => expect(api.run).toHaveBeenCalledTimes(2));
		const nextId = api.run.mock.calls[1][4];
		view.unmount();
		expect(api.cancel).toHaveBeenLastCalledWith("p", "new", nextId);
		await act(async () => replies[1]({ ...result("Disposed", true), document: doc("Disposed") }));
		expect(api.save).not.toHaveBeenCalled();
	});
	it("keeps Markdown source on send/copy and renders streaming invocation updates without duplicates", async () => {
		const copy = vi.fn().mockResolvedValue(undefined);
		window.electronAPI.copyToClipboard = copy;
		panel();
		await screen.findByText("s");
		const source = "  indented\n\n```ts\n  const x = 1;\n```\n";
		const input = screen.getByRole("textbox");
		fireEvent.change(input, { target: { value: source } });
		fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
		expect(api.run).not.toHaveBeenCalled();
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(api.run).toHaveBeenCalled());
		expect(api.run.mock.calls[0][2]).toBe(source);
		const runId = api.run.mock.calls[0][4] as string;
		const step = {
			id: "first",
			kind: "tool" as const,
			name: "getTranscript",
			arguments: "assetId: missing",
			startedAt: 0,
			status: "running" as const,
		};
		act(() =>
			onEvent({ projectId: "p", sessionId: "s", runId: "old", kind: "executionStep", step }),
		);
		expect(screen.queryByText(/getTranscript/)).toBeNull();
		act(() => onEvent({ projectId: "p", sessionId: "s", runId, kind: "executionStep", step }));
		expect(screen.getAllByText("getTranscript")).toHaveLength(1);
		const failed = { ...step, status: "failed" as const, durationMs: 15, summary: "No transcript" };
		act(() =>
			onEvent({ projectId: "p", sessionId: "s", runId, kind: "executionStep", step: failed }),
		);
		expect(screen.getAllByText("getTranscript")).toHaveLength(1);
		const response = result("## Finished\n\n- Preserved source");
		response.assistantMessage!.executionSteps = [failed];
		await act(async () => replies[0](response));
		expect(screen.getByRole("heading", { name: "Finished" })).toBeInTheDocument();
		expect(screen.getAllByText("getTranscript")).toHaveLength(1);
		fireEvent.click(screen.getAllByRole("button", { name: "chat.copyMessage" })[0]);
		expect(copy).toHaveBeenCalledWith(source);
	});
	it("retains failure steps on the original user message", async () => {
		panel();
		await start();
		const step = {
			id: "failure",
			kind: "tool" as const,
			name: "getTranscript",
			arguments: "",
			startedAt: 0,
			status: "failed" as const,
			summary: "No transcript",
		};
		await act(async () =>
			replies[0]({
				success: false,
				userMessageId: "stored",
				userMessage: {
					id: "stored",
					role: "user",
					createdAt: "now",
					content: "Edit",
					executionSteps: [step],
				},
			}),
		);
		expect(screen.getByText("getTranscript")).toBeInTheDocument();
		expect(screen.getByRole("textbox")).toBeEnabled();
	});
});
