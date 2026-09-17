// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: (scope: string) => (key: string) => `${scope}.${key}`,
}));

vi.mock("../RightPanes", () => ({
	AudioPane: () => <div data-testid="audio-pane">AudioPane</div>,
	AudioTrackPane: ({ onClose }: { onClose?: () => void }) => (
		<div data-testid="audio-track-pane">
			AudioTrackPane
			{onClose ? (
				<button type="button" aria-label="common.actions.close" onClick={onClose}>
					close
				</button>
			) : null}
		</div>
	),
	CursorPane: () => <div data-testid="cursor-pane">CursorPane</div>,
	LayoutPane: () => <div data-testid="layout-pane">LayoutPane</div>,
	SliderCell: () => <div data-testid="slider-cell">SliderCell</div>,
	Toggle: () => <div data-testid="toggle">Toggle</div>,
	TranscriptPane: () => <div data-testid="transcript-pane">TranscriptPane</div>,
	VideoEffectsPane: () => <div data-testid="effects-pane">VideoEffectsPane</div>,
}));

vi.mock("../CaptionsPane", () => ({
	CaptionsPane: () => <div data-testid="captions-pane">CaptionsPane</div>,
}));

// `SelectionPane` is local to the component under test, so the selection path renders it
// for real and it reads the editor settings. Stubbed to the one field it consults here,
// rather than standing up the project store to assert an attribute on a wrapper.
vi.mock("@/lib/ai-edition/store/useEditorSettings", () => ({
	useEditorSettings: () => ({
		settings: { autoFocusAll: false },
		set: vi.fn(),
		setLive: vi.fn(),
		commit: vi.fn(),
		hasDocument: false,
	}),
}));

import { FloatingInspector } from "./FloatingInspector";

