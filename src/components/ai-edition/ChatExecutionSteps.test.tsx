// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatExecutionStep } from "@/lib/ai-edition/chatExecution";
import { ChatExecutionSteps } from "./ChatExecutionSteps";

vi.mock("@/contexts/I18nContext", () => ({ useScopedT: () => (key: string) => key }));
afterEach(cleanup);
it("renders ordered collapsed details, failures and separate provider reasoning", () => {
	const steps: ChatExecutionStep[] = [
		{ id: "r", startedAt: 0, kind: "reasoning", text: "**Inspect** the clip" },
		{
			id: "a",
			startedAt: 1,
			kind: "tool",
			name: "getTranscript",
			arguments: "assetId: a",
			status: "running",
		},
		{
			id: "b",
			startedAt: 2,
			kind: "tool",
			name: "getTranscript",
			arguments: "assetId: b",
			status: "failed",
			summary: "No transcript",
			durationMs: 240,
		},
	];
	const view = render(<ChatExecutionSteps steps={steps} />);
	expect(view.container.querySelectorAll("details")).toHaveLength(3);
	expect(view.container.querySelector("details[open]")).toBeNull();
	expect(screen.getByText(/chat.stepStatus.failed/)).toHaveTextContent("0.2s");
	view.rerender(
		<ChatExecutionSteps
			steps={steps.map((step) => (step.id === "a" ? { ...step, status: "succeeded" } : step))}
		/>,
	);
	expect(view.container.querySelectorAll("details")).toHaveLength(3);
	expect(screen.getByText(/chat.stepStatus.succeeded/)).toBeInTheDocument();
});
