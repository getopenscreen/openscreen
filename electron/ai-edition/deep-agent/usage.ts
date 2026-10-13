import type { AgentTurnUsage } from "../../../src/native/contracts";

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | undefined {
	return value !== null && typeof value === "object" ? (value as RecordValue) : undefined;
}
function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
interface CallUsage {
	core: { input?: number; output?: number; total?: number };
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	complete: boolean;
	cachedInputTokens?: number;
	cacheCreationInputTokens?: number;
	reasoningOutputTokens?: number;
}
function parseUsage(value: unknown): CallUsage | undefined {
	const usage = record(value);
	if (!usage) return undefined;
	const input = count(usage.input_tokens);
	const output = count(usage.output_tokens);
	const total = count(usage.total_tokens);
	if (input === undefined && output === undefined && total === undefined) return undefined;
	const sum = (input ?? 0) + (output ?? 0);
	const safe = Number.isSafeInteger(sum);
	const full = input !== undefined && output !== undefined;
	let totalTokens: number;
	// Incomplete core fields retain known lower bounds. Full input/output are
	// authoritative even when a provider reports an inconsistent total.
	if (safe && full) totalTokens = sum;
	else if (safe) totalTokens = Math.max(sum, total ?? 0);
	else totalTokens = total ?? Math.max(input ?? 0, output ?? 0);
	const result: CallUsage = {
		core: { input, output, total: total ?? (full && safe ? sum : undefined) },
		inputTokens: input ?? 0,
		outputTokens: output ?? 0,
		totalTokens,
		complete: full && safe && (usage.total_tokens === undefined || total === sum),
	};
	const inputDetails = record(usage.input_token_details);
	const outputDetails = record(usage.output_token_details);
	const cached = count(inputDetails?.cache_read);
	const creation = count(inputDetails?.cache_creation);
	const reasoning = count(outputDetails?.reasoning);
	if (cached !== undefined && input !== undefined && cached <= input)
		result.cachedInputTokens = cached;
	if (creation !== undefined && input !== undefined && creation <= input)
		result.cacheCreationInputTokens = creation;
	if (reasoning !== undefined && output !== undefined && reasoning <= output)
		result.reasoningOutputTokens = reasoning;
	return result;
}

/** Only completed model messages carry authoritative usage. Stream chunks can
 * contain cumulative counters and must never be summed. SDK retries hidden
 * inside a model invocation are outside this observable accounting boundary. */
export function createTurnUsageAccumulator() {
	const calls = new Map<
		string,
		{ usage?: CallUsage; ended: boolean; conflict: boolean; failed: boolean }
	>();
	let gap = false;
	return {
		observe(value: unknown) {
			const event = record(value);
			if (
				!event ||
				!["on_chat_model_start", "on_chat_model_end", "on_chat_model_error"].includes(
					String(event.event),
				)
			)
				return;
			const id = event.run_id;
			if (typeof id !== "string" || !id.trim()) {
				gap = true;
				return;
			}
			const call = calls.get(id) ?? { ended: false, conflict: false, failed: false };
			calls.set(id, call);
			if (event.event === "on_chat_model_error") call.failed = true;
			if (event.event !== "on_chat_model_end") return;
			call.ended = true;
			const usage = parseUsage(record(record(event.data)?.output)?.usage_metadata);
			if (!usage) return;
			if (!call.usage) call.usage = usage;
			else {
				const previous = call.usage;
				const core = { ...previous.core };
				let enriched = false;
				for (const key of ["input", "output", "total"] as const) {
					const value = usage.core[key];
					if (value === undefined) continue;
					if (core[key] === undefined) {
						core[key] = value;
						enriched = true;
					} else if (core[key] !== value) call.conflict = true;
				}
				// Recompute from the union of compatible known fields. A duplicate may
				// supply just the missing output, rather than repeating its input count.
				const merged = enriched
					? parseUsage({
							input_tokens: core.input,
							output_tokens: core.output,
							total_tokens: core.total,
						})!
					: { ...previous };
				for (const key of [
					"cachedInputTokens",
					"cacheCreationInputTokens",
					"reasoningOutputTokens",
				] as const) {
					const first = previous[key];
					const next = usage[key];
					if (first !== undefined && next !== undefined && first !== next) call.conflict = true;
					const value = first ?? next;
					const bound = key === "reasoningOutputTokens" ? merged.core.output : merged.core.input;
					if (value !== undefined && bound !== undefined && value <= bound) merged[key] = value;
					else delete merged[key];
				}
				call.usage = merged;
			}
		},
		snapshot(): AgentTurnUsage {
			const result: AgentTurnUsage = {
				inputTokens: 0,
				outputTokens: 0,
				totalTokens: 0,
				modelCallCount: calls.size,
				countedCallCount: 0,
				status: "unavailable",
			};
			let complete = !gap && calls.size > 0;
			const overflowedDetails = new Set<string>();
			const fields = [
				"inputTokens",
				"outputTokens",
				"totalTokens",
				"cachedInputTokens",
				"cacheCreationInputTokens",
				"reasoningOutputTokens",
			] as const;
			for (const call of calls.values()) {
				if (!call.ended || call.failed || call.conflict || !call.usage?.complete) complete = false;
				if (!call.usage) continue;
				result.countedCallCount++;
				for (const field of fields) {
					const value = call.usage[field];
					if (value === undefined || overflowedDetails.has(field)) continue;
					const sum = (result[field] ?? 0) + value;
					if (Number.isSafeInteger(sum)) result[field] = sum;
					else {
						// Keep the previous safe aggregate as a lower bound on overflow.
						complete = false;
						if (field !== "inputTokens" && field !== "outputTokens" && field !== "totalTokens") {
							delete result[field];
							overflowedDetails.add(field);
						}
					}
				}
			}
			// Core overflow can retain a smaller lower bound than independently
			// summed details. Keep every published subset bounded by that retained core.
			for (const field of [
				"cachedInputTokens",
				"cacheCreationInputTokens",
				"reasoningOutputTokens",
			] as const) {
				const bound = field === "reasoningOutputTokens" ? result.outputTokens : result.inputTokens;
				if (result[field] !== undefined && result[field] > bound) {
					delete result[field];
					complete = false;
				}
			}
			result.status =
				result.countedCallCount === 0 ? "unavailable" : complete ? "complete" : "partial";
			return result;
		},
	};
}