describe("FloatingInspector", () => {
	const defaultProps: React.ComponentProps<typeof FloatingInspector> = {
		facet: "layout" as const,
		open: true,
		onFacetChange: vi.fn(),
		onToggleOpen: vi.fn(),
		clips: [],
		onEditClip: vi.fn(),
		transcriptProps: {} as unknown as React.ComponentProps<
			typeof FloatingInspector
		>["transcriptProps"],
		tl: {
			selection: null,
			clearSelection: vi.fn(),
			selectedAudioTrackId: null,
			selectAudioTrack: vi.fn(),
		} as unknown as React.ComponentProps<typeof FloatingInspector>["tl"],
	};

	it("renders layout facet button on rail with camera icon and settings.layout.title", () => {
		render(<FloatingInspector {...defaultProps} />);
		const layoutBtn = screen.getByRole("button", { name: "settings.layout.title" });
		expect(layoutBtn).toBeInTheDocument();
		// lucide Camera icon renders an svg with class lucide-camera
		const svg = layoutBtn.querySelector("svg");
		expect(svg?.classList.contains("lucide-camera")).toBe(true);
	});

	it("renders collapse button with editor.inspector.collapseInspector and collapses inspector when clicked", () => {
		const onToggleOpen = vi.fn();
		render(<FloatingInspector {...defaultProps} facet="audio" onToggleOpen={onToggleOpen} />);
		const collapseBtn = screen.getByRole("button", { name: "editor.inspector.collapseInspector" });
		expect(collapseBtn).toBeInTheDocument();
		const svg = collapseBtn.querySelector("svg");
		expect(svg?.classList.contains("lucide-chevron-right")).toBe(true);

		fireEvent.click(collapseBtn);
		expect(onToggleOpen).toHaveBeenCalledTimes(1);
	});

	// `data-open` is not decoration: it is what joins the rail to the panel and gives the
	// pair one height. Closed, the rail has to go back to being a pill of its own size, or
	// an empty rail stretches the height of the stage. So the attribute carries the whole
	// of that switch and each way of turning it on is worth pinning.
	const wrap = () => document.querySelector('[class*="inspectorWrap"]');

	it("leaves data-open off while nothing is open or selected", () => {
		render(<FloatingInspector {...defaultProps} open={false} />);
		expect(wrap()).not.toHaveAttribute("data-open");
	});

	it("sets data-open when the panel is open", () => {
		render(<FloatingInspector {...defaultProps} open />);
		expect(wrap()).toHaveAttribute("data-open", "true");
	});

	it("sets data-open on a selection, even with the panel collapsed", () => {
		// No matching region, so `SelectionPane` renders null. That is the point: the
		// attribute answers to `selection !== null`, not to what the pane makes of it.
		const tl = {
			...defaultProps.tl,
			selection: { kind: "annotation", id: "ann_1" },
			annotationRegions: [],
		} as unknown as React.ComponentProps<typeof FloatingInspector>["tl"];
		render(<FloatingInspector {...defaultProps} open={false} tl={tl} />);
		expect(wrap()).toHaveAttribute("data-open", "true");
	});

	it("sets data-open on a selected audio track, even with the panel collapsed", () => {
		const tl = {
			...defaultProps.tl,
			selectedAudioTrackId: "audio-1",
		} as unknown as React.ComponentProps<typeof FloatingInspector>["tl"];
		render(<FloatingInspector {...defaultProps} open={false} tl={tl} />);
		expect(wrap()).toHaveAttribute("data-open", "true");
	});

	// The rail stays where it is while the panel opens and closes, so the facet that is
	// already active is still under the pointer and a second click on it closes the panel.
	it("closes the panel when the active facet is clicked again", () => {
		const onToggleOpen = vi.fn();
		const onFacetChange = vi.fn();
		render(
			<FloatingInspector
				{...defaultProps}
				facet="layout"
				open
				onToggleOpen={onToggleOpen}
				onFacetChange={onFacetChange}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "settings.layout.title" }));
		expect(onToggleOpen).toHaveBeenCalledTimes(1);
		expect(onFacetChange).not.toHaveBeenCalled();
	});

	// On screen the panel opens to the rail's start side, but in the DOM the rail comes
	// first: press a facet, and the next Tab is in the controls it opened rather than
	// behind the rest of the rail.
	it("keeps the rail ahead of the panel in the DOM", () => {
		render(<FloatingInspector {...defaultProps} facet="layout" open />);
		const facetButton = screen.getByRole("button", { name: "settings.layout.title" });
		const pane = screen.getByTestId("layout-pane");
		expect(
			facetButton.compareDocumentPosition(pane) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("renders close button on AudioTrackPane when audio track is selected and deselects on click", () => {
		const clearSelection = vi.fn();
		const tl = {
			...defaultProps.tl,
			selectedAudioTrackId: "audio-1",
			clearSelection,
		};
		render(<FloatingInspector {...defaultProps} tl={tl} />);
		expect(screen.getByTestId("audio-track-pane")).toBeInTheDocument();
		const closeBtn = screen.getByRole("button", { name: "common.actions.close" });
		fireEvent.click(closeBtn);
		expect(clearSelection).toHaveBeenCalledTimes(1);
	});
});

// Where the rail lands is CSS that jsdom does not lay out, and the failure it guards
// against is silent: anchor the wrap by the wrong edge, or lay it out in DOM order, and
// the rail jumps a panel's width every time the panel opens, so a second click on the
// active facet lands inside the panel instead of closing it. What can be pinned is the
// contract that keeps it still.
describe("inspector rail placement contract", () => {
	const css = readFileSync(path.resolve(__dirname, "EditorShellV4.module.css"), "utf8");
	const block = (selector: string) => {
		const start = css.indexOf(`${selector} {`);
		expect(start, `${selector} rule`).toBeGreaterThanOrEqual(0);
		return css.slice(start, css.indexOf("}", start));
	};
	// Comments mention properties by name; only declarations count.
	const declarations = (selector: string) => block(selector).replace(/\/\*[\s\S]*?\*\//g, "");

	it("anchors the wrap by its inline end and lays the rail out at that end", () => {
		const wrap = declarations(".inspectorWrap");
		expect(wrap).toMatch(/inset-inline-end:\s*20px/);
		expect(wrap).toMatch(/flex-direction:\s*row-reverse/);
		// A physical anchor would stay on the right under dir="rtl".
		expect(wrap).not.toMatch(/(^|\s)(right|left):/);
	});

	// The seam faces the panel, which is on the rail's start side in either direction.
	it("joins the rail and the panel on the rail's start side, in logical terms", () => {
		const rail = declarations(".inspectorWrap[data-open] .facetRail");
		expect(rail).toMatch(/border-inline-start:\s*0/);
		expect(rail).toMatch(/border-start-start-radius:\s*0/);
		expect(rail).toMatch(/border-end-start-radius:\s*0/);
		const panel = declarations(".inspectorWrap[data-open] .inspector");
		expect(panel).toMatch(/border-start-end-radius:\s*0/);
		expect(panel).toMatch(/border-end-end-radius:\s*0/);
	});
});
