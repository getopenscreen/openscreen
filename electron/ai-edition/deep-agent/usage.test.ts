import { describe, expect, it } from "vitest";
import { createTurnUsageAccumulator } from "./usage";

const start = (run_id = "a") => ({ event: "on_chat_model_start", run_id });
const end = (usage_metadata?: unknown, run_id = "a") => ({
	event: "on_chat_model_end",
	run_id,
	data: { output: { usage_metadata } },
});
const full = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };
describe("turn usage", () => {
	it.each([
		["cachedInputTokens", "input", "cache_read"],
		["cacheCreationInputTokens", "input", "cache_creation"],
		["reasoningOutputTokens", "output", "reasoning"],
	] as const)("omits %s when core overflow retains a smaller parent lower bound", (field, direction, detail) => {
		const a = createTurnUsageAccumulator();
		const parent = direction === "input" ? "input_tokens" : "output_tokens";
		const details = direction === "input" ? "input_token_details" : "output_token_details";
		a.observe(end({ input_tokens: 0, output_tokens: 0, [parent]: 1, [details]: { [detail]: 1 } }));
		a.observe(
			end(
				{
					input_tokens: 0,
					output_tokens: 0,
					[parent]: Number.MAX_SAFE_INTEGER,
					[details]: { [detail]: Number.MAX_SAFE_INTEGER - 1 },
				},
				"b",
			),
		);
		const result = a.snapshot();
		expect(result).toMatchObject({ status: "partial", modelCallCount: 2, countedCallCount: 2 });
		expect(direction === "input" ? result.inputTokens : result.outputTokens).toBe(1);
		expect(result.totalTokens).toBe(1);
		expect(result).not.toHaveProperty(field);
	});

	it("bounds enriched details against retained conflicting core", () => {
		const a = createTurnUsageAccumulator();
		a.observe(end(full));
		a.observe(
			end({
				input_tokens: 20,
				output_tokens: 10,
				total_tokens: 30,
				input_token_details: { cache_read: 15, cache_creation: 15 },
				output_token_details: { reasoning: 8 },
			}),
		);
		expect(a.snapshot()).toMatchObject({ inputTokens: 10, outputTokens: 5, status: "partial" });
		expect(a.snapshot()).not.toHaveProperty("cachedInputTokens");
		expect(a.snapshot()).not.toHaveProperty("cacheCreationInputTokens");
		expect(a.snapshot()).not.toHaveProperty("reasoningOutputTokens");
	});

	it("enriches missing details on duplicate finals", () => {
		const a = createTurnUsageAccumulator();
		a.observe(end(full));
		a.observe(end({ ...full, input_token_details: { cache_read: 4 } }));
		expect(a.snapshot()).toMatchObject({ cachedInputTokens: 4, status: "complete" });
	});
	it("preserves first details and marks conflicting details partial", () => {
		const a = createTurnUsageAccumulator();
		a.observe(end({ ...full, input_token_details: { cache_read: 4 } }));
		a.observe(end({ ...full, input_token_details: { cache_read: 8 } }));
		expect(a.snapshot()).toMatchObject({ cachedInputTokens: 4, status: "partial" });
	});
	it("merges complementary partial finals", () => {
		const a = createTurnUsageAccumulator();
		a.observe(end({ input_tokens: 10 }));
		a.observe(end({ output_tokens: 5, total_tokens: 15 }));
		expect(a.snapshot()).toMatchObject({
			inputTokens: 10,
			outputTokens: 5,
			totalTokens: 15,
			status: "complete",
		});
	});

	it("upgrades total-only metadata when later input/output agree", () => {
		const a = createTurnUsageAccumulator();
		a.observe(end({ total_tokens: 15 }));
		a.observe(end({ input_tokens: 10, output_tokens: 5 }));
		expect(a.snapshot()).toMatchObject({ totalTokens: 15, status: "complete" });
	});

	it("sums three completed calls to 660", () => {
		const a = createTurnUsageAccumulator();
		for (const [id, input, output] of [
			["a", 100, 10],
			["b", 200, 20],
			["c", 300, 30],
		] as const)
			a.observe(end({ input_tokens: input, output_tokens: output }, id));
		expect(a.snapshot()).toMatchObject({
			inputTokens: 600,
			outputTokens: 60,
			totalTokens: 660,
			modelCallCount: 3,
			countedCallCount: 3,
			status: "complete",
		});
	});
	it("retains optional details when a duplicate end omits them", () => {
		const a = createTurnUsageAccumulator();
		a.observe(end({ ...full, input_token_details: { cache_read: 4 } }));
		a.observe(end(full));
		expect(a.snapshot().cachedInputTokens).toBe(4);
	});

	it("is unavailable without observations or credible usage", () => {
		const a = createTurnUsageAccumulator();
		expect(a.snapshot().status).toBe("unavailable");
		a.observe(start());
		a.observe(end());
		expect(a.snapshot()).toMatchObject({
			modelCallCount: 1,
			countedCallCount: 0,
			status: "unavailable",
		});
	});
	it("counts final messages once, ignores chunks and upgrades missing usage", () => {
		const a = createTurnUsageAccumulator();
		a.observe(start());
		a.observe({
			event: "on_chat_model_stream",
			run_id: "a",
			data: { chunk: { usage_metadata: full } },
		});
		a.observe(end());
		a.observe(end(full));
		a.observe(end(full));
		expect(a.snapshot()).toMatchObject({
			inputTokens: 10,
			outputTokens: 5,
			totalTokens: 15,
			modelCallCount: 1,
			countedCallCount: 1,
			status: "complete",
		});
	});
	it("retains the first credible record on conflict", () => {
		const a = createTurnUsageAccumulator();
		a.observe(end(full));
		a.observe(end({ ...full, input_tokens: 11, total_tokens: 16 }));
		expect(a.snapshot()).toMatchObject({ inputTokens: 10, totalTokens: 15, status: "partial" });
	});
	it("upgrades a partial final record when later metadata supplies missing core fields", () => {
		const a = createTurnUsageAccumulator();
		a.observe(end({ input_tokens: 10 }));
		a.observe(end(full));
		expect(a.snapshot()).toMatchObject({ inputTokens: 10, totalTokens: 15, status: "complete" });
	});
	it("accepts explicit zero and omitted total", () => {
		const a = createTurnUsageAccumulator();
		a.observe(end({ input_tokens: 0, output_tokens: 0 }));
		expect(a.snapshot()).toMatchObject({ countedCallCount: 1, totalTokens: 0, status: "complete" });
	});
	it.each([
		{ input_tokens: 8 },
		{ output_tokens: 3 },
		{ total_tokens: 12 },
		{ ...full, total_tokens: 20 },
		{ input_tokens: 10, output_tokens: "5" },
		{ input_tokens: 10, output_tokens: -1 },
		{ input_tokens: 10, output_tokens: Infinity },
		{ input_tokens: 10, output_tokens: 0.5 },
	])("retains lower bounds for %j", (usage) => {
		const a = createTurnUsageAccumulator();
		a.observe(end(usage));
		expect(a.snapshot()).toMatchObject({ countedCallCount: 1, status: "partial" });
	});
	it("rejects unsafe sums", () => {
		const a = createTurnUsageAccumulator();
		a.observe(end({ input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 }));
		expect(a.snapshot().status).toBe("partial");
		expect(Number.isSafeInteger(a.snapshot().totalTokens)).toBe(true);
	});
	it("does not sum unidentified calls and keeps prior totals on failures", () => {
		const a = createTurnUsageAccumulator();
		a.observe(end(full));
		a.observe(end(full, ""));
		a.observe(start("b"));
		a.observe({ event: "on_chat_model_error", run_id: "b" });
		expect(a.snapshot()).toMatchObject({
			totalTokens: 15,
			modelCallCount: 2,
			countedCallCount: 1,
			status: "partial",
		});
	});
	it("omits invalid details, includes subsets without adding them", () => {
		const a = createTurnUsageAccumulator();
		a.observe(
			end({
				...full,
				input_token_details: { cache_read: 4, cache_creation: -1 },
				output_token_details: { reasoning: 2 },
			}),
		);
		expect(a.snapshot()).toMatchObject({
			totalTokens: 15,
			cachedInputTokens: 4,
			reasoningOutputTokens: 2,
			status: "complete",
		});
		expect(a.snapshot()).not.toHaveProperty("cacheCreationInputTokens");
	});
	it("marks unfinished and missing metadata calls partial", () => {
		const a = createTurnUsageAccumulator();
		a.observe(end(full));
		a.observe(start("b"));
		expect(a.snapshot().status).toBe("partial");
		a.observe(end(undefined, "b"));
		expect(a.snapshot().status).toBe("partial");
	});
	it("ignores raw response metadata and unrelated events", () => {
		const a = createTurnUsageAccumulator();
		a.observe({ event: "on_chain_end", run_id: "x" });
		a.observe({
			event: "on_chat_model_end",
			run_id: "a",
			data: { output: { response_metadata: { usage: full } } },
		});
		expect(a.snapshot()).toMatchObject({ modelCallCount: 1, status: "unavailable" });
	});
	it("prevents overflow across calls", () => {
		const a = createTurnUsageAccumulator();
		a.observe(end({ input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 0 }));
		a.observe(end(full, "b"));
		expect(a.snapshot().status).toBe("partial");
		expect(Number.isSafeInteger(a.snapshot().inputTokens)).toBe(true);
	});
});
