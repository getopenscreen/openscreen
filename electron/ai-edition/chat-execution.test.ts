import { once } from "node:events";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { describe, expect, it, vi } from "vitest";
import { createEmptyDocument } from "../../src/lib/ai-edition/schema";
import {
	createExecutionTracker,
	executionSummary,
	executionText,
	toolExecutionStep,
} from "./chat-execution";
import { buildTools } from "./deep-agent/service";

describe("execution metadata", () => {
	it("keeps reasoning and repeated/concurrent invocation identities in observed order", () => {
		const tracker = createExecutionTracker(vi.fn());
		tracker.thinking("**Read** the transcript");
		const first = toolExecutionStep("getTranscript", {});
		const second = toolExecutionStep("getTranscript", {});
		tracker.tool(first);
		tracker.tool(second);
		tracker.tool({ ...second, status: "failed", summary: "No transcript" });
		tracker.tool({ ...first, status: "succeeded" });
		tracker.thinking("Try another source");
		const steps = tracker.finish(false);
		expect(steps.map((step) => step.kind)).toEqual(["reasoning", "tool", "tool", "reasoning"]);
		expect(steps[1]).toMatchObject({ id: first.id, status: "succeeded" });
		expect(steps[2]).toMatchObject({ id: second.id, status: "failed" });
		expect(first.id).not.toBe(second.id);
	});
	it("keeps sensitive arbitrary strings out of argument and result metadata", () => {
		const step = toolExecutionStep("addAnnotation", {
			apiKey: "private",
			password: 12345,
			text: "private",
			assetId: "asset_1",
			startSec: 2,
			words: ["private"],
		});
		expect(step.arguments).toBe("assetId: asset_1, startSec: 2, words: 1");
		expect(executionText("Bearer private apiKey=private sk-abcdefghijklmnop")).not.toContain(
			"private",
		);
		expect(
			executionSummary({
				ok: true,
				resultJson: JSON.stringify({ raw: "private", words: ["private"], count: 1 }),
			}),
		).toBe("words: 1, count: 1");
		expect(executionSummary({ ok: false, resultJson: '{"error":"No transcript"}' })).toBe(
			"No transcript",
		);
		expect(executionText("x".repeat(2000))).toHaveLength(1000);
	});
	it("uses the real executor verdict and pairs each repeated call by id", async () => {
		const events = vi.fn();
		const holder = { current: createEmptyDocument({ projectId: "steps", title: "Test" }) };
		const tools = buildTools(
			holder,
			{
				executionStep: events,
				toolStart: vi.fn(),
				toolEnd: vi.fn(),
				text: vi.fn(),
				thinking: vi.fn(),
				error: vi.fn(),
			},
			true,
		);
		const tool = tools.find((entry) => entry.name === "getTranscript")! as StructuredToolInterface;
		await tool.invoke({ assetId: "missing" });
		await tool.invoke({ assetId: "missing" });
		const steps = events.mock.calls.map(([step]) => step);
		expect(steps).toHaveLength(4);
		expect(steps[1]).toMatchObject({
			id: steps[0].id,
			status: "failed",
			summary: expect.stringMatching(/asset|transcript/i),
			durationMs: expect.any(Number),
		});
		expect(steps[3]).toMatchObject({ id: steps[2].id, status: "failed" });
		expect(steps[0].id).not.toBe(steps[2].id);
	});
});

it("reports repeated real SDK calls and schema/unknown-tool failures once per invocation", async () => {
	const { createServer } = await import("node:http");

	const { invokeOpenScreenAgent } = await import("./deep-agent/service");
	const steps = new Map<
		string,
		import("../../src/lib/ai-edition/chatExecution").ToolExecutionStep
	>();
	let requests = 0;
	const server = createServer(async (req, res) => {
		for await (const _ of req) {
			/* consume local fixture request */
		}
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		const first = ++requests === 1;
		const delta = first
			? {
					role: "assistant",
					tool_calls: [
						"getCurrentDocument",
						"getCurrentDocument",
						"getTranscript",
						"nonexistentTool",
					].map((name, index) => ({
						index,
						id: `call_${index}`,
						type: "function",
						function: {
							name,
							arguments: JSON.stringify(name === "getTranscript" ? { assetId: 123 } : {}),
						},
					})),
				}
			: { role: "assistant", content: "Done" };
		for (const [value, finish] of [
			[delta, null],
			[{}, first ? "tool_calls" : "stop"],
		])
			res.write(
				`data: ${JSON.stringify({ id: "chat_fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`,
			);
		res.end("data: [DONE]\n\n");
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing local port");
	try {
		const result = await invokeOpenScreenAgent({
			document: createEmptyDocument({ projectId: "sdk_steps", title: "Test" }),
			model: {
				provider: "openai-compatible",
				model: "fixture",
				apiKey: "local-only",
				baseUrl: `http://127.0.0.1:${address.port}/v1`,
				maxRetries: 0,
			},
			history: [],
			userMessage: "Inspect",
			sink: {
				executionStep: (step) => steps.set(step.id, step),
				text: vi.fn(),
				thinking: vi.fn(),
				toolStart: vi.fn(),
				toolEnd: vi.fn(),
				error: vi.fn(),
			},
		});
		expect(result.text).toBe("Done");
		expect([...steps.values()].map((step) => [step.name, step.status])).toEqual([
			["getCurrentDocument", "succeeded"],
			["getCurrentDocument", "succeeded"],
			["getTranscript", "failed"],
			["nonexistentTool", "failed"],
		]);
		expect([...steps.values()][2].summary).toMatch(/schema|input|assetId/i);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
