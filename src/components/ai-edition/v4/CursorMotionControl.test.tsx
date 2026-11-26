// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CursorMotionMode } from "@/lib/ai-edition/schema";

// Driven directly, like SpeedControl: the pane needs a project and a selected section. The
// translator echoes keys so the assertions read against keys, not copy.
vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string, vars?: Record<string, unknown>) =>
		vars ? `${key}:${Object.values(vars).join(",")}` : key,
}));

import { CursorMotionControl } from "./FloatingInspector";

function renderControl(mode: CursorMotionMode) {
	const tl = {
		updateCursorMotionSettings: vi.fn(async () => undefined),
		updateCursorMotionLive: vi.fn(),
		commitCursorMotionChange: vi.fn(async () => undefined),
	};
	render(<CursorMotionControl region={{ id: "m1", mode }} tl={tl} />);
	return tl;
}

describe("CursorMotionControl", () => {
	it("offers the strength only for a smooth section", () => {
		renderControl("smooth");
		expect(screen.getByText("cursorMotion.strength")).toBeInTheDocument();
		expect(screen.queryByText("cursorMotion.easing")).not.toBeInTheDocument();
		expect(screen.getByText("cursorMotion.descriptions.smooth")).toBeInTheDocument();
	});

	it("offers the speed curve only for a straight section", () => {
		renderControl("straight");
		expect(screen.getByText("cursorMotion.easing")).toBeInTheDocument();
		expect(screen.queryByText("cursorMotion.strength")).not.toBeInTheDocument();
	});

	it("shows neither parameter for a frozen or recorded section", () => {
		for (const mode of ["freeze", "recorded"] as const) {
			const { unmount } = render(
				<CursorMotionControl
					region={{ id: "m1", mode }}
					tl={{
						updateCursorMotionSettings: vi.fn(),
						updateCursorMotionLive: vi.fn(),
						commitCursorMotionChange: vi.fn(),
					}}
				/>,
			);
			expect(screen.queryByText("cursorMotion.strength")).not.toBeInTheDocument();
			expect(screen.queryByText("cursorMotion.easing")).not.toBeInTheDocument();
			unmount();
		}
	});

	it("writes the picked mode", () => {
		const tl = renderControl("smooth");
		fireEvent.click(screen.getByRole("button", { name: "cursorMotion.modes.freeze" }));
		expect(tl.updateCursorMotionSettings).toHaveBeenCalledWith("m1", { mode: "freeze" });
	});
});
