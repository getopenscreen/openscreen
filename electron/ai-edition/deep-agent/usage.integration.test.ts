import { createServer, type ServerResponse } from "node:http";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { createAgent, tool } from "langchain";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { createEmptyDocument } from "../../../src/lib/ai-edition/schema";
import * as chatModelFactory from "./chat-model";
import { invokeOpenScreenAgent } from "./service";
import { createTurnUsageAccumulator } from "./usage";

function sse(res: ServerResponse, events: unknown[], named = false) {
	res.writeHead(200, { "content-type": "text/event-stream" });
	for (const event of events) {
		if (named) res.write(`event: ${(event as { type: string }).type}\n`);
		res.write(`data: ${JSON.stringify(event)}\n\n`);
	}
	if (!named) res.write("data: [DONE]\n\n");
	res.end();
}

it.each([
	"chat",
	"nonstream",
	"responses",
	"anthropic",
	"failure",
	"empty",
])("counts real %s agent events", async (mode) => {
	let requests = 0;
	const server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			requests++;
			if (mode === "failure" && requests === 2) {
				res.writeHead(400);
				res.end(
					JSON.stringify({ error: { message: "fixture failure", type: "invalid_request_error" } }),
				);
				return;
			}
			if (mode === "anthropic") {
				sse(
					res,
					[
						{
							type: "message_start",
							message: {
								id: "msg_1",
								type: "message",
								role: "assistant",
								model: "claude-fixture",
								content: [],
								stop_reason: null,
								stop_sequence: null,
								usage: {
									input_tokens: 10,
									output_tokens: 0,
									cache_read_input_tokens: 4,
									cache_creation_input_tokens: 3,
								},
							},
						},
						{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
						{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done" } },
						{ type: "content_block_stop", index: 0 },
						{
							type: "message_delta",
							delta: { stop_reason: "end_turn", stop_sequence: null },
							usage: { output_tokens: 5 },
						},
						{ type: "message_stop" },
					],
					true,
				);
				return;
			}
			if (mode === "responses") {
				const response = {
					id: "resp_1",
					object: "response",
					created_at: 1,
					status: "completed",
					model: "gpt-fixture",
					output: [
						{
							id: "m1",
							type: "message",
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: "Done", annotations: [] }],
						},
					],
					usage: {
						input_tokens: 10,
						output_tokens: 5,
						total_tokens: 15,
						input_tokens_details: { cached_tokens: 4 },
						output_tokens_details: { reasoning_tokens: 2 },
					},
				};
				sse(
					res,
					[
						{
							type: "response.created",
							response: { ...response, status: "in_progress", output: [] },
						},
						{
							type: "response.output_text.delta",
							item_id: "m1",
							output_index: 0,
							content_index: 0,
							delta: "Done",
						},
						{ type: "response.completed", response },
					],
					true,
				);
				return;
			}
			const useTool = (mode === "chat" || mode === "failure") && requests === 1;
			const message = useTool
				? {
						role: "assistant",
						content: "",
						tool_calls: [
							{
								id: "call_1",
								type: "function",
								function: { name: "getCurrentDocument", arguments: "{}" },
							},
						],
					}
				: { role: "assistant", content: mode === "empty" ? "" : "Done" };
			const usage = {
				prompt_tokens: 10,
				completion_tokens: 5,
				total_tokens: 15,
				prompt_tokens_details: { cached_tokens: 4 },
				completion_tokens_details: { reasoning_tokens: 2 },
			};
			if (mode === "nonstream") {
				res.setHeader("content-type", "application/json");
				res.end(
					JSON.stringify({
						id: "chat1",
						object: "chat.completion",
						created: 1,
						model: "fixture",
						choices: [{ index: 0, message, finish_reason: "stop" }],
						usage,
					}),
				);
				return;
			}
			sse(res, [
				{
					id: "chat1",
					object: "chat.completion.chunk",
					created: 1,
					model: "fixture",
					choices: [
						{
							index: 0,
							delta: useTool
								? { role: "assistant", tool_calls: [{ index: 0, ...message.tool_calls?.[0] }] }
								: message,
							finish_reason: null,
						},
					],
				},
				{
					id: "chat1",
					object: "chat.completion.chunk",
					created: 1,
					model: "fixture",
					choices: [],
					usage,
				},
			]);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("missing fixture address");
	const baseURL = `http://127.0.0.1:${address.port}`;
	try {
		const model =
			mode === "anthropic"
				? new ChatAnthropic({
						apiKey: "fixture",
						model: "claude-fixture",
						anthropicApiUrl: baseURL,
						maxRetries: 0,
					})
				: new ChatOpenAI({
						apiKey: "fixture",
						model: "fixture",
						configuration: { baseURL },
						maxRetries: 0,
						useResponsesApi: mode === "responses",
						disableStreaming: mode === "nonstream",
					});
		const agent = createAgent({
			model,
			tools: [
				tool(() => "read", {
					name: "getCurrentDocument",
					description: "read",
					schema: z.object({}),
				}),
			],
		});
		const accumulator = createTurnUsageAccumulator();
		const ends: Record<string, unknown>[] = [];
		try {
			for await (const event of agent.streamEvents({
				messages: [{ role: "user", content: "Read" }],
			})) {
				accumulator.observe(event);
				if (event.event === "on_chat_model_end")
					ends.push(event.data.output as Record<string, unknown>);
			}
		} catch (error) {
			if (mode !== "failure") throw error;
		}
		expect(ends).toHaveLength(mode === "chat" ? 2 : 1);
		expect(ends[0].usage_metadata).toMatchObject({
			input_tokens: mode === "anthropic" ? 17 : 10,
			output_tokens: 5,
			total_tokens: mode === "anthropic" ? 22 : 15,
		});
		expect(accumulator.snapshot()).toMatchObject({
			inputTokens: mode === "anthropic" ? 17 : mode === "chat" ? 20 : 10,
			outputTokens: mode === "chat" ? 10 : 5,
			modelCallCount: mode === "chat" || mode === "failure" ? 2 : 1,
			countedCallCount: mode === "chat" ? 2 : 1,
			status: mode === "failure" ? "partial" : "complete",
			cachedInputTokens: mode === "chat" ? 8 : 4,
		});
		if (mode === "anthropic") expect(accumulator.snapshot().cacheCreationInputTokens).toBe(3);
		requests = 0;
		const usageUpdates = vi.fn();
		const result = await invokeOpenScreenAgent({
			document: createEmptyDocument({ projectId: "usage", title: "usage" }),
			model: {
				provider:
					mode === "anthropic"
						? "anthropic"
						: mode === "nonstream"
							? "google"
							: "openai-compatible",
				model:
					mode === "nonstream"
						? "gemini-3-fixture"
						: mode === "responses"
							? "gpt-5-fixture"
							: "fixture",
				apiKey: "fixture",
				baseUrl: baseURL,
				maxRetries: 0,
			},
			history: [],
			userMessage: "Read",
			sink: {
				usage: usageUpdates,
				text: vi.fn(),
				thinking: vi.fn(),
				toolStart: vi.fn(),
				toolEnd: vi.fn(),
				error: vi.fn(),
			},
		});
		expect(usageUpdates).toHaveBeenCalled();
		expect(usageUpdates.mock.lastCall?.[0].totalTokens).toBe(result.usage.totalTokens);
		if (mode === "chat") {
			expect(usageUpdates.mock.calls.map(([value]) => value.totalTokens)).toEqual([15, 30]);
		}
		if (mode === "empty") expect(result.reason).toContain("Empty response");
		expect(result.usage).toMatchObject({
			inputTokens: mode === "anthropic" ? 17 : mode === "chat" ? 20 : 10,
			outputTokens: mode === "chat" ? 10 : 5,
			status: mode === "failure" ? "partial" : "complete",
		});
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
}, 15000);

it("returns unavailable usage for model-construction errors", async () => {
	const factory = vi
		.spyOn(chatModelFactory, "createOpenScreenChatModel")
		.mockRejectedValueOnce(new Error("construction failed"));
	const result = await invokeOpenScreenAgent({
		document: createEmptyDocument({ projectId: "usage-error", title: "usage" }),
		model: { provider: "openai-compatible", model: "fixture", baseUrl: "not a URL" },
		history: [],
		userMessage: "Read",
		sink: {
			text: vi.fn(),
			thinking: vi.fn(),
			toolStart: vi.fn(),
			toolEnd: vi.fn(),
			error: vi.fn(),
		},
	});
	expect(result.usage).toMatchObject({ modelCallCount: 0, status: "unavailable" });
	factory.mockRestore();
});

it.each([
	"nonstream-zero",
	"stream-zero",
	"missing-usage",
])("accounts for %s HTTP metadata", async (mode) => {
	const server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			const usage =
				mode !== "missing-usage"
					? { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 }
					: undefined;
			const message = { role: "assistant", content: "Done" };
			if (mode === "nonstream-zero") {
				res.setHeader("content-type", "application/json");
				res.end(
					JSON.stringify({
						id: "zero",
						object: "chat.completion",
						created: 1,
						model: "fixture",
						choices: [{ index: 0, message, finish_reason: "stop" }],
						usage,
					}),
				);
			} else
				sse(res, [
					{
						id: "missing",
						object: "chat.completion.chunk",
						created: 1,
						model: "fixture",
						choices: [{ index: 0, delta: message, finish_reason: "stop" }],
						usage,
					},
				]);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("missing address");
	try {
		const model = new ChatOpenAI({
			apiKey: "fixture",
			model: "fixture",
			configuration: { baseURL: `http://127.0.0.1:${address.port}` },
			disableStreaming: mode === "nonstream-zero",
			maxRetries: 0,
		});
		const agent = createAgent({ model, tools: [] });
		const usage = createTurnUsageAccumulator();
		for await (const event of agent.streamEvents({
			messages: [{ role: "user", content: "Read" }],
		})) {
			usage.observe(event);
			if (event.event === "on_chat_model_end" && mode === "nonstream-zero") {
				// Locked ChatOpenAI drops explicit zero completion_tokens from both
				// metadata records. Without the raw count, completeness is unknowable.
				expect(event.data.output.usage_metadata).toMatchObject({
					input_tokens: 10,
					total_tokens: 10,
				});
				expect(event.data.output.usage_metadata).not.toHaveProperty("output_tokens");
				expect(event.data.output.response_metadata.tokenUsage).toEqual({
					promptTokens: 10,
					totalTokens: 10,
				});
			}
		}
		expect(usage.snapshot()).toMatchObject({
			inputTokens: mode !== "missing-usage" ? 10 : 0,
			modelCallCount: 1,
			outputTokens: 0,
			totalTokens: mode !== "missing-usage" ? 10 : 0,
			status:
				mode === "nonstream-zero" ? "partial" : mode === "stream-zero" ? "complete" : "unavailable",
		});
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
});
