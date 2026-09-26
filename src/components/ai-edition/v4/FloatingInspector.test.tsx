// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: (scope: string) => (key: string) => `${scope}.${key}`,
}));

vi.mock("../RightPanes", async (importOriginal) => ({
	AudioPane: () => <div data-testid="audio-pane">AudioPane</div>,
	// The real row: the zoom pane's choices are read and pressed below.
	ChoiceRow: (await importOriginal<typeof import("../RightPanes")>()).ChoiceRow,
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
	// The real switch contract (a button carrying aria-pressed), so the click-impact tests below
	// can find, read and press it.
	Toggle: ({
		checked,
		disabled,
		ariaLabel,
		onChange,
	}: {
		checked: boolean;
		disabled?: boolean;
		ariaLabel?: string;
		onChange: (next: boolean) => void;
	}) => (
		<button
			type="button"
			aria-pressed={checked}
			aria-label={ariaLabel}
			disabled={disabled}
			onClick={() => onChange(!checked)}
		/>
	),
	TranscriptPane: () => <div data-testid="transcript-pane">TranscriptPane</div>,
	VideoEffectsPane: () => <div data-testid="effects-pane">VideoEffectsPane</div>,
}));

const editorSettings = vi.hoisted(() => ({ cursorShow: true, autoFocusAll: false }));
vi.mock("@/lib/ai-edition/store/useEditorSettings", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/ai-edition/store/useEditorSettings")>();
	return {
		useEditorSettings: () => {
			const result = actual.useEditorSettings();
			return {
				...result,
				settings: { ...result.settings, ...editorSettings },
			};
		},
	};
});

vi.mock("../CaptionsPane", () => ({
	CaptionsPane: () => <div data-testid="captions-pane">CaptionsPane</div>,
}));

