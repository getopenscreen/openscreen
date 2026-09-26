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
