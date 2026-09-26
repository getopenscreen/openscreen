// @vitest-environment jsdom
// The background picker offers the curated set first. The free choice sits behind one "Custom"
// swatch per tab, and on the gradient tab that choice is ONE colour, turned into a two-stop
// gradient the compositor draws exactly as the swatch shows it.

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { LOCALE_STORAGE_KEY } from "@/i18n/config";
import { parseCssGradient } from "@/lib/exporter/gradientParser";
import { WallpaperPicker } from "./RightPanes";

beforeAll(() => {
	// The Radix popover measures its anchor; jsdom has no ResizeObserver.
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe = () => undefined;
			unobserve = () => undefined;
			disconnect = () => undefined;
		},
	);
});

beforeEach(() => {
	localStorage.clear();
	localStorage.setItem(LOCALE_STORAGE_KEY, "en");
});

afterEach(() => {
	cleanup();
	localStorage.clear();
});

function renderPicker(value: string) {
	const onChange = vi.fn();
	const onLiveChange = vi.fn();
	const onCommit = vi.fn();
	render(
		<I18nProvider>
			<WallpaperPicker
				value={value}
				hasDocument
				onChange={onChange}
				onLiveChange={onLiveChange}
				onCommit={onCommit}
				onPickFile={() => undefined}
				updateNativeBackground={false}
			/>
		</I18nProvider>,
	);
	return { onChange, onLiveChange, onCommit };
}

/** True when `a` comes before `b` in the document. */
function precedes(a: Element, b: Element): boolean {
	return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

describe("gradient tab", () => {
	const current = "linear-gradient(135deg, #3b82f6, #8b5cf6)";

	it("shows the curated gradients before the custom one", () => {
		renderPicker(current);
		const custom = screen.getByRole("button", { name: "Gradient from one color" });
		const presets = screen.getAllByRole("button", { name: /^Gradient \d+$/ });
		expect(presets.length).toBeGreaterThan(0);
		for (const preset of presets) expect(precedes(preset, custom)).toBe(true);
	});

	it("turns one picked colour into a two-stop gradient", () => {
		const { onLiveChange, onCommit } = renderPicker(current);
		fireEvent.click(screen.getByRole("button", { name: "Gradient from one color" }));
		fireEvent.click(screen.getByRole("button", { name: /#ec4899/ }));

		const written = onLiveChange.mock.calls.at(-1)?.[0] as string;
		const stops = parseCssGradient(written)?.stops.map((s) => s.color);
		expect(stops).toHaveLength(2);
		expect(stops?.[0]).toBe("#ec4899");
		expect(onCommit).toHaveBeenCalled();
	});
});

describe("color tab", () => {
	it("shows the palette before the custom colour, and writes what is picked there", () => {
		const { onLiveChange } = renderPicker("#16171d");
		const custom = screen.getByRole("button", { name: "Custom color" });
		for (const swatch of screen.getAllByRole("button", { name: /^Color #/ })) {
			expect(precedes(swatch, custom)).toBe(true);
		}
		fireEvent.click(custom);
		fireEvent.click(screen.getByRole("button", { name: /#0ea5e9/ }));
		expect(onLiveChange).toHaveBeenLastCalledWith("#0ea5e9");
	});
});
