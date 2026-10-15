import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument } from "../../src/lib/ai-edition/schema";

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
	}));
});

afterEach(async () => {
	await flushChatPersistence();
	rmSync(root, { recursive: true, force: true });
});

describe("local Agent chat history", () => {
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

	it("drops the rewound message from the saved history and the next turn's payload", async () => {
		const session = createSession("proj_rewound");
		const document = createEmptyDocument({ title: "Test", projectId: "proj_rewound" });
		await runChat("proj_rewound", session.id, "smart cuts", config(), document);
		await runChat("proj_rewound", session.id, "add an annotation and a zoom", config(), document);
		const rewound = selectSession("proj_rewound", session.id)?.messages[2];
		const undo = rewindToMessage("proj_rewound", session.id, rewound?.id ?? "");
		expect(undo.success && undo.prompt).toBe("add an annotation and a zoom");
		const kept = selectSession("proj_rewound", session.id)?.messages;
		expect(kept?.map((m) => m.content)).toEqual(["smart cuts", "reply"]);
		await flushChatPersistence();
		expect(readFileSync(path.join(root, "proj_rewound.chat.json"), "utf8")).not.toContain(
			"add an annotation",
		);

		await restart();
		await runChat("proj_rewound", session.id, "export it", config());
		const sent = invokeMock.mock.lastCall?.[0];
		const payload = [...(sent?.history ?? []).map((m) => m.content), sent?.userMessage];
		expect(payload).not.toContain("add an annotation and a zoom");
	});

	it("still rewinds an earlier message after a later one was rewound", async () => {
		const session = createSession("proj_rewind_twice");
		const document = createEmptyDocument({ title: "Test", projectId: "proj_rewind_twice" });
		await runChat("proj_rewind_twice", session.id, "smart cuts", config(), document);
		await runChat("proj_rewind_twice", session.id, "add a zoom", config(), document);
		const second = selectSession("proj_rewind_twice", session.id)?.messages[2];
		expect(rewindToMessage("proj_rewind_twice", session.id, second?.id ?? "").success).toBe(true);
		const first = selectSession("proj_rewind_twice", session.id)?.messages[0];
		const undo = rewindToMessage("proj_rewind_twice", session.id, first?.id ?? "");
		expect(undo.success && undo.prompt).toBe("smart cuts");
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
		reply({ text: "late reply", document, mutated: false });

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
