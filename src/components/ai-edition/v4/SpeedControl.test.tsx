// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The pane is only reachable with a project open and a speed region selected, so drive the
// control directly. Both collaborators are stubbed: the translator echoes keys (assertions read
// better against a key than against prose that changes with copy edits), and `sonner` records the
// error toast without needing a mounted <Toaster>.
vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string, vars?: Record<string, unknown>) =>
		vars ? `${key}:${Object.values(vars).join(",")}` : key,
}));

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (message: string) => toastError(message) } }));

import { SpeedControl } from "./FloatingInspector";

function renderControl(speed: number) {
	const updateSpeedValue = vi.fn(async () => {
		// the control only awaits the promise, never its value
	});
	render(<SpeedControl region={{ id: "sp1", speed }} tl={{ updateSpeedValue }} />);
	const field = screen.getByPlaceholderText(`${speed}×`);
	return { updateSpeedValue, field };
}

describe("SpeedControl", () => {
	beforeEach(() => {
		toastError.mockClear();
	});

	it("commits a free-typed speed above the preset ceiling", () => {
		// The regression this control exists for: the V4 shell only offered presets up to 3×,
		// while the underlying capability reaches 100×.
		const { updateSpeedValue, field } = renderControl(1);
		fireEvent.change(field, { target: { value: "25" } });
		fireEvent.blur(field);
		expect(updateSpeedValue).toHaveBeenCalledWith("sp1", 25);
	});

	it("commits on Enter as well as on blur, and only once", () => {
		const { updateSpeedValue, field } = renderControl(1);
		fireEvent.change(field, { target: { value: "7.5" } });
		fireEvent.keyDown(field, { key: "Enter" });
		fireEvent.blur(field);
		expect(updateSpeedValue).toHaveBeenCalledTimes(1);
		expect(updateSpeedValue).toHaveBeenCalledWith("sp1", 7.5);
	});

	it("refuses a speed past the maximum and says so", () => {
		const { updateSpeedValue, field } = renderControl(1);
		fireEvent.change(field, { target: { value: "500" } });
		fireEvent.blur(field);
		expect(updateSpeedValue).not.toHaveBeenCalled();
		expect(toastError).toHaveBeenCalledWith("speed.maxSpeedError:100");
	});

	it("ignores an unparseable draft without touching the region", () => {
		const { updateSpeedValue, field } = renderControl(2);
		fireEvent.change(field, { target: { value: "abc" } });
		fireEvent.blur(field);
		expect(updateSpeedValue).not.toHaveBeenCalled();
		expect(toastError).not.toHaveBeenCalled();
	});

	it("clears the draft after a commit so the placeholder tracks the live speed", () => {
		const { field } = renderControl(1);
		fireEvent.change(field, { target: { value: "4" } });
		fireEvent.blur(field);
		expect(field).toHaveValue("");
	});

	it("picks a preset in one click, and leaves the current one alone", () => {
		const { updateSpeedValue } = renderControl(1);
		expect(screen.getByRole("button", { name: "1×" })).toHaveAttribute("aria-pressed", "true");
		fireEvent.click(screen.getByRole("button", { name: "2×" }));
		expect(updateSpeedValue).toHaveBeenCalledWith("sp1", 2);
		// Re-pressing the current speed is not an edit: no save, no undo entry.
		updateSpeedValue.mockClear();
		fireEvent.click(screen.getByRole("button", { name: "1×" }));
		expect(updateSpeedValue).not.toHaveBeenCalled();
	});

	it("does not misreport a custom speed as a preset", () => {
		// 25× matches no preset: no button may claim it, and the field reads it back instead.
		renderControl(25);
		for (const button of screen.getAllByRole("button")) {
			expect(button).toHaveAttribute("aria-pressed", "false");
		}
		expect(screen.getByPlaceholderText("25×")).toBeInTheDocument();
	});
});
