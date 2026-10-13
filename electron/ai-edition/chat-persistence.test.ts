import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument } from "../../src/lib/ai-edition/schema";
import { ChatPersistence } from "./chat-persistence";
import { createTurnUsageAccumulator } from "./deep-agent/usage";

vi.mock("./deep-agent/service", () => ({ invokeOpenScreenAgent: vi.fn() }));
vi.mock("./deep-agent/chat-model", () => ({
	createOpenScreenChatModel: vi.fn(),
	messageContentToText: (content: unknown) => String(content),
}));

import {
	AiEditionService,
	type AiEditionServiceOptions,
} from "../native-bridge/services/aiEditionService";
import {
	compactSessionNow,
	configureChatPersistence,
	createSession,
	deleteProjectChat,
	deleteSession,
	flushChatPersistence,
	listSessions,
	renameSession,
	rewindToMessage,
	runChat,
	selectSession,
} from "./chat-service";
import { createOpenScreenChatModel } from "./deep-agent/chat-model";
import { invokeOpenScreenAgent } from "./deep-agent/service";
import { DocumentService } from "./document-service";
import type { LlmConfigStore } from "./llm-config-store";

const invokeMock = vi.mocked(invokeOpenScreenAgent);
const modelMock = vi.mocked(createOpenScreenChatModel);
const key = "sk-test-secret-must-not-be-saved";
let root: string;

function config(): LlmConfigStore {
	return {
		getConfig: () => ({ provider: "openai", model: "gpt-4o" }),
		getCredential: () => ({ value: key, entry: { kind: "api-key", apiKey: key } }),
	} as unknown as LlmConfigStore;
}

async function restart() {
	await flushChatPersistence();
	configureChatPersistence(root);
}

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "openscreen-chat-"));
	configureChatPersistence(root);
	invokeMock.mockReset();
	modelMock.mockReset();
	invokeMock.mockImplementation(async (args) => ({
		text: "reply",
		document: args.document,
		mutated: false,
		usage: createTurnUsageAccumulator().snapshot(),
	}));
});

afterEach(async () => {
	await flushChatPersistence();
	rmSync(root, { recursive: true, force: true });
});

