// @vitest-environment jsdom
// Arrow keys step over holes and disabled options in the direction of travel, so an enabled
// option past them stays reachable from the keyboard.

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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
});

// A tooltip that says what the button already says is noise (tooltips.md, rule 3). A button with
// no visible label is the one that needs it: it is named for a screen reader and for the mouse.
describe("ChoiceRow tooltips", () => {
	const icon = <svg aria-hidden="true" />;

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
		for (const name of ["Alpha", "Beta"]) {
			expect(screen.getByRole("button", { name })).not.toHaveAttribute("title");
		}
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
		expect(screen.getByRole("button", { name: "Alpha" })).toHaveAttribute("title", "Alpha");
		expect(screen.getByRole("button", { name: "Beta" })).toHaveAttribute("title", "Beta");
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
		expect(screen.getByRole("button", { name: "Alpha" })).not.toHaveAttribute("title");
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
		expect(screen.getByRole("button", { name: "Lora" })).not.toHaveAttribute("title");
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
		expect(screen.getByRole("button", { name: "Alpha" })).toHaveAttribute(
			"title",
			"Alpha · 2 clips",
		);
		expect(screen.getByRole("button", { name: "Beta" })).not.toHaveAttribute("title");
	});
});
