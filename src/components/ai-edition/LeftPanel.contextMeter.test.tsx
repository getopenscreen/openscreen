// @vitest-environment jsdom
// The chat strip's context meter: the number it prints, the bar it draws, and the
// warning it raises once the conversation nears its (estimated) ceiling. The warning is
// a colour change plus a glyph for sighted users, and the glyph is aria-hidden, so the
// words a screen reader gets in its place are pinned here alongside the rest.

import "@testing-library/jest-dom";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatBudget } from "./chatBudget";
import { ContextMeter } from "./LeftPanel";

// Echoes the key, plus the percentage when one is passed, so assertions read against
// keys rather than against copy that moves with every revision.
function t(key: string, vars?: Record<string, string | number>): string {
	return vars && "percent" in vars ? `${key}:${vars.percent}` : key;
}

function budget(ratio: number): ChatBudget {
	return { usedTokens: Math.round(ratio * 80_000), budgetTokens: 80_000, ratio };
}

function renderMeter(ratio: number) {
	const { container } = render(<ContextMeter budget={budget(ratio)} t={t} />);
	const meter = container.firstElementChild as HTMLElement;
	const fill = meter.querySelector<HTMLElement>("[aria-hidden] > span");
	return { meter, fill };
}

afterEach(cleanup);

describe("ContextMeter", () => {
	it("rounds the ratio to a whole percentage, in the label and the bar alike", () => {
		const { meter, fill } = renderMeter(0.426);
		expect(meter).toHaveTextContent("chat.contextPercent:43");
		expect(fill).toHaveStyle({ width: "43%" });
	});

	it("caps at 100% when the estimate runs past the ceiling", () => {
		const { meter, fill } = renderMeter(1.37);
		expect(meter).toHaveTextContent("chat.contextPercent:100");
		expect(fill).toHaveStyle({ width: "100%" });
	});

	it("stays out of the warning state just below the threshold", () => {
		const { meter } = renderMeter(0.799);
		expect(meter).toHaveAttribute("data-tight", "false");
		expect(meter.querySelector("svg")).toBeNull();
		expect(meter).not.toHaveTextContent("chat.contextTight");
	});

	it("warns from the threshold on, with a glyph and with words a screen reader gets", () => {
		const { meter } = renderMeter(0.8);
		expect(meter).toHaveAttribute("data-tight", "true");
		expect(meter.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
		// The glyph is hidden from assistive tech, so the state has to arrive as text,
		// and before the number it qualifies.
		expect(meter).toHaveTextContent(/^chat\.contextTight\s*chat\.contextPercent:80$/);
	});
});
