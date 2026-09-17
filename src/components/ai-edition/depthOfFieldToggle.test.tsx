// @vitest-environment jsdom
// The depth-of-field switch only moves something on a 3D-tilted zoom. Without one it must be
// disabled and say why; with one it must write the project setting the compositor reads.

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { VideoEffectsPane } from "./RightPanes";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

function documentWithZoom(rotationPreset?: "iso"): AxcutDocument {
	const base = createEmptyDocument({ title: "T", projectId: "p1" });
	return {
		...base,
		zoomRanges: [
			{
				id: "z1",
				startMs: 0,
				endMs: 2000,
				depth: 3,
				focus: { cx: 0.5, cy: 0.5 },
				...(rotationPreset ? { rotationPreset } : {}),
			},
		],
	} as unknown as AxcutDocument;
}

function mount(doc: AxcutDocument) {
	useProjectStore.setState({ document: doc });
	render(
		<I18nProvider>
			<VideoEffectsPane />
		</I18nProvider>,
	);
	return screen.getByRole("button", { name: "Depth of field" });
}

const stored = () =>
	(useProjectStore.getState().document?.legacyEditor as Record<string, unknown> | undefined)
		?.depthOfField;

beforeEach(() => {
	localStorage.clear();
	useProjectStore.setState({ document: null });
});
afterEach(() => {
	cleanup();
	localStorage.clear();
});

describe("depth of field toggle", () => {
	it("is disabled and says why when no zoom is tilted", () => {
		const toggle = mount(documentWithZoom());
		expect(toggle).toBeDisabled();
		expect(screen.getByText("No 3D zoom in this project")).toBeInTheDocument();
	});

	it("is on by default with a tilted zoom, and turns off then on again", async () => {
		const toggle = mount(documentWithZoom("iso"));
		expect(toggle).toBeEnabled();
		expect(toggle).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByText("3D zooms")).toBeInTheDocument();

		fireEvent.click(toggle);
		await waitFor(() => expect(stored()).toBe(false));
		await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "false"));

		fireEvent.click(toggle);
		await waitFor(() => expect(stored()).toBe(true));
	});
});
