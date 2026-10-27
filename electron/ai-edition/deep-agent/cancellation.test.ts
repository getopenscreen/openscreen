import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument } from "../../../src/lib/ai-edition/schema";
import type { ShaderEffectCheck } from "../../../src/lib/ai-edition/shaderEffects";
import { buildTools, invokeOpenScreenAgent, type OpenScreenAgentSink } from "./service";

const doc = () => createEmptyDocument({ projectId: "stop_test", title: "Before" });
function sink(): OpenScreenAgentSink {
	return {
		text: vi.fn(),
		thinking: vi.fn(),
		toolStart: vi.fn(),
		toolEnd: vi.fn(),
		error: vi.fn(),
		document: vi.fn(),
	};
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const servers: ReturnType<typeof createServer>[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		server.close();
	}
});

async function provider(onRequest: (res: ServerResponse, call: number) => void) {
	let calls = 0;
	const server = createServer(async (req, res) => {
		for await (const _ of req) {
			/* consume request */
		}
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		onRequest(res, ++calls);
	});
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing provider address");
	return {
		provider: "openai-compatible",
		model: "test",
		apiKey: "test",
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		maxRetries: 0,
	};
}
function chunk(res: ServerResponse, delta: unknown, finish: string | null = null) {
	res.write(
		`data: ${JSON.stringify({ id: "chat-test", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
	);
}
function end(res: ServerResponse) {
	res.end("data: [DONE]\n\n");
}

// This uses the real createAgent, ChatOpenAI and HTTP streaming transport. Only
// the provider is local, so a mock accepting a signal cannot make it pass.
describe("agent cancellation", () => {
	it("aborts the actual model HTTP stream and preserves partial text without an error", async () => {
		const started = deferred<void>();
		const disconnected = deferred<void>();
		const model = await provider((res) => {
			res.on("close", () => disconnected.resolve());
			chunk(res, { role: "assistant", content: "Already answered" });
			started.resolve();
		});
		const controller = new AbortController();
		const events = sink();
		const running = invokeOpenScreenAgent({
			document: doc(),
			model,
			history: [],
			userMessage: "hello",
			sink: events,
			signal: controller.signal,
		});
		await started.promise;
		await vi.waitFor(() => expect(events.text).toHaveBeenCalledWith("Already answered"));
		controller.abort();
		const result = await running;
		expect(result).toMatchObject({ cancelled: true, text: "Already answered", mutated: false });
		expect(events.error).not.toHaveBeenCalled();
		await disconnected.promise;
	});

	it("treats a stop during the final text callback as cancellation, with one retained answer", async () => {
		const model = await provider((res) => {
			chunk(res, { role: "assistant", content: "Done" });
			chunk(res, {}, "stop");
			end(res);
		});
		const controller = new AbortController();
		const events = sink();
		events.text = () => controller.abort();
		const result = await invokeOpenScreenAgent({
			document: doc(),
			model,
			history: [],
			userMessage: "hello",
			sink: events,
			signal: controller.signal,
		});
		expect(result).toMatchObject({ cancelled: true, text: "Done" });
		expect(events.error).not.toHaveBeenCalled();
	});

	it("handles a stop before model setup without reporting a model failure", async () => {
		const controller = new AbortController();
		controller.abort();
		const events = sink();
		const result = await invokeOpenScreenAgent({
			document: doc(),
			model: { provider: "openai", model: "test" },
			history: [],
			userMessage: "hello",
			sink: events,
			signal: controller.signal,
		});
		expect(result).toMatchObject({ cancelled: true, text: "", mutated: false });
		expect(events.error).not.toHaveBeenCalled();
	});

	it("keeps completed tool edits, suppresses queued writes and discards an in-flight shader check", async () => {
		const controller = new AbortController();
		const holder = { current: doc() };
		const events = sink();
		const checking = deferred<void>();
		// A read-only compiler can finish after stop; it must never reach the executor.
		let finishCheck!: (value: ShaderEffectCheck) => void;
		const check = new Promise<ShaderEffectCheck>((resolve) => {
			finishCheck = resolve;
		});
		const tools = buildTools(holder, events, true, {
			signal: controller.signal,
			checkShaderEffect: async () => {
				checking.resolve();
				return await check;
			},
		});
		const find = (name: string) =>
			tools.find((tool) => tool.name === name)! as StructuredToolInterface;
		await find("setVocabulary").invoke({ vocabulary: "Kept" });
		const pending = find("addEffect").invoke({
			startSec: 0,
			endSec: 1,
			effect: {
				name: "test",
				description: "test",
				code: "fn effect(uv: vec2<f32>) -> vec4<f32> { return frame(uv); }",
			},
		});
		const queued = find("setVocabulary").invoke({ vocabulary: "Late" });
		const failed = Promise.allSettled([pending, queued]);
		await checking.promise;
		controller.abort();
		finishCheck({});
		const results = await failed;
		expect(results.every((result) => result.status === "rejected")).toBe(true);
		expect(holder.current.project.vocabulary).toBe("Kept");
		expect(events.document).toHaveBeenCalledOnce();
		expect(events.toolEnd).toHaveBeenCalledOnce();
	});

	it("returns completed edits when stopped between tool execution and the final answer", async () => {
		const waiting = deferred<void>();
		const model = await provider((res, call) => {
			if (call === 1) {
				chunk(res, {
					role: "assistant",
					tool_calls: [
						{
							index: 0,
							id: "tool-1",
							type: "function",
							function: { name: "setVocabulary", arguments: '{"vocabulary":"Kept"}' },
						},
					],
				});
				chunk(res, {}, "tool_calls");
				res.write(
					`data: ${JSON.stringify({ id: "chat-test", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } })}\n\n`,
				);
				end(res);
			} else {
				chunk(res, { role: "assistant", content: "Applied. " });
				waiting.resolve();
			}
		});
		const controller = new AbortController();
		const events = sink();
		const run = invokeOpenScreenAgent({
			document: doc(),
			model,
			history: [],
			userMessage: "set vocabulary",
			sink: events,
			signal: controller.signal,
		});
		await waiting.promise;
		controller.abort();
		const result = await run;
		expect(result.cancelled).toBe(true);
		expect(result.usage).toMatchObject({
			totalTokens: 25,
			modelCallCount: 2,
			countedCallCount: 1,
			status: "partial",
		});
		expect(result.document.project.vocabulary).toBe("Kept");
		expect(result.mutated).toBe(true);
		expect(events.document).toHaveBeenCalledOnce();
		expect(events.error).not.toHaveBeenCalled();
	});

	it("lets completion win when stop arrives after the last event", async () => {
		const model = await provider((res) => {
			chunk(res, { role: "assistant", content: "Done" });
			chunk(res, {}, "stop");
			end(res);
		});
		const controller = new AbortController();
		const result = await invokeOpenScreenAgent({
			document: doc(),
			model,
			history: [],
			userMessage: "hello",
			sink: sink(),
			signal: controller.signal,
		});
		controller.abort();
		expect(result).toMatchObject({ text: "Done", mutated: false });
		expect(result.cancelled).not.toBe(true);
	});
});