import { AnnotationSizeField, FloatingInspector } from "./FloatingInspector";

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

	describe("click impact toggle", () => {
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

		const toggle = () => screen.queryByRole("button", { name: "settings.zoom.clickImpact.title" });

		it("is not offered without a 3D preset", () => {
			const { tl } = zoomTl({});
			render(<FloatingInspector {...defaultProps} tl={tl} />);
			expect(toggle()).toBeNull();
		});

		it("is not offered when the region hides the cursor", () => {
			const { tl } = zoomTl({ rotationPreset: "left", hideCursor: true });
			render(<FloatingInspector {...defaultProps} tl={tl} />);
			expect(toggle()).toBeNull();
		});

		it("is not offered when the cursor is hidden globally", () => {
			editorSettings.cursorShow = false;
			try {
				const { tl } = zoomTl({ rotationPreset: "left" });
				render(<FloatingInspector {...defaultProps} tl={tl} />);
				expect(toggle()).toBeNull();
			} finally {
				editorSettings.cursorShow = true;
			}
		});

		it("toggles the region's clickImpact under a 3D preset, off by default", () => {
			const { tl, updateZoomClickImpact } = zoomTl({ rotationPreset: "follow-cursor" });
			render(<FloatingInspector {...defaultProps} tl={tl} />);
			const box = toggle();
			expect(box).toHaveAttribute("aria-pressed", "false");
			fireEvent.click(box as HTMLElement);
			expect(updateZoomClickImpact).toHaveBeenCalledWith("z", true);
		});
	});

	describe("zoom pane rows", () => {
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
		const cameraButtons = () =>
			within(screen.getByRole("group", { name: "settings.zoom.camera.title" })).getAllByRole(
				"button",
			);

		afterEach(() => {
			useProjectStore.setState({ document: null });
		});

		it("is one row, off by default, its label naming the pick the tiles only draw", () => {
			const { tl } = zoomTl({});
			render(<FloatingInspector {...defaultProps} tl={tl} />);
			const off = screen.getByRole("button", { name: "settings.zoom.camera.off" });
			expect(off).toHaveAttribute("aria-pressed", "true");
			expect(screen.getByText("settings.zoom.camera.off")).toBeInTheDocument();
			expect(screen.queryByRole("group", { name: /cameraMotion|threeD/ })).toBeNull();
		});

		it("lists off, then the fixed angles, then the moving camera", () => {
			const { tl } = zoomTl({});
			render(<FloatingInspector {...defaultProps} tl={tl} />);
			expect(cameraButtons().map((b) => b.getAttribute("aria-label"))).toEqual([
				"settings.zoom.camera.off",
				"settings.zoom.camera.preset.left",
				"settings.zoom.camera.preset.right",
				"settings.zoom.camera.preset.followCursor",
			]);
		});

		it("writes the camera into rotationPreset, and off by absence", () => {
			const { tl, updateZoomRotation } = zoomTl({ rotationPreset: "follow-cursor" });
			render(<FloatingInspector {...defaultProps} tl={tl} />);
			expect(
				screen.getByRole("button", { name: "settings.zoom.camera.preset.followCursor" }),
			).toHaveAttribute("aria-pressed", "true");
			fireEvent.click(screen.getByRole("button", { name: "settings.zoom.camera.preset.left" }));
			expect(updateZoomRotation).toHaveBeenCalledWith("z", "left");
			fireEvent.click(screen.getByRole("button", { name: "settings.zoom.camera.off" }));
			expect(updateZoomRotation).toHaveBeenLastCalledWith("z", undefined);
		});

		it("picks the focus mode and the cursor with one click each", () => {
			const updateZoomFocusMode = vi.fn();
			const updateZoomHideCursor = vi.fn();
			const { tl } = zoomTl({});
			render(
				<FloatingInspector
					{...defaultProps}
					tl={{ ...tl, updateZoomFocusMode, updateZoomHideCursor }}
				/>,
			);
			expect(
				screen.getByRole("button", { name: "settings.zoom.focusMode.manual" }),
			).toHaveAttribute("aria-pressed", "true");
			fireEvent.click(screen.getByRole("button", { name: "settings.zoom.focusMode.auto" }));
			expect(updateZoomFocusMode).toHaveBeenCalledWith("z", "auto");
			fireEvent.click(screen.getByRole("button", { name: "settings.zoom.cursor.hide" }));
			expect(updateZoomHideCursor).toHaveBeenCalledWith("z", true);
		});

		it("locks the focus mode on Auto while the timeline's Auto-Focus holds it, and says why", () => {
			editorSettings.autoFocusAll = true;
			try {
				const { tl } = zoomTl({ focusMode: "manual" });
				render(<FloatingInspector {...defaultProps} tl={tl} />);
				const row = screen.getByRole("group", { name: "settings.zoom.focusMode.title" });
				expect(
					within(row).getByRole("button", { name: "settings.zoom.focusMode.auto" }),
				).toHaveAttribute("aria-pressed", "true");
				for (const button of within(row).getAllByRole("button")) expect(button).toBeDisabled();
				expect(row).toHaveAccessibleDescription("settings.zoom.focusMode.lockedDisclaimer");
			} finally {
				editorSettings.autoFocusAll = false;
			}
		});

		it("offers no cursor-driven camera while the cursor is hidden, unless already picked", () => {
			editorSettings.cursorShow = false;
			try {
				const moving = () =>
					screen.queryByRole("button", { name: "settings.zoom.camera.preset.followCursor" });
				const { tl } = zoomTl({});
				const { unmount } = render(<FloatingInspector {...defaultProps} tl={tl} />);
				expect(moving()).toBeNull();
				unmount();
				render(
					<FloatingInspector
						{...defaultProps}
						tl={zoomTl({ rotationPreset: "follow-cursor" }).tl}
					/>,
				);
				expect(moving()).not.toBeNull();
			} finally {
				editorSettings.cursorShow = true;
			}
		});
	});
});

describe("AnnotationSizeField", () => {
	const commitTyped = (typed: string) => {
		const onCommit = vi.fn();
		const view = render(<AnnotationSizeField label="Size" size={32} onCommit={onCommit} />);
		const field = view.getByRole("textbox", { name: "Size" });
		fireEvent.change(field, { target: { value: typed } });
		fireEvent.blur(field);
		view.unmount();
		return onCommit;
	};

	it("keeps the size when the field is emptied or unreadable, instead of writing 0", () => {
		expect(commitTyped("")).not.toHaveBeenCalled();
		expect(commitTyped("big")).not.toHaveBeenCalled();
	});

	it("commits a typed size when the field unmounts before its blur", () => {
		const onCommit = vi.fn();
		const view = render(<AnnotationSizeField label="Size" size={32} onCommit={onCommit} />);
		fireEvent.change(view.getByRole("textbox", { name: "Size" }), { target: { value: "64" } });
		view.unmount();
		expect(onCommit).toHaveBeenCalledWith(64);
	});

	it("commits a typed size read into its bound", () => {
		expect(commitTyped("0")).toHaveBeenCalledWith(8);
		expect(commitTyped("48")).toHaveBeenCalledWith(48);
		expect(commitTyped("900")).toHaveBeenCalledWith(200);
	});
});