describe("local Agent chat history", () => {
	const reportedUsage = {
		inputTokens: 31,
		outputTokens: 7,
		totalTokens: 38,
		modelCallCount: 2,
		countedCallCount: 2,
		status: "complete" as const,
		cachedInputTokens: 9,
		reasoningOutputTokens: 3,
	};

	it.each([true, false])("restores usage on the owning message (success=%s)", async (success) => {
		invokeMock.mockImplementation(async (args) => ({
			text: success ? "reply" : "",
			reason: success ? undefined : "provider failed",
			document: args.document,
			mutated: false,
			usage: { ...reportedUsage, rawProvider: { apiKey: key } },
		}));
		const session = createSession("proj_usage");
		const result = await runChat("proj_usage", session.id, "question", config());
		if (!success) expect(result.userMessage).toMatchObject({ role: "user", usage: reportedUsage });
		await restart();
		const messages = selectSession("proj_usage", session.id)?.messages ?? [];
		expect(messages).toHaveLength(success ? 2 : 1);
		expect(messages.at(-1)?.usage).toEqual(reportedUsage);
		if (success) expect(messages[0]?.usage).toBeUndefined();
		expect(readFileSync(path.join(root, "proj_usage.chat.json"), "utf8")).not.toContain(key);
	});

	it.each([
		true,
		false,
	])("binds delayed usage to the original session (success=%s)", async (success) => {
		let reply!: (value: Awaited<ReturnType<typeof invokeOpenScreenAgent>>) => void;
		invokeMock.mockImplementation(() => new Promise((resolve) => (reply = resolve)));
		const first = createSession("proj_binding", "A");
		const second = createSession("proj_binding", "B");
		const turn = runChat("proj_binding", first.id, "question", config());
		await vi.waitFor(() => expect(invokeMock).toHaveBeenCalled());
		selectSession("proj_binding", second.id);
		reply({
			text: success ? "reply" : "",
			document: createEmptyDocument({ title: "x", projectId: "proj_binding" }),
			mutated: false,
			usage: reportedUsage,
		});
		await turn;
		await restart();
		expect(selectSession("proj_binding", first.id)?.messages.at(-1)?.usage).toEqual(reportedUsage);
		expect(selectSession("proj_binding", second.id)?.messages).toEqual([]);
	});

	it.each([
		["session", true],
		["session", false],
		["project", true],
		["project", false],
		["rewind", true],
		["rewind", false],
	])("discards delayed results after %s removal (success=%s)", async (boundary, success) => {
		const projectId = "proj_boundary";
		const session = createSession(projectId);
		const document = createEmptyDocument({ title: "x", projectId });
		await runChat(projectId, session.id, "earlier", config(), document);
		const earlier = selectSession(projectId, session.id)!.messages[0];
		let reply!: (value: Awaited<ReturnType<typeof invokeOpenScreenAgent>>) => void;
		invokeMock.mockImplementation(() => new Promise((resolve) => (reply = resolve)));
		const turn = runChat(projectId, session.id, "removed question", config(), document);
		await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2));
		if (boundary === "session") deleteSession(projectId, session.id);
		if (boundary === "project") {
			await deleteProjectChat(projectId);
			createSession(projectId, "replacement");
		}
		if (boundary === "rewind")
			expect(rewindToMessage(projectId, session.id, earlier.id).success).toBe(true);
		reply({ text: success ? "late reply" : "", document, mutated: false, usage: reportedUsage });
		expect(await turn).toMatchObject({ success: false });
		await restart();
		const allMessages = listSessions(projectId).flatMap(
			(entry) => selectSession(projectId, entry.id)?.messages ?? [],
		);
		expect(
			allMessages.some(
				(entry) => entry.content === "late reply" || entry.content === "removed question",
			),
		).toBe(false);
	});

	it.each([
		true,
		false,
	])("discards a pending turn rewound to its own user message (success=%s)", async (success) => {
		const projectId = "proj_own_rewind";
		const session = createSession(projectId);
		const document = createEmptyDocument({ title: "before", projectId });
		let reply!: (value: Awaited<ReturnType<typeof invokeOpenScreenAgent>>) => void;
		invokeMock.mockImplementation(() => new Promise((resolve) => (reply = resolve)));
		const turn = runChat(projectId, session.id, "pending question", config(), document);
		await vi.waitFor(() => expect(invokeMock).toHaveBeenCalled());
		const user = selectSession(projectId, session.id)!.messages[0];
		expect(rewindToMessage(projectId, session.id, user.id).success).toBe(true);
		reply({
			text: success ? "stale reply" : "",
			document: createEmptyDocument({ title: "stale edit", projectId }),
			mutated: true,
			usage: reportedUsage,
		});
		const result = await turn;
		expect(result.success).toBe(false);
		expect(result.document).toBeUndefined();
		expect(result.assistantMessage).toBeUndefined();
		expect(result.userMessage).toBeUndefined();
		expect(selectSession(projectId, session.id)?.messages).toEqual([
			{ ...user, checkpointId: null },
		]);
		await restart();
		const restored = selectSession(projectId, session.id)?.messages;
		expect(restored).toHaveLength(1);
		expect(restored?.[0]).toMatchObject({ id: user.id, content: "pending question" });
		expect(restored?.[0].usage).toBeUndefined();
	});

	it("uses the actual session created for a stale id", async () => {
		await runChat("proj_stale", "stale-id", "question", config());
		await restart();
		const session = listSessions("proj_stale")[0];
		expect(selectSession("proj_stale", session.id)?.messages[1]?.usage?.status).toBe("unavailable");
	});

	it("retains legacy messages and drops only invalid usage", async () => {
		const session = createSession("proj_corrupt");
		await runChat("proj_corrupt", session.id, "question", config());
		await flushChatPersistence();
		const file = path.join(root, "proj_corrupt.chat.json");
		const saved = JSON.parse(readFileSync(file, "utf8"));
		delete saved.sessions[0].messages[0].usage;
		saved.sessions[0].messages[1].usage = { ...reportedUsage, countedCallCount: 3 };
		writeFileSync(file, JSON.stringify(saved));
		await restart();
		const messages = selectSession("proj_corrupt", session.id)?.messages;
		expect(messages?.map((entry) => entry.content)).toEqual(["question", "reply"]);
		expect(messages?.every((entry) => entry.usage === undefined)).toBe(true);
	});

	it.each([
		{ inputTokens: -1 },
		{ outputTokens: 1.5 },
		{ totalTokens: Number.MAX_SAFE_INTEGER + 1 },
		{ countedCallCount: 3 },
		{ modelCallCount: 0, countedCallCount: 0 },
		{ totalTokens: 39 },
		{ cachedInputTokens: 32 },
		{ cacheCreationInputTokens: 32 },
		{ reasoningOutputTokens: 8 },
		{ status: "unavailable" as const, countedCallCount: 0 },
		{ status: "partial" as const, countedCallCount: 0 },
	])("drops malformed usage while retaining its message: %j", async (invalid) => {
		const store = new ChatPersistence(root);
		await store.write("proj_validation", [
			{
				id: "session",
				projectId: "proj_validation",
				title: "Title",
				createdAt: "now",
				messages: [
					{
						id: "message",
						role: "assistant",
						content: "retained",
						createdAt: "now",
						usage: { ...reportedUsage, ...invalid },
					},
				],
			},
		]);
		const messages = new ChatPersistence(root).read("proj_validation")[0]?.messages;
		expect(messages).toHaveLength(1);
		expect(messages?.[0]).toMatchObject({ id: "message", content: "retained" });
		expect(messages?.[0].usage).toBeUndefined();
	});

	it.each([
		{ ...reportedUsage, status: "partial" as const },
		{
			...reportedUsage,
			status: "partial" as const,
			inputTokens: Number.MAX_SAFE_INTEGER,
			totalTokens: 1,
		},
		{
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
			modelCallCount: 1,
			countedCallCount: 0,
			status: "unavailable" as const,
		},
	])("retains valid partial lower bounds and unavailable usage: %j", async (usage) => {
		const store = new ChatPersistence(root);
		await store.write("proj_valid", [
			{
				id: "session",
				projectId: "proj_valid",
				title: "Title",
				createdAt: "now",
				messages: [{ id: "message", role: "assistant", content: "reply", createdAt: "now", usage }],
			},
		]);
		expect(new ChatPersistence(root).read("proj_valid")[0]?.messages[0].usage).toEqual(usage);
	});

	it("does not create usage before model validation succeeds", async () => {
		const session = createSession("proj_no_config");
		const result = await runChat("proj_no_config", session.id, "question", {
			getConfig: () => null,
		} as unknown as LlmConfigStore);
		expect(result).toMatchObject({ success: false });
		expect(result.userMessage).toBeUndefined();
		expect(invokeMock).not.toHaveBeenCalled();
		expect(selectSession("proj_no_config", session.id)?.messages).toEqual([]);
	});

	it("keeps failure diagnostics and usage out of subsequent model history", async () => {
		invokeMock.mockImplementation(async (args) => ({
			text: "",
			reason: "diagnostic-secret",
			document: args.document,
			mutated: false,
			usage: reportedUsage,
		}));
		const session = createSession("proj_failure_history");
		await runChat("proj_failure_history", session.id, "first question", config());
		await runChat("proj_failure_history", session.id, "second question", config());
		expect(invokeMock.mock.lastCall?.[0].history).toEqual([
			{ role: "user", content: "first question" },
			{ role: "user", content: "second question" },
		]);
	});

	it("restores multiple sessions and persists rename and delete per project", async () => {
		const first = createSession("proj_a", "First");
		const deleted = createSession("proj_a", "Deleted");
		const other = createSession("proj_b", "Other");
		renameSession("proj_a", first.id, "Renamed");
		expect(deleteSession("proj_a", deleted.id)).toBe(true);

		await restart();
		expect(listSessions("proj_a")).toEqual([{ ...first, title: "Renamed" }]);
		expect(selectSession("proj_a", deleted.id)).toBeNull();
		expect(listSessions("proj_b")).toEqual([other]);
		expect(selectSession("proj_b", first.id)).toBeNull();
	});

	it("restores transcript and model context without credentials or stale rewind controls", async () => {
		const session = createSession("proj_chat");
		const document = createEmptyDocument({ title: "Test", projectId: "proj_chat" });
		await runChat("proj_chat", session.id, "first question", config(), document);
		expect(selectSession("proj_chat", session.id)?.messages[0]?.checkpointId).toBeTruthy();
		await flushChatPersistence();
		const file = path.join(root, "proj_chat.chat.json");
		expect(readFileSync(file, "utf8")).not.toContain(key);
		expect(readFileSync(file, "utf8")).not.toContain("checkpointId");

		await restart();
		const restored = selectSession("proj_chat", session.id);
		expect(restored?.messages.map((m) => m.content)).toEqual(["first question", "reply"]);
		expect(restored?.messages[0]?.checkpointId).toBeNull();
		expect(rewindToMessage("proj_chat", session.id, restored?.messages[0]?.id ?? "").success).toBe(
			false,
		);
		await runChat("proj_chat", session.id, "follow up", config());
		expect(invokeMock.mock.lastCall?.[0].history.map((m) => m.content)).toEqual([
			"first question",
			"reply",
			"follow up",
		]);
	});

	it("restores compaction boundary for the model while keeping the full transcript", async () => {
		modelMock.mockImplementation(
			async () =>
				({
					invoke: async () => ({ content: "Earlier goals and decisions" }),
				}) as unknown as Awaited<ReturnType<typeof createOpenScreenChatModel>>,
		);
		const session = createSession("proj_compact");
		for (let i = 0; i < 4; i++) {
			await runChat("proj_compact", session.id, "question " + i + " ".repeat(100), config());
		}
		const compacted = await compactSessionNow("proj_compact", session.id, config());
		expect(compacted?.summary).toBe("Earlier goals and decisions");
		await restart();
		expect(selectSession("proj_compact", session.id)?.messages).toHaveLength(8);
		await runChat("proj_compact", session.id, "continue", config());
		const history = invokeMock.mock.lastCall?.[0].history ?? [];
		expect(history[0]?.content).toBe("Earlier goals and decisions");
		expect(history.some((m) => m.content.startsWith("question 0"))).toBe(false);
		expect(history.at(-1)?.content).toBe("continue");
	});

	it("ignores malformed, old, and cross-project files without blocking document opening", async () => {
		const documents = new DocumentService(root, root);
		const doc = await documents.createProject("Still opens");
		const file = path.join(root, doc.project.id + ".chat.json");
		for (const bad of [
			"{broken",
			JSON.stringify({ version: 0, projectId: doc.project.id, sessions: [] }),
			JSON.stringify({ version: 1, projectId: "proj_other", sessions: [] }),
		]) {
			writeFileSync(file, bad);
			await restart();
			expect(listSessions(doc.project.id)).toEqual([]);
			await expect(documents.getProject(doc.project.id)).resolves.toMatchObject({
				project: { id: doc.project.id },
			});
		}
	});

	it("does not trust a checkpoint id found in a saved transcript", async () => {
		const session = createSession("proj_false_rewind");
		await flushChatPersistence();
		const file = path.join(root, "proj_false_rewind.chat.json");
		const saved = JSON.parse(readFileSync(file, "utf8"));
		saved.sessions[0].messages = [
			{
				id: "user_1",
				role: "user",
				content: "old message",
				createdAt: new Date().toISOString(),
				checkpointId: "missing",
			},
		];
		writeFileSync(file, JSON.stringify(saved));
		await restart();
		expect(selectSession("proj_false_rewind", session.id)?.messages[0]?.checkpointId).toBeNull();
		expect(rewindToMessage("proj_false_rewind", session.id, "user_1").success).toBe(false);
	});

	it("skips a damaged session while retaining valid siblings", async () => {
		const good = createSession("proj_partial", "Good");
		await flushChatPersistence();
		const file = path.join(root, "proj_partial.chat.json");
		const saved = JSON.parse(readFileSync(file, "utf8"));
		saved.sessions.push({ id: "broken", projectId: "proj_partial", messages: "wrong" });
		writeFileSync(file, JSON.stringify(saved));
		await restart();
		expect(listSessions("proj_partial")).toEqual([good]);
	});

	it("removes chat history when the owning project is deleted", async () => {
		createSession("proj_removed", "Disposable");
		const file = path.join(root, "proj_removed.chat.json");
		// Written off the event loop: nothing is on disk until the queue runs.
		expect(existsSync(file)).toBe(false);
		await flushChatPersistence();
		expect(existsSync(file)).toBe(true);
		renameSession("proj_removed", listSessions("proj_removed")[0]?.id ?? "", "Queued write");
		// Queued behind that pending write, so the write cannot recreate the file.
		const deleting = deleteProjectChat("proj_removed");
		// The file still holds the deleted session until the queue reaches the delete.
		expect(listSessions("proj_removed")).toEqual([]);
		await deleting;
		expect(existsSync(file)).toBe(false);
		await restart();
		expect(listSessions("proj_removed")).toEqual([]);
	});

	it("does not recreate the history of a project deleted while the agent replies", async () => {
		const session = createSession("proj_mid_turn");
		let reply: (value: Awaited<ReturnType<typeof invokeOpenScreenAgent>>) => void = () => undefined;
		invokeMock.mockImplementation(() => new Promise((resolve) => (reply = resolve)));
		const turn = runChat("proj_mid_turn", session.id, "question", config());
		await vi.waitFor(() => expect(invokeMock).toHaveBeenCalled());
		await deleteProjectChat("proj_mid_turn");
		const document = createEmptyDocument({ title: "x", projectId: "proj_mid_turn" });
		reply({
			text: "late reply",
			document,
			mutated: false,
			usage: createTurnUsageAccumulator().snapshot(),
		});

		expect(await turn).toMatchObject({ success: false });
		await restart();
		expect(existsSync(path.join(root, "proj_mid_turn.chat.json"))).toBe(false);
		expect(listSessions("proj_mid_turn")).toEqual([]);
	});

	it("reports a project deleted even when its chat history cannot be removed", async () => {
		const documents = new DocumentService(root, root);
		const doc = await documents.createProject("Doomed");
		const service = new AiEditionService({
			documents,
			deleteChatHistory: async () => {
				throw new Error("disk says no");
			},
		} as unknown as AiEditionServiceOptions);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		await expect(service.deleteProject(doc.project.id)).resolves.toEqual({ success: true });
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
});
