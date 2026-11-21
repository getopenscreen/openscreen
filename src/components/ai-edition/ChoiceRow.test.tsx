// @vitest-environment jsdom
// Arrow keys step over holes and disabled options in the direction of travel, so an enabled
// option past them stays reachable from the keyboard.

import "@testing-library/jest-dom";
import { DirectionProvider } from "@radix-ui/react-direction";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

import { ChoiceRow } from "./RightPanes";

describe("ChoiceRow keyboard", () => {
	it("skips disabled options and holes, both ways, and stops at the ends", () => {
		const onChange = vi.fn();
		render(
			<ChoiceRow<number>
				label="row"
				value={1}
				onChange={onChange}
				options={[
					{ value: 1, label: "one" },
					{ value: 2, label: "two", disabled: true },
					null,
					{ value: 3, label: "three", disabled: true },
					{ value: 4, label: "four" },
				]}
			/>,
		);
		const group = screen.getByRole("group", { name: "row" });
		fireEvent.keyDown(group, { key: "ArrowRight" });
		expect(onChange).toHaveBeenLastCalledWith(4);
		expect(screen.getByRole("button", { name: "four" })).toHaveFocus();

		// The row is not re-rendered with 4 here, so going back to 1 is a re-press: focus only.
		fireEvent.keyDown(group, { key: "ArrowLeft" });
		expect(screen.getByRole("button", { name: "one" })).toHaveFocus();

		// Nothing enabled before the first option: stay put.
		onChange.mockClear();
		fireEvent.keyDown(group, { key: "ArrowLeft" });
		expect(onChange).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "one" })).toHaveFocus();
	});

	it.each([
		{ dir: undefined, nextKey: "ArrowLeft" },
		{ dir: "ltr" as const, nextKey: "ArrowRight" },
	])("navigates a row in an RTL page with dir=$dir", ({ dir, nextKey }) => {
		const onChange = vi.fn();
		render(
			<DirectionProvider dir="rtl">
				<ChoiceRow
					dir={dir}
					label="row"
					value={1}
					onChange={onChange}
					options={[
						{ value: 1, label: "one" },
						{ value: 2, label: "two" },
					]}
				/>
			</DirectionProvider>,
		);
		fireEvent.keyDown(screen.getByRole("group", { name: "row" }), { key: nextKey });
		expect(onChange).toHaveBeenLastCalledWith(2);
		expect(screen.getByRole("button", { name: "two" })).toHaveFocus();
	});
});

// A tooltip that says what the button already says is noise (tooltips.md, rule 3). A button with
// no visible label is the one that needs it: it is named for a screen reader and for the mouse.
// Always the shared `Tooltip`, never the browser's `title`, which looks and waits unlike every
// other tooltip in the editor (#1016).
describe("ChoiceRow tooltips", () => {
	const icon = <svg aria-hidden="true" />;

	// jsdom has none, and a Radix tooltip measures its trigger when it opens.
	beforeEach(() => {
		vi.stubGlobal(
			"ResizeObserver",
			class {
				observe = () => undefined;
				unobserve = () => undefined;
				disconnect = () => undefined;
			},
		);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	/** What a keyboard focus on the option shows, or null when it opens no tooltip. */
	function tooltipOf(name: string) {
		const button = screen.getByRole("button", { name });
		expect(button).not.toHaveAttribute("title");
		// A keyboard focus: one the mouse gave opens no tooltip.
		fireEvent.keyDown(window, { key: "Tab" });
		act(() => button.focus());
		// Radix copies the text into a visually hidden `role="tooltip"` node, read by assistive
		// technology: the one copy that holds nothing else.
		const shown = screen.queryByRole("tooltip")?.textContent ?? null;
		if (shown !== null) expect(button).toHaveAccessibleDescription(shown);
		act(() => button.blur());
		return shown;
	}

	it("draws no tooltip on an option whose label is visible", () => {
		render(
			<ChoiceRow<string>
				label="row"
				value="a"
				onChange={vi.fn()}
				options={[
					{ value: "a", label: "Alpha" },
					{ value: "b", label: "Beta" },
				]}
			/>,
		);
		for (const name of ["Alpha", "Beta"]) expect(tooltipOf(name)).toBeNull();
	});

	it("names an icon-only option in its tooltip", () => {
		render(
			<ChoiceRow<string>
				label="row"
				value="a"
				onChange={vi.fn()}
				options={[
					{ value: "a", label: "Alpha", icon },
					{ value: "b", label: "Beta", icon },
				]}
			/>,
		);
		expect(tooltipOf("Alpha")).toBe("Alpha");
		expect(tooltipOf("Beta")).toBe("Beta");
	});

	it("draws no tooltip on an option that shows its icon and its label", () => {
		render(
			<ChoiceRow<string>
				label="row"
				display="both"
				value="a"
				onChange={vi.fn()}
				options={[{ value: "a", label: "Alpha", icon }]}
			/>,
		);
		expect(tooltipOf("Alpha")).toBeNull();
	});

	it("draws none on an icon that already spells the label, when the caller says so", () => {
		render(
			<ChoiceRow<string>
				label="row"
				value="a"
				onChange={vi.fn()}
				options={[{ value: "a", label: "Lora", icon: <span>Lora</span>, title: null }]}
			/>,
		);
		expect(tooltipOf("Lora")).toBeNull();
	});

	it("keeps the tooltip a caller passes, even beside a visible label", () => {
		render(
			<ChoiceRow<string>
				label="row"
				value="a"
				onChange={vi.fn()}
				options={[
					{ value: "a", label: "Alpha", title: "Alpha · 2 clips" },
					{ value: "b", label: "Beta" },
				]}
			/>,
		);
		expect(tooltipOf("Alpha")).toBe("Alpha · 2 clips");
		expect(tooltipOf("Beta")).toBeNull();
	});
});
