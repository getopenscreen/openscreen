import { randomUUID } from "node:crypto";
import {
	type ChatExecutionStep,
	type ToolExecutionStep,
	updateExecutionStep,
} from "../../src/lib/ai-edition/chatExecution";

/** Keep display metadata bounded; raw provider payloads and tool results never enter the sidecar. */
export function executionText(value: string, limit = 1000): string {
	return value
		.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
		.replace(/\b(?:sk-|gh[pousr]_)[A-Za-z0-9_-]{8,}/g, "[redacted]")
		.replace(
			/\b(?:api[_-]?key|authorization|password|secret|token)\s*[=:]\s*[^\s,;]+/gi,
			"[redacted]",
		)
		.slice(0, limit);
}

export function toolExecutionStep(name: string, args: unknown): ToolExecutionStep {
	const summaries: string[] = [];
	if (args && typeof args === "object") {
		// Describe location and scale, not arbitrary text, headers, paths or credentials.
		for (const [key, value] of Object.entries(args)) {
			if (/api.?key|authorization|password|secret|token/i.test(key)) continue;
			if (Array.isArray(value)) summaries.push(`${key}: ${value.length}`);
			else if (typeof value === "number" || typeof value === "boolean")
				summaries.push(`${key}: ${value}`);
			else if (["assetId", "clipId", "id"].includes(key) && typeof value === "string")
				summaries.push(`${key}: ${value}`);
		}
	}
	return {
		id: randomUUID(),
		kind: "tool",
		name: executionText(name, 100),
		arguments: executionText(summaries.join(", ")),
		status: "running",
		startedAt: Date.now(),
	};
}

export function createExecutionTracker(emit: (step: ChatExecutionStep) => void) {
	let steps: ChatExecutionStep[] = [];
	let reasoningId: string | undefined;
	const update = (step: ChatExecutionStep) => {
		steps = updateExecutionStep(steps, step);
		emit(step);
	};
	return {
		tool(step: ToolExecutionStep) {
			reasoningId = undefined;
			update(step);
		},
		thinking(delta: string) {
			const previous = steps.find((step) => step.id === reasoningId);
			const text = previous?.kind === "reasoning" ? previous.text : "";
			const step: ChatExecutionStep = {
				id: reasoningId ?? randomUUID(),
				kind: "reasoning",
				startedAt: previous?.startedAt ?? Date.now(),
				text: executionText(text + delta, 32768),
			};
			reasoningId = step.id;
			update(step);
		},
		finish(stopped: boolean) {
			for (const step of steps) {
				if (step.kind === "tool" && step.status === "running")
					update({
						...step,
						status: stopped ? "stopped" : "failed",
						durationMs: Math.max(0, Date.now() - step.startedAt),
					});
			}
			return steps;
		},
		snapshot: () => steps,
	};
}

export function executionSummary(result: {
	ok: boolean;
	summary?: string;
	resultJson: string;
}): string {
	if (result.summary) return executionText(result.summary);
	try {
		const data: unknown = JSON.parse(result.resultJson);
		if (data && typeof data === "object") {
			if (!result.ok && "error" in data && typeof data.error === "string")
				return executionText(data.error);
			const counts = Object.entries(data)
				.filter(
					([key, value]) =>
						/^[a-zA-Z][a-zA-Z0-9]*$/.test(key) &&
						!/api.?key|authorization|password|secret|token/i.test(key) &&
						(Array.isArray(value) || typeof value === "number" || typeof value === "boolean"),
				)
				.slice(0, 8)
				.map(([key, value]) => `${key}: ${Array.isArray(value) ? value.length : value}`);
			return executionText(counts.join(", "));
		}
	} catch {
		/* Raw tool results are intentionally never displayed or persisted. */
	}
	return "";
}

/** Reconcile announced calls with executor verdicts, including calls rejected before execution. */
export function createToolExecutionObserver(emit: (step: ToolExecutionStep) => void) {
	const calls = new Map<string, ToolExecutionStep>();
	const begin = (callId: string, name: string, args: unknown) => {
		const existing = calls.get(callId);
		if (existing) return existing;
		const step = toolExecutionStep(name, args);
		calls.set(callId, step);
		emit(step);
		return step;
	};
	return {
		reset() {
			calls.clear();
		},
		begin,
		publish(step: ToolExecutionStep) {
			const previous = calls.get(step.id) ?? begin(step.id, step.name, {});
			const next = {
				...step,
				id: previous.id,
				startedAt: previous.startedAt,
				arguments: step.arguments || previous.arguments,
			};
			calls.set(step.id, next);
			emit(next);
		},
		result(callId: string, content: string) {
			const previous = calls.get(callId);
			if (!previous || previous.status !== "running") return;
			const step: ToolExecutionStep = {
				...previous,
				status: "failed",
				summary: executionText(content),
				durationMs: Math.max(0, Date.now() - previous.startedAt),
			};
			calls.set(callId, step);
			emit(step);
		},
	};
}
