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
const show = (usage?: AgentTurnUsage, durationMs?: number, running = false) =>
	render(
		<I18nProvider>
			<TooltipProvider>
				<ChatUsageSummary usage={usage} durationMs={durationMs} running={running} />
			</TooltipProvider>
		</I18nProvider>,
	);
describe("ChatUsageSummary", () => {
	it("shows a concise total with accounting details in the tooltip", () => {
		const view = show(complete);
		expect(view.getByText("660 tokens")).toHaveAttribute(
			"aria-label",
			expect.stringContaining("Input: 500"),
		);
		expect(view.getByText("660 tokens")).toHaveAttribute(
			"aria-label",
			expect.stringContaining("3 of 3 model calls counted"),
		);
	});
	it("keeps partial accounting details in the tooltip", () => {
		const view = show(
			{ ...complete, totalTokens: 12340, countedCallCount: 2, status: "partial" },
			45000,
		);
		expect(view.getByText("12.3k tokens · 45s")).toHaveAttribute(
			"aria-label",
			expect.stringContaining("12.3k known tokens · incomplete"),
		);
		expect(view.container.textContent).not.toMatch(/known|incomplete/);
	});
	it("does not turn unavailable usage into zero", () => {
		const view = show({ ...complete, totalTokens: 0, countedCallCount: 0, status: "unavailable" });
		expect(view.container).toBeEmptyDOMElement();
		expect(view.queryByText(/0 tokens/)).toBeNull();
	});
	it("keeps legacy messages quiet", () => {
		expect(show().container).toBeEmptyDOMElement();
	});
	it("shows explicitly reported zero", () => {
		expect(
			show({ ...complete, inputTokens: 0, outputTokens: 0, totalTokens: 0 }).getByText("0 tokens"),
		).toBeInTheDocument();
	});
	it("labels optional details as reported counts and omits missing details", () => {
		const view = show({ ...complete, cachedInputTokens: 0, reasoningOutputTokens: 12 });
		const label = view.getByText("660 tokens").getAttribute("aria-label");
		expect(label).toContain("Reported cached input: 0");
		expect(label).toContain("Reported reasoning output: 12");
		expect(label).not.toContain("cache creation");
	});
	it("formats counts for the selected locale", () => {
		localStorage.setItem("openscreen-locale", "de");
		const view = show({ ...complete, totalTokens: 12340 });
		expect(view.getByText(/12,3k/)).toBeInTheDocument();
		localStorage.clear();
	});
	it("shows compact totals and elapsed time, with no visible breakdown or model-call count", () => {
		const view = show({ ...complete, totalTokens: 12340 }, 45000);
		expect(view.getByText("12.3k tokens · 45s")).toBeInTheDocument();
		expect(view.container.textContent).not.toMatch(/Input:|Output:|model calls/);
	});
	it("keeps elapsed time on unavailable usage without claiming zero tokens", () => {
		const view = show(
			{ ...complete, status: "unavailable", countedCallCount: 0, totalTokens: 0 },
			1200,
		);
		expect(view.getByText("1s")).toHaveAttribute(
			"aria-label",
			expect.stringContaining("Token usage unavailable"),
		);
		expect(view.container.textContent).toBe("1s");
	});
	it("shows reported running counts as a lower bound and hides unavailable running usage", () => {
		const view = show(complete, undefined, true);
		expect(view.getByText("≥660 tokens")).toBeInTheDocument();
		view.unmount();
		expect(
			show({ ...complete, status: "unavailable" }, undefined, true).container,
		).toBeEmptyDOMElement();
	});
});
