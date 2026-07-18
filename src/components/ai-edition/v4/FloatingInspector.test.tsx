import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FloatingInspector } from "./FloatingInspector";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => key,
}));

vi.mock("@/lib/ai-edition/store/useEditorSettings", () => ({
	useEditorSettings: () => ({ settings: { autoFocusAll: false } }),
}));

describe("FloatingInspector zoom Auto-Focus", () => {
	afterEach(cleanup);

	it("switches the selected zoom between manual and cursor-follow modes", () => {
		const updateZoomFocusMode = vi.fn();
		const tl = {
			selection: { kind: "zoom", id: "zoom_1" },
			zoomRegions: [
				{
					id: "zoom_1",
					startMs: 1000,
					endMs: 3000,
					depth: 3,
					focus: { cx: 0.5, cy: 0.5 },
					focusMode: "manual",
				},
			],
			updateZoomFocusMode,
			clearSelection: vi.fn(),
		};

		render(
			<FloatingInspector
				facet="effects"
				open
				onFacetChange={vi.fn()}
				onToggleOpen={vi.fn()}
				clips={[]}
				onEditClip={vi.fn()}
				onCaptions={vi.fn()}
				transcriptProps={{} as never}
				tl={tl as never}
			/>,
		);

		fireEvent.change(screen.getByLabelText("zoom.focusMode.title"), {
			target: { value: "auto" },
		});
		expect(updateZoomFocusMode).toHaveBeenCalledWith("zoom_1", "auto");
	});
});
