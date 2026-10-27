import { z } from "zod";

const identity = { id: z.string().min(1).max(100), startedAt: z.number().finite().nonnegative() };
export const executionStepSchema = z.discriminatedUnion("kind", [
	z.object({ ...identity, kind: z.literal("reasoning"), text: z.string().max(32768) }),
	z.object({
		...identity,
		kind: z.literal("tool"),
		name: z.string().max(100),
		arguments: z.string().max(1000),
		status: z.enum(["running", "succeeded", "failed", "stopped"]),
		durationMs: z.number().finite().nonnegative().optional(),
		summary: z.string().max(1000).optional(),
	}),
]);
export type ChatExecutionStep = z.infer<typeof executionStepSchema>;
export type ToolExecutionStep = Extract<ChatExecutionStep, { kind: "tool" }>;

/** Update by invocation identity, retaining observed order even when calls finish out of order. */
export function updateExecutionStep(steps: ChatExecutionStep[], step: ChatExecutionStep) {
	const index = steps.findIndex((entry) => entry.id === step.id);
	return index < 0 ? [...steps, step] : steps.map((entry, i) => (i === index ? step : entry));
}

/** A process restart cannot leave a persisted tool pretending to still run. */
export function restoredExecutionSteps(steps?: ChatExecutionStep[]) {
	return steps?.map(
		(step): ChatExecutionStep =>
			step.kind === "tool" && step.status === "running" ? { ...step, status: "stopped" } : step,
	);
}
