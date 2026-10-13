// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { I18nProvider } from "@/contexts/I18nContext";
import type { AgentTurnUsage } from "@/native/contracts";
import { ChatUsageSummary } from "./ChatUsageSummary";

afterEach(cleanup);
const complete: AgentTurnUsage = {
	inputTokens: 500,
	outputTokens: 160,
	totalTokens: 660,
	modelCallCount: 3,
	countedCallCount: 3,
	status: "complete",
};
const show = (usage?: AgentTurnUsage) =>
	render(
		<I18nProvider>
			<TooltipProvider>
				<ChatUsageSummary usage={usage} />
			</TooltipProvider>
		</I18nProvider>,
	);
describe("ChatUsageSummary", () => {
	it("shows totals and model calls with accessible accounting details", () => {
		const view = show(complete);
		expect(view.getByText("660 tokens · 3 model calls")).toHaveAttribute(
			"aria-label",
			expect.stringContaining("Input: 500"),
		);
		expect(view.getByText("660 tokens · 3 model calls")).toHaveAttribute(
			"aria-label",
			expect.stringContaining("3 of 3 model calls counted"),
		);
	});
	it("marks partial totals as incomplete", () => {
		expect(
			show({ ...complete, totalTokens: 440, countedCallCount: 2, status: "partial" }).getByText(
				"440 known tokens · incomplete",
			),
		).toBeInTheDocument();
	});
	it("does not turn unavailable usage into zero", () => {
		const view = show({ ...complete, totalTokens: 0, countedCallCount: 0, status: "unavailable" });
		expect(view.getByText("Token usage unavailable")).toBeInTheDocument();
		expect(view.queryByText(/0 tokens/)).toBeNull();
	});
	it("keeps legacy messages quiet", () => {
		expect(show().container).toBeEmptyDOMElement();
	});
	it("shows explicitly reported zero", () => {
		expect(
			show({ ...complete, inputTokens: 0, outputTokens: 0, totalTokens: 0 }).getByText(
				"0 tokens · 3 model calls",
			),
		).toBeInTheDocument();
	});
	it("labels optional details as reported counts and omits missing details", () => {
		const view = show({ ...complete, cachedInputTokens: 0, reasoningOutputTokens: 12 });
		const label = view.getByText("660 tokens · 3 model calls").getAttribute("aria-label");
		expect(label).toContain("Reported cached input: 0");
		expect(label).toContain("Reported reasoning output: 12");
		expect(label).not.toContain("cache creation");
	});
	it("formats counts for the selected locale", () => {
		localStorage.setItem("openscreen-locale", "de");
		const view = show({ ...complete, totalTokens: 1234 });
		expect(view.getByText(/1.234/)).toBeInTheDocument();
		localStorage.clear();
	});
});
