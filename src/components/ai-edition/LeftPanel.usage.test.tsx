// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AiEditionChatMessage,
	AiEditionChatResult,
	AiEditionChatSession,
	AiEditionChatSessionSummary,
} from "@/native/contracts";

const mocks = vi.hoisted(() => ({
	list: vi.fn(),
	select: vi.fn(),
	run: vi.fn(),
	create: vi.fn(),
	compact: vi.fn(),
	rewind: vi.fn(),
}));
vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		aiEdition: {
			llmGetSnapshot: () =>
				Promise.resolve({
					config: { provider: "openai", model: "gpt-4o" },
					connectedProviders: ["openai"],
				}),
			chatListSessions: (...args: unknown[]) => mocks.list(...args),
			chatSelectSession: (...args: unknown[]) => mocks.select(...args),
			chatRun: (...args: unknown[]) => mocks.run(...args),
			chatCreateSession: (...args: unknown[]) => mocks.create(...args),
			chatBudget: () => Promise.resolve(null),
			chatCompact: (...args: unknown[]) => mocks.compact(...args),
			chatRewind: (...args: unknown[]) => mocks.rewind(...args),
		},
	},
}));
vi.mock("./Modals", () => ({
	ChatHistoryModal: ({ onSelect }: { onSelect: (id: string) => void }) => (
		<>
			<button type="button" onClick={() => onSelect("A")}>
				Select A
			</button>
			<button type="button" onClick={() => onSelect("B")}>
				Select B
			</button>
		</>
	),
}));
vi.mock("@/contexts/I18nContext", async (original) => {
	const actual = await original<typeof import("@/contexts/I18nContext")>();
	return {
		...actual,
		useI18n: () => ({ locale: "en" }),
		useScopedT: () => (key: string, vars?: Record<string, string | number>) =>
			key.startsWith("chat.usage") ? `${key} ${JSON.stringify(vars ?? {})}` : key,
	};
});
const usage = {
	inputTokens: 500,
	outputTokens: 160,
	totalTokens: 660,
	modelCallCount: 3,
	countedCallCount: 3,
	status: "complete" as const,
};
const message = (id: string, content: string): AiEditionChatMessage => ({
	id,
	role: "assistant",
	content,
	createdAt: "now",
	usage,
});
const summary = (id: string): AiEditionChatSessionSummary => ({
	id,
	projectId: "P",
	title: id,
	messageCount: 1,
	createdAt: "now",
});
const session = (
	id: string,
	messages: AiEditionChatMessage[] = [message(id, `History ${id}`)],
): AiEditionChatSession => ({ ...summary(id), projectId: "P", messages });
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
let store: typeof import("@/lib/ai-edition/store/projectStore").useProjectStore;
beforeEach(async () => {
	vi.clearAllMocks();
	mocks.list.mockResolvedValue([summary("A"), summary("B")]);
	mocks.select.mockImplementation((_pid: string, id: string) => Promise.resolve(session(id)));
	mocks.create.mockResolvedValue(summary("A"));
	Element.prototype.scrollTo = () => {
		/* jsdom does not scroll */
	};
	(window as unknown as { electronAPI: unknown }).electronAPI = {
		onAiEditionChatEvent: () => () => {
			/* no live events */
		},
	};
	store = (await import("@/lib/ai-edition/store/projectStore")).useProjectStore;
	store.setState({ projectId: "P", document: null });
});
afterEach(cleanup);
async function panel() {
	const { ChatStripPanel } = await import("./LeftPanel");
	const { EditorDialogsProvider } = await import("@/contexts/EditorDialogsContext");
	const { TooltipProvider } = await import("@/components/ui/tooltip");
	return render(
		<TooltipProvider>
			<EditorDialogsProvider>
				<ChatStripPanel />
			</EditorDialogsProvider>
		</TooltipProvider>,
	);
}
async function send(view: ReturnType<typeof render>) {
	await waitFor(() => expect(view.getByRole("textbox")).toBeEnabled());
	fireEvent.change(view.getByRole("textbox"), { target: { value: "My prompt" } });
	fireEvent.keyDown(view.getByRole("textbox"), { key: "Enter" });
	await waitFor(() => expect(mocks.run).toHaveBeenCalled());
}
const usageNode = (view: ReturnType<typeof render>) => view.queryAllByText(/chat.usageComplete/);
describe("chat usage and asynchronous identity", () => {
	it("loads persisted usage", async () => {
		const view = await panel();
		await view.findByText("History A");
		expect(usageNode(view)).toHaveLength(1);
	});
	it.each([
		false,
		true,
	])("keeps the current session when selected again (pending=%s)", async (pendingTurn) => {
		const running = deferred<AiEditionChatResult>();
		mocks.run.mockReturnValue(running.promise);
		const view = await panel();
		await view.findByText("History A");
		if (pendingTurn) await send(view);
		fireEvent.click(view.getByText("Select A"));
		expect(view.getByText("History A")).toBeInTheDocument();
		if (pendingTurn) {
			expect(view.getByText("My prompt")).toBeInTheDocument();
			await act(async () =>
				running.resolve({ success: true, assistantMessage: message("native-answer", "Answer A") }),
			);
			await view.findByText("Answer A");
			expect(usageNode(view)).toHaveLength(2);
		} else expect(usageNode(view)).toHaveLength(1);
	});
	it("does not let pending new-chat creation erase a subsequently sent turn", async () => {
		const creating = deferred<AiEditionChatSessionSummary>();
		const running = deferred<AiEditionChatResult>();
		mocks.create.mockReturnValue(creating.promise);
		mocks.run.mockReturnValue(running.promise);
		const view = await panel();
		await view.findByText("History A");
		fireEvent.click(view.getByRole("button", { name: "chat.newConversation" }));
		await waitFor(() => expect(mocks.create).toHaveBeenCalled());
		await send(view);
		await act(async () => creating.resolve(summary("B")));
		expect(view.getByText("History A")).toBeInTheDocument();
		expect(view.getByText("My prompt")).toBeInTheDocument();
		await act(async () =>
			running.resolve({ success: true, assistantMessage: message("native-answer", "Answer A") }),
		);
		await view.findByText("Answer A");
		expect(usageNode(view)).toHaveLength(2);
	});

	it.each([
		true,
		false,
	])("does not put a switched session's completed turn in the current session (success=%s)", async (success) => {
		const pending = deferred<AiEditionChatResult>();
		mocks.run.mockReturnValue(pending.promise);
		const view = await panel();
		await view.findByText("History A");
		await send(view);
		fireEvent.click(view.getByText("Select B"));
		await view.findByText("History B");
		await act(async () =>
			pending.resolve(
				success
					? { success: true, assistantMessage: message("native-answer", "Answer A") }
					: {
							success: false,
							error: "failed",
							userMessage: { ...message("native-user", "My prompt"), role: "user" },
						},
			),
		);
		expect(view.queryByText("Answer A")).toBeNull();
		expect(view.queryByText("My prompt")).toBeNull();
		mocks.select.mockImplementation((_pid: string, id: string) =>
			Promise.resolve(session(id, [message("persisted", "Persisted A")])),
		);
		fireEvent.click(view.getByText("Select A"));
		await view.findByText("Persisted A");
		expect(usageNode(view)).toHaveLength(1);
	});
	it.each([
		[true, false],
		[true, true],
		[false, false],
		[false, true],
	])("reloads a returned session when its turn completes (success=%s, old load late=%s)", async (success, oldLoadLate) => {
		const running = deferred<AiEditionChatResult>();
		const returnLoading = deferred<AiEditionChatSession>();
		const persistedUser: AiEditionChatMessage = {
			...message("native-user", "My prompt"),
			role: "user",
			checkpointId: "native-user",
			usage: success ? undefined : usage,
		};
		let completed = false;
		let aLoads = 0;
		mocks.select.mockImplementation((_pid: string, id: string) => {
			if (id === "B") return Promise.resolve(session("B"));
			aLoads += 1;
			if (completed)
				return Promise.resolve(
					session(
						"A",
						success ? [persistedUser, message("native-answer", "Answer A")] : [persistedUser],
					),
				);
			if (aLoads > 1) return returnLoading.promise;
			return Promise.resolve(session("A"));
		});
		mocks.run.mockReturnValue(running.promise);
		const view = await panel();
		await view.findByText("History A");
		await send(view);
		fireEvent.click(view.getByText("Select B"));
		await view.findByText("History B");
		fireEvent.click(view.getByText("Select A"));
		await waitFor(() => expect(aLoads).toBe(2));
		if (!oldLoadLate) await act(async () => returnLoading.resolve(session("A", [persistedUser])));
		await act(async () => {
			completed = true;
			running.resolve(
				success
					? { success: true, assistantMessage: message("native-answer", "Answer A") }
					: { success: false, userMessage: persistedUser },
			);
		});
		await waitFor(() => expect(aLoads).toBe(3));
		if (oldLoadLate) await act(async () => returnLoading.resolve(session("A", [persistedUser])));
		expect(view.getAllByText("My prompt")).toHaveLength(1);
		expect(usageNode(view)).toHaveLength(1);
		if (success) expect(view.getAllByText("Answer A")).toHaveLength(1);
		else {
			expect(view.queryByText("Answer A")).toBeNull();
			mocks.rewind.mockResolvedValue({ success: true, messages: [], prompt: "My prompt" });
			fireEvent.click(view.getByRole("button", { name: "chat.rewindToMessage" }));
			fireEvent.click(await view.findByRole("button", { name: "chat.rewindConfirm" }));
			await waitFor(() => expect(mocks.rewind).toHaveBeenCalledWith("P", "A", "native-user"));
		}
	});
	it.each([
		true,
		false,
	])("reloads a first session created while its project was away (success=%s)", async (success) => {
		const creating = deferred<AiEditionChatSessionSummary>();
		const running = deferred<AiEditionChatResult>();
		let created = false;
		let completed = false;
		const persistedUser: AiEditionChatMessage = {
			...message("native-user", "My prompt"),
			role: "user",
			checkpointId: "native-user",
			usage: success ? undefined : usage,
		};
		mocks.list.mockImplementation((pid: string) =>
			Promise.resolve(pid === "Q" ? [summary("B")] : created ? [summary("A")] : []),
		);
		mocks.select.mockImplementation((_pid: string, id: string) =>
			Promise.resolve(
				session(
					id,
					id === "B"
						? [message("B", "History B")]
						: completed
							? success
								? [persistedUser, message("native-answer", "Answer A")]
								: [persistedUser]
							: [],
				),
			),
		);
		mocks.create.mockReturnValue(creating.promise);
		mocks.run.mockReturnValue(running.promise);
		const view = await panel();
		await waitFor(() => expect(mocks.list).toHaveBeenCalledWith("P"));
		await waitFor(() => expect(view.getByRole("textbox")).toBeEnabled());
		fireEvent.change(view.getByRole("textbox"), { target: { value: "My prompt" } });
		fireEvent.keyDown(view.getByRole("textbox"), { key: "Enter" });
		await waitFor(() => expect(mocks.create).toHaveBeenCalled());
		await act(async () => store.setState({ projectId: "Q" }));
		await view.findByText("History B");
		await act(async () => {
			created = true;
			creating.resolve(summary("A"));
		});
		await waitFor(() => expect(mocks.run).toHaveBeenCalled());
		await act(async () => store.setState({ projectId: "P" }));
		await waitFor(() => expect(mocks.select).toHaveBeenCalledWith("P", "A"));
		await act(async () => {
			completed = true;
			running.resolve(
				success
					? { success: true, assistantMessage: message("native-answer", "Answer A") }
					: { success: false, userMessage: persistedUser },
			);
		});
		await view.findByText("My prompt");
		expect(usageNode(view)).toHaveLength(1);
		if (success) expect(view.getAllByText("Answer A")).toHaveLength(1);
		else {
			mocks.rewind.mockResolvedValue({ success: true, messages: [], prompt: "My prompt" });
			fireEvent.click(view.getByRole("button", { name: "chat.rewindToMessage" }));
			fireEvent.click(await view.findByRole("button", { name: "chat.rewindConfirm" }));
			await waitFor(() => expect(mocks.rewind).toHaveBeenCalledWith("P", "A", "native-user"));
		}
	});

	it("reloads the original project after leaving and returning before completion", async () => {
		const running = deferred<AiEditionChatResult>();
		let completed = false;
		mocks.list.mockImplementation((pid: string) =>
			Promise.resolve([summary(pid === "Q" ? "B" : "A")]),
		);
		mocks.select.mockImplementation((_pid: string, id: string) =>
			Promise.resolve(
				session(
					id,
					completed && id === "A"
						? [message("native-answer", "Answer A")]
						: [message(id, `History ${id}`)],
				),
			),
		);
		mocks.run.mockReturnValue(running.promise);
		const view = await panel();
		await view.findByText("History A");
		await send(view);
		await act(async () => store.setState({ projectId: "Q" }));
		await view.findByText("History B");
		await act(async () => store.setState({ projectId: "P" }));
		await view.findByText("History A");
		await act(async () => {
			completed = true;
			running.resolve({ success: true, assistantMessage: message("native-answer", "Answer A") });
		});
		await view.findByText("Answer A");
		expect(usageNode(view)).toHaveLength(1);
	});

	it("ignores a reversed session load", async () => {
		const late = deferred<AiEditionChatSession>();
		mocks.select.mockImplementation((_pid: string, id: string) =>
			id === "A" ? late.promise : Promise.resolve(session(id)),
		);
		const view = await panel();
		await waitFor(() => expect(mocks.select).toHaveBeenCalled());
		fireEvent.click(view.getByText("Select B"));
		await view.findByText("History B");
		await act(async () => late.resolve(session("A")));
		expect(view.queryByText("History A")).toBeNull();
	});
	it("keeps the optimistic message and reply when initial loading finishes late", async () => {
		const late = deferred<AiEditionChatSession>();
		mocks.list.mockResolvedValue([]);
		mocks.create.mockImplementation(async () => {
			mocks.list.mockResolvedValue([summary("A")]);
			return summary("A");
		});
		mocks.select.mockReturnValue(late.promise);
		mocks.run.mockResolvedValue({
			success: true,
			assistantMessage: message("native-answer", "Answer A"),
		});
		const view = await panel();
		await waitFor(() => expect(mocks.list).toHaveBeenCalled());
		await send(view);
		await view.findByText("Answer A");
		await act(async () => late.resolve(session("A", [])));
		expect(view.getByText("My prompt")).toBeInTheDocument();
		expect(view.getByText("Answer A")).toBeInTheDocument();
	});
	it("keeps a failed user when an existing session's initial empty load arrives late", async () => {
		const loading = deferred<AiEditionChatSession>();
		const running = deferred<AiEditionChatResult>();
		mocks.select.mockReturnValue(loading.promise);
		mocks.run.mockReturnValue(running.promise);
		const view = await panel();
		await waitFor(() => expect(mocks.select).toHaveBeenCalled());
		await send(view);
		await act(async () => loading.resolve(session("A", [])));
		expect(view.getByText("My prompt")).toBeInTheDocument();
		await act(async () =>
			running.resolve({
				success: false,
				userMessage: { ...message("native-user", "My prompt"), role: "user" },
			}),
		);
		expect(usageNode(view)).toHaveLength(1);
	});
	it("attaches failure usage to the optimistic user without an assistant", async () => {
		mocks.run.mockResolvedValue({
			success: false,
			userMessage: { ...message("native-user", "My prompt"), role: "user" },
		});
		const view = await panel();
		await view.findByText("History A");
		await send(view);
		await waitFor(() => expect(usageNode(view)).toHaveLength(2));
		expect(view.getAllByText("My prompt")).toHaveLength(1);
	});
	it.each([
		"compact",
		"rewind",
	] as const)("retains usage after %s and ignores a late result after switching", async (operation) => {
		mocks.select.mockImplementation((_pid: string, id: string) =>
			Promise.resolve(
				session(id, [{ ...message(id, `History ${id}`), role: "user", checkpointId: id }]),
			),
		);
		const response = {
			success: true,
			prompt: "restored",
			messages: [message("restored", "Restored")],
			session: session("A", [message("restored", "Restored")]),
		};
		mocks[operation].mockResolvedValue(response);
		const view = await panel();
		await view.findByText("History A");
		const trigger = async () => {
			if (operation === "compact")
				fireEvent.click(view.getByRole("button", { name: "chat.compactContext" }));
			else {
				fireEvent.click(view.getByRole("button", { name: "chat.rewindToMessage" }));
				fireEvent.click(await view.findByRole("button", { name: "chat.rewindConfirm" }));
			}
		};
		await trigger();
		await view.findByText("Restored");
		expect(usageNode(view)).toHaveLength(1);
		fireEvent.click(view.getByText("Select B"));
		await view.findByText("History B");
		const late = deferred<typeof response>();
		mocks[operation].mockReturnValue(late.promise);
		await trigger();
		fireEvent.click(view.getByText("Select A"));
		await view.findByText("History A");
		await act(async () => late.resolve(response));
		expect(view.queryByText("Restored")).toBeNull();
	});
	it("ignores stale project lists and run results", async () => {
		const lateList = deferred<AiEditionChatSessionSummary[]>();
		const lateRun = deferred<AiEditionChatResult>();
		mocks.run.mockReturnValue(lateRun.promise);
		const view = await panel();
		await view.findByText("History A");
		await send(view);
		mocks.list.mockImplementation((pid: string) =>
			pid === "Q" ? lateList.promise : Promise.resolve([summary("B")]),
		);
		await act(async () => store.setState({ projectId: "Q" }));
		await act(async () => store.setState({ projectId: "R" }));
		await view.findByText("History B");
		await act(async () => {
			lateList.resolve([summary("A")]);
			lateRun.resolve({ success: true, assistantMessage: message("answer", "Answer A") });
		});
		expect(view.queryByText("Answer A")).toBeNull();
		expect(view.queryByText("History A")).toBeNull();
		expect(view.getByText("History B")).toBeInTheDocument();
	});
});
