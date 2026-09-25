// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SliderCell } from "./RightPanes";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => key,
}));

describe("SliderCell", () => {
	it("computes and sets --slider-pct gauge property correctly", () => {
		render(
			<SliderCell
				label="Volume"
				value={25}
				min={0}
				max={100}
				onChange={vi.fn()}
				onCommit={vi.fn()}
			/>,
		);
		const slider = screen.getByRole("slider", { name: "Volume" });
		expect(slider.style.getPropertyValue("--slider-pct")).toBe("25%");
	});

	it("clamps --slider-pct to 0% and 100% at boundaries", () => {
		const { rerender } = render(
			<SliderCell
				label="Opacity"
				value={-10}
				min={0}
				max={50}
				onChange={vi.fn()}
				onCommit={vi.fn()}
			/>,
		);
		const slider = screen.getByRole("slider", { name: "Opacity" });
		expect(slider.style.getPropertyValue("--slider-pct")).toBe("0%");

		rerender(
			<SliderCell
				label="Opacity"
				value={60}
				min={0}
				max={50}
				onChange={vi.fn()}
				onCommit={vi.fn()}
			/>,
		);
		expect(slider.style.getPropertyValue("--slider-pct")).toBe("100%");
	});

	it("applies full layout class when full prop is true", () => {
		const { container } = render(
			<SliderCell
				full
				label="Webcam size"
				value={20}
				min={10}
				max={50}
				onChange={vi.fn()}
				onCommit={vi.fn()}
			/>,
		);
		const cell = container.firstElementChild;
		expect(cell?.className).toContain("full");
	});

	it("offers a reset once the value has left its default, and resets on it or a double-click", () => {
		const onChange = vi.fn();
		const onCommit = vi.fn();
		const props = { label: "Shadow", min: 0, max: 100, suffix: "%", onChange, onCommit };
		const { rerender } = render(<SliderCell {...props} value={20} defaultValue={20} />);
		expect(screen.queryByRole("button", { name: /resetToDefault/ })).toBeNull();

		rerender(<SliderCell {...props} value={65} defaultValue={20} />);
		fireEvent.click(screen.getByRole("button", { name: "actions.resetToDefault: Shadow" }));
		expect(onChange).toHaveBeenLastCalledWith(20);
		expect(onCommit).toHaveBeenCalledTimes(1);

		fireEvent.doubleClick(screen.getByRole("slider", { name: "Shadow" }));
		expect(onCommit).toHaveBeenCalledTimes(2);
	});

	it("shows a number only when it has a unit", () => {
		const props = { min: 10, max: 30, onChange: vi.fn(), onCommit: vi.fn() };
		const { rerender } = render(<SliderCell {...props} label="Size" value={30} />);
		expect(screen.queryByText("30")).toBeNull();
		rerender(<SliderCell {...props} label="Size" value={30} suffix="%" />);
		expect(screen.getByText("30%")).toBeInTheDocument();
	});
});
