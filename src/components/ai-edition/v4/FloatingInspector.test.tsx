// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";

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

const editorSettings = vi.hoisted(() => ({ cursorShow: true }));
vi.mock("@/lib/ai-edition/store/useEditorSettings", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/ai-edition/store/useEditorSettings")>();
	return {
		useEditorSettings: () => {
			const result = actual.useEditorSettings();
			return {
				...result,
				settings: { ...result.settings, cursorShow: editorSettings.cursorShow },
			};
		},
	};
});

vi.mock("../CaptionsPane", () => ({
	CaptionsPane: () => <div data-testid="captions-pane">CaptionsPane</div>,
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

	describe("click impact checkbox", () => {
		const zoomTl = (region: Record<string, unknown>) => {
			const updateZoomClickImpact = vi.fn();
			const tl = {
				...defaultProps.tl,
				selection: { kind: "zoom", id: "z" },
				zoomRegions: [
					{ id: "z", startMs: 0, endMs: 1000, depth: 3, focus: { cx: 0.5, cy: 0.5 }, ...region },
				],
				updateZoomClickImpact,
			} as unknown as React.ComponentProps<typeof FloatingInspector>["tl"];
			return { tl, updateZoomClickImpact };
		};

		it("is off by default and disabled with its reason when there is no 3D preset", () => {
			const { tl } = zoomTl({});
			render(<FloatingInspector {...defaultProps} tl={tl} />);
			const box = screen.getByRole("checkbox", { name: "settings.zoom.clickImpact.title" });
			expect(box).not.toBeChecked();
			expect(box).toBeDisabled();
			expect(screen.getByText("settings.zoom.clickImpact.needsRotation")).toBeInTheDocument();
		});

		it("is disabled with its reason when the region hides the cursor", () => {
			const { tl } = zoomTl({ rotationPreset: "iso", hideCursor: true });
			render(<FloatingInspector {...defaultProps} tl={tl} />);
			expect(
				screen.getByRole("checkbox", { name: "settings.zoom.clickImpact.title" }),
			).toBeDisabled();
			expect(screen.getByText("settings.zoom.clickImpact.needsCursor")).toBeInTheDocument();
		});

		it("says the orbiting camera recoils on a click, since its screen stays still", () => {
			const { tl, updateZoomClickImpact } = zoomTl({ rotationPreset: "follow-cursor" });
			render(<FloatingInspector {...defaultProps} tl={tl} />);
			const box = screen.getByRole("checkbox", { name: "settings.zoom.clickImpact.title" });
			expect(box).toBeEnabled();
			expect(screen.getByText("settings.zoom.clickImpact.descriptionCamera")).toBeInTheDocument();
			fireEvent.click(box);
			expect(updateZoomClickImpact).toHaveBeenCalledWith("z", true);
		});

		it("is disabled with its reason when the cursor is hidden globally", () => {
			editorSettings.cursorShow = false;
			try {
				const { tl } = zoomTl({ rotationPreset: "iso" });
				render(<FloatingInspector {...defaultProps} tl={tl} />);
				expect(
					screen.getByRole("checkbox", { name: "settings.zoom.clickImpact.title" }),
				).toBeDisabled();
				expect(screen.getByText("settings.zoom.clickImpact.needsCursor")).toBeInTheDocument();
			} finally {
				editorSettings.cursorShow = true;
			}
		});

		it("toggles the region's clickImpact under a 3D preset", () => {
			const { tl, updateZoomClickImpact } = zoomTl({ rotationPreset: "iso" });
			render(<FloatingInspector {...defaultProps} tl={tl} />);
			const box = screen.getByRole("checkbox", { name: "settings.zoom.clickImpact.title" });
			expect(box).toBeEnabled();
			expect(screen.getByText("settings.zoom.clickImpact.description")).toBeInTheDocument();
			fireEvent.click(box);
			expect(updateZoomClickImpact).toHaveBeenCalledWith("z", true);
		});
	});

	describe("3D camera select", () => {
		const zoomTl = (region: Record<string, unknown>) => {
			const updateZoomRotation = vi.fn();
			const tl = {
				...defaultProps.tl,
				selection: { kind: "zoom", id: "z" },
				zoomRegions: [
					{ id: "z", startMs: 0, endMs: 1000, depth: 3, focus: { cx: 0.5, cy: 0.5 }, ...region },
				],
				updateZoomRotation,
			} as unknown as React.ComponentProps<typeof FloatingInspector>["tl"];
			return { tl, updateZoomRotation };
		};

		afterEach(() => {
			useProjectStore.setState({ document: null });
		});

		it("is the only 3D select, off by default, and says what off does", () => {
			const { tl } = zoomTl({});
			render(<FloatingInspector {...defaultProps} tl={tl} />);
			const select = screen.getByRole("combobox", { name: "settings.zoom.camera.title" });
			expect(select).toHaveValue("off");
			expect(screen.getByText("settings.zoom.camera.description.off")).toBeInTheDocument();
			expect(screen.queryByRole("combobox", { name: /cameraMotion|threeD/ })).toBeNull();
		});

		it("groups the fixed angles apart from the moving cameras", () => {
			const { tl } = zoomTl({});
			render(<FloatingInspector {...defaultProps} tl={tl} />);
			const select = screen.getByRole("combobox", { name: "settings.zoom.camera.title" });
			const groups = [...select.querySelectorAll("optgroup")].map((g) => [
				g.label,
				[...g.querySelectorAll("option")].map((o) => o.value),
			]);
			expect(groups).toEqual([
				["settings.zoom.camera.fixed", ["iso", "left", "right"]],
				["settings.zoom.camera.moving", ["follow-cursor"]],
			]);
		});

		it("writes the camera into rotationPreset, and off by absence", () => {
			const { tl, updateZoomRotation } = zoomTl({ rotationPreset: "follow-cursor" });
			render(<FloatingInspector {...defaultProps} tl={tl} />);
			const select = screen.getByRole("combobox", { name: "settings.zoom.camera.title" });
			expect(select).toHaveValue("follow-cursor");
			expect(screen.getByText("settings.zoom.camera.description.followCursor")).toBeInTheDocument();
			fireEvent.change(select, { target: { value: "iso" } });
			expect(updateZoomRotation).toHaveBeenCalledWith("z", "iso");
			fireEvent.change(select, { target: { value: "off" } });
			expect(updateZoomRotation).toHaveBeenLastCalledWith("z", undefined);
		});

		it("says a cursor-driven camera has nothing to follow while the cursor is hidden", () => {
			editorSettings.cursorShow = false;
			try {
				const { tl } = zoomTl({ rotationPreset: "follow-cursor" });
				render(<FloatingInspector {...defaultProps} tl={tl} />);
				expect(screen.getByText("settings.zoom.camera.needsCursor")).toBeInTheDocument();
			} finally {
				editorSettings.cursorShow = true;
			}
		});
	});
});
