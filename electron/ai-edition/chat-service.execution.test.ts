import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createEmptyDocument } from "../../src/lib/ai-edition/schema";
import { createExecutionTracker, toolExecutionStep } from "./chat-execution";
import { ChatPersistence } from "./chat-persistence";

vi.mock("./deep-agent/service", () => ({ invokeOpenScreenAgent: vi.fn() }));

import {
	configureChatPersistence,
	createSession,
	deleteSession,
	flushChatPersistence,
	runChat,
	selectSession,
} from "./chat-service";
import { invokeOpenScreenAgent } from "./deep-agent/service";
import type { LlmConfigStore } from "./llm-config-store";

let root: string;
const config = {
	getConfig: () => ({ provider: "openai", model: "fixture" }),
	getCredential: () => ({ value: "test" }),
} as unknown as LlmConfigStore;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "openscreen-execution-"));
	configureChatPersistence(root);
});
afterEach(async () => {
	await flushChatPersistence();
	await rm(root, { recursive: true, force: true });
	vi.clearAllMocks();
});

it.each([
	"success",
	"failed",
	"stopped",
])("persists ordered %s steps on their originating turn across session changes and restart", async (mode) => {
	const session = createSession("p");
	const other = createSession("p");
	vi.mocked(invokeOpenScreenAgent).mockImplementationOnce(async (args) => {
		args.sink.thinking("**Inspect** the project");
		const first = toolExecutionStep("getTranscript", { assetId: "a" });
		const second = toolExecutionStep("getTranscript", { assetId: "b" });
		args.sink.executionStep?.(first);
		args.sink.executionStep?.(second);
		args.sink.executionStep?.({
			...second,
			status: "failed",
			summary: "No transcript",
			durationMs: 25,
		});
		args.sink.executionStep?.({ ...first, status: "succeeded", durationMs: 50 });
		args.sink.thinking("Choose the available source");
		if (mode === "stopped") args.sink.executionStep?.(toolExecutionStep("getCurrentDocument", {}));
		selectSession("p", other.id);
		return {
			text: mode === "failed" ? "" : "## Result\n\n- Done",
			reason: mode === "failed" ? "Provider failed" : undefined,
			document: args.document,
			mutated: false,
			cancelled: mode === "stopped",
		};
	});
	const source = "  indented\n\n```ts\n  const x = 1;\n```\n";
	const result = await runChat(
		"p",
		session.id,
		source,
		config,
		createEmptyDocument({ projectId: "p", title: "test" }),
	);
	expect(vi.mocked(invokeOpenScreenAgent).mock.lastCall?.[0].userMessage).toBe(source);
	const message = mode === "failed" ? result.userMessage : result.assistantMessage;
	expect(message?.executionSteps?.map((step) => step.kind)).toEqual(
		mode === "stopped"
			? ["reasoning", "tool", "tool", "reasoning", "tool"]
			: ["reasoning", "tool", "tool", "reasoning"],
	);
	expect(message?.executionSteps?.[2]).toMatchObject({
		status: "failed",
		summary: "No transcript",
	});
	if (mode === "stopped")
		expect(message?.executionSteps?.at(-1)).toMatchObject({ status: "stopped" });
	await flushChatPersistence();
	configureChatPersistence(root);
	const history = selectSession("p", session.id)!;
	expect(history.messages[0].content).toBe(source);
	expect(history.messages.at(-1)?.executionSteps).toEqual(message?.executionSteps);
	expect(selectSession("p", other.id)?.messages).toEqual([]);
	const persisted = await readFile(join(root, "p.chat.json"), "utf8");
	expect(persisted).not.toContain("resultJson");
});

it("does not recreate execution history after the originating session is deleted", async () => {
	const session = createSession("p");
	vi.mocked(invokeOpenScreenAgent).mockImplementationOnce(async (args) => {
		args.sink.thinking("Inspect");
		deleteSession("p", session.id);
		args.sink.executionStep?.(toolExecutionStep("getTranscript", {}));
		return { text: "Done", document: args.document, mutated: false };
	});
	const result = await runChat("p", session.id, "hello", config);
	expect(result.success).toBe(false);
	await flushChatPersistence();
	configureChatPersistence(root);
	expect(selectSession("p", session.id)).toBeNull();
});

it("restores an interrupted running step and tolerates legacy or malformed metadata", async () => {
	const store = new ChatPersistence(root);
	const tracker = createExecutionTracker(vi.fn());
	tracker.tool(toolExecutionStep("getTranscript", {}));
	const base = { id: "a", projectId: "p", title: "A", createdAt: "now" };
	await store.write("p", [
		{
			...base,
			messages: [
				{ id: "m1", role: "user", content: "legacy", createdAt: "now" },
				{
					id: "m2",
					role: "assistant",
					content: "partial",
					createdAt: "now",
					executionSteps: tracker.snapshot(),
				},
			],
		},
	]);
	const history = store.read("p")[0];
	expect(history.messages[0].executionSteps).toBeUndefined();
	expect(history.messages[1].executionSteps?.[0]).toMatchObject({ status: "stopped" });
	await writeFile(
		store.fileFor("p"),
		JSON.stringify({
			version: 1,
			projectId: "p",
			sessions: [
				{
					...base,
					messages: [
						{
							id: "old",
							role: "assistant",
							content: "Retained message",
							createdAt: "now",
							executionSteps: [{ kind: "invalid" }],
						},
					],
				},
			],
		}),
	);
	const malformed = store.read("p")[0].messages[0];
	expect(malformed.content).toBe("Retained message");
	expect(malformed.executionSteps).toBeUndefined();
});
