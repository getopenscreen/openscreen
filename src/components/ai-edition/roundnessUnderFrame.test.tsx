// @vitest-environment jsdom
// Under a frame the Roundness slider spans 0 → the most that frame wears well (the native
// `frame_roundness_cap`), so it reads in percent of that range and says so; without a frame it
// stays in pixels. The stored value is pixels either way — the compositor reads its position.

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { VideoEffectsPane } from "./RightPanes";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

function mount(legacy: Record<string, unknown>) {
	const base = createEmptyDocument({ title: "T", projectId: "p1" });
	useProjectStore.setState({ document: { ...base, legacyEditor: legacy } as AxcutDocument });
	render(
		<I18nProvider>
			<VideoEffectsPane />
		</I18nProvider>,
	);
	return screen.getByRole("slider", { name: "Roundness" });
}

/** The slider's own cell: its label and value sit next to it, not elsewhere in the pane. */
const cellOf = (slider: HTMLElement) => slider.parentElement as HTMLElement;

const storedRadius = () =>
	(useProjectStore.getState().document?.legacyEditor as Record<string, unknown> | undefined)
		?.borderRadius;

beforeEach(() => {
	localStorage.clear();
	useProjectStore.setState({ document: null });
});
afterEach(() => {
	cleanup();
	localStorage.clear();
});

describe("Roundness under a frame", () => {
	it("stays in pixels without a frame", () => {
		const slider = mount({ borderRadius: 32 });
		expect(slider).toHaveAttribute("max", "64");
		expect(slider).toHaveValue("32");
		expect(within(cellOf(slider)).getByText("32px")).toBeInTheDocument();
		expect(slider).not.toHaveAttribute("title");
	});

	it("reads as a share of the frame's range, says so, and stores pixels", async () => {
		const slider = mount({ borderRadius: 32, frame: "laptop" });
		expect(slider).toHaveAttribute("max", "100");
		expect(slider).toHaveValue("50");
		expect(within(cellOf(slider)).getByText("50%")).toBeInTheDocument();
		expect(slider).toHaveAttribute(
			"title",
			"The range adapts to the frame: 100% is its roundest good look.",
		);

		fireEvent.change(slider, { target: { value: "100" } });
		fireEvent.mouseUp(slider);
		await waitFor(() => expect(storedRadius()).toBe(64));
	});
});
