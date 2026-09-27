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
	compactSessionNow,
	configureChatPersistence,
	createSession,
	deleteProjectChat,
	deleteSession,
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

function restart() {
	configureChatPersistence(root);
}

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "openscreen-chat-"));
	restart();
	invokeMock.mockReset();
	modelMock.mockReset();
	invokeMock.mockImplementation(async (args) => ({
		text: "reply",
		document: args.document,
		mutated: false,
	}));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("local Agent chat history", () => {
	it("restores multiple sessions and persists rename and delete per project", () => {
		const first = createSession("proj_a", "First");
		const deleted = createSession("proj_a", "Deleted");
		const other = createSession("proj_b", "Other");
		renameSession("proj_a", first.id, "Renamed");
		expect(deleteSession("proj_a", deleted.id)).toBe(true);

		restart();
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
		const file = path.join(root, "proj_chat.chat.json");
		expect(readFileSync(file, "utf8")).not.toContain(key);
		expect(readFileSync(file, "utf8")).not.toContain("checkpointId");

		restart();
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
		restart();
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
			restart();
			expect(listSessions(doc.project.id)).toEqual([]);
			await expect(documents.getProject(doc.project.id)).resolves.toMatchObject({
				project: { id: doc.project.id },
			});
		}
	});

	it("does not trust a checkpoint id found in a saved transcript", () => {
		const session = createSession("proj_false_rewind");
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
		restart();
		expect(selectSession("proj_false_rewind", session.id)?.messages[0]?.checkpointId).toBeNull();
		expect(rewindToMessage("proj_false_rewind", session.id, "user_1").success).toBe(false);
	});

	it("skips a damaged session while retaining valid siblings", () => {
		const good = createSession("proj_partial", "Good");
		const file = path.join(root, "proj_partial.chat.json");
		const saved = JSON.parse(readFileSync(file, "utf8"));
		saved.sessions.push({ id: "broken", projectId: "proj_partial", messages: "wrong" });
		writeFileSync(file, JSON.stringify(saved));
		restart();
		expect(listSessions("proj_partial")).toEqual([good]);
	});

	it("removes chat history when the owning project is deleted", () => {
		createSession("proj_removed", "Disposable");
		const file = path.join(root, "proj_removed.chat.json");
		expect(existsSync(file)).toBe(true);
		deleteProjectChat("proj_removed");
		expect(existsSync(file)).toBe(false);
		restart();
		expect(listSessions("proj_removed")).toEqual([]);
	});
});
