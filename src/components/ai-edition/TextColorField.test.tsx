// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { TextColorField } from "./TextColorField";

afterEach(cleanup);

function renderOn(plate: string, onChange = vi.fn()) {
	render(
		<I18nProvider>
			<TextColorField label="Text colour" value="#ffffff" plate={plate} onChange={onChange} />
		</I18nProvider>,
	);
	return onChange;
}

const swatch = (color: string) => screen.queryByTitle(color);

describe("TextColorField", () => {
	it("offers only the palette colours that read on a dark plate", () => {
		renderOn("rgba(0, 0, 0, 0.7)");
		expect(swatch("#ffffff")).toBeInTheDocument();
		expect(swatch("#111111")).not.toBeInTheDocument();
	});

	it("offers the whole palette when there is no plate", () => {
		renderOn("transparent");
		expect(swatch("#ffffff")).toBeInTheDocument();
		expect(swatch("#111111")).toBeInTheDocument();
	});

	it("applies a swatch on click", () => {
		const onChange = renderOn("rgba(255, 255, 255, 0.85)");
		fireEvent.click(swatch("#1d4ed8") as HTMLElement);
		expect(onChange).toHaveBeenCalledWith("#1d4ed8");
	});
});
