// @vitest-environment jsdom
// The caption pane's fixed choices are rows of buttons and its word counts are sliders: one
// click each, no list to open. The translation target stays a list — fifteen languages.

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { getCaptionSettings } from "@/lib/ai-edition/captions";
import { type AxcutDocument, createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { useTranscriptionStore } from "@/lib/ai-edition/store/transcriptionStore";
import { CaptionsPane } from "./CaptionsPane";

vi.mock("@/native", () => ({ nativeBridgeClient: { aiEdition: {} } }));
vi.mock("@/native/client", () => ({ nativeBridgeClient: { aiEdition: {} } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function show(legacyEditor: Record<string, unknown> = {}) {
	const base = createEmptyDocument({ title: "T", projectId: "p1" });
	useProjectStore.setState({
		document: { ...base, legacyEditor: { captions: { enabled: true }, ...legacyEditor } },
	});
	render(
		<I18nProvider>
			<CaptionsPane />
		</I18nProvider>,
	);
}

const stored = () => getCaptionSettings(useProjectStore.getState().document as AxcutDocument);

beforeEach(() => {
	useTranscriptionStore.getState().reset();
	useProjectStore.getState().clear();
});

afterEach(() => {
	cleanup();
});

describe("caption choices", () => {
	it("offers the display language only once there is a translation to switch to", () => {
		show();
		expect(screen.queryByRole("group", { name: "Display" })).not.toBeInTheDocument();
		cleanup();

		show({ captionTranslations: { fr: { label: "Français", byAsset: {} } } });
		const row = screen.getByRole("group", { name: "Display" });
		expect(within(row).getByRole("button", { name: "Original (transcript)" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		fireEvent.click(within(row).getByRole("button", { name: "Français" }));
		expect(stored().language).toBe("fr");
	});

	it("shows each font as a specimen of itself and writes the one clicked", () => {
		show();
		const lora = within(screen.getByRole("group", { name: "Font", hidden: true })).getByRole(
			"button",
			{ name: "Lora", hidden: true },
		);
		expect(lora.querySelector("span")).toHaveStyle({ fontFamily: "Lora" });
		fireEvent.click(lora);
		expect(stored().fontFamily).toBe("Lora");
	});

	it("never lets the minimum words per line pass the maximum", () => {
		show({ captions: { enabled: true, minWordsPerLine: 2, maxWordsPerLine: 5 } });
		fireEvent.change(screen.getByRole("slider", { name: "Min words per line" }), {
			target: { value: "9" },
		});
		expect(stored()).toMatchObject({ minWordsPerLine: 5, maxWordsPerLine: 5 });
		fireEvent.change(screen.getByRole("slider", { name: "Max words per line" }), {
			target: { value: "1" },
		});
		expect(stored()).toMatchObject({ minWordsPerLine: 5, maxWordsPerLine: 5 });
	});
});
