// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
	act,
	fireEvent,
	type RenderOptions,
	render as renderWithoutTooltips,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { assetSchema, clipSchema, createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { nativeBridgeClient } from "@/native";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: (scope: string) => (key: string) => `${scope}.${key}`,
}));

vi.mock("../RightPanes", async (importOriginal) => ({
	AudioPane: () => <div data-testid="audio-pane">AudioPane</div>,
	// The real row: the zoom pane's choices are read and pressed below.
	ChoiceRow: (await importOriginal<typeof import("../RightPanes")>()).ChoiceRow,
	Toggle: (await importOriginal<typeof import("../RightPanes")>()).Toggle,
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

import styles from "./EditorShellV4.module.css";
import { AnnotationSizeControl, AnnotationSizeField, FloatingInspector } from "./FloatingInspector";

// The rail's buttons have tooltips, and the app's root provides the provider they need.
function render(ui: ReactElement, options?: Omit<RenderOptions, "wrapper">) {
	return renderWithoutTooltips(ui, { wrapper: TooltipProvider, ...options });
}

class StubResizeObserver {
	observe = vi.fn();
	unobserve = vi.fn();
	disconnect = vi.fn();
}

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

	// The rail is icon-only. The name is the pane's title (which is also its heading), and the tip
	// says what the pane holds: a second key, because the title cannot carry the list.
	describe("rail tooltips", () => {
		beforeEach(() => {
			vi.stubGlobal("ResizeObserver", StubResizeObserver);
		});
		afterEach(() => {
			vi.unstubAllGlobals();
		});

		async function tooltipOf(name: string) {
			const button = screen.getByRole("button", { name });
			// A keyboard focus: one the mouse gave opens no tooltip.
			fireEvent.keyDown(window, { key: "Tab" });
			act(() => button.focus());
			await screen.findByRole("tooltip");
			const visible = document.querySelector<HTMLElement>('[data-slot="tooltip-content"]');
			const text = screen.getByRole("tooltip").textContent;
			const side = visible?.getAttribute("data-side");
			act(() => button.blur());
			await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
			return { text, side, hasChip: Boolean(visible?.querySelector("kbd")) };
		}

		const oneClip = [
			clipSchema.parse({
				id: "c1",
				assetId: "a1",
				sourceStartSec: 0,
				sourceEndSec: 10,
				timelineStartSec: 0,
				timelineEndSec: 10,
				origin: "user",
			}),
		];

		it("says what each facet holds, on the side that does not cover the next button", async () => {
			render(<FloatingInspector {...defaultProps} clips={oneClip} />);

			const names: Array<[string, string]> = [
				["settings.effects.title", "settings.facets.tips.effects"],
				["settings.layout.title", "settings.facets.tips.layout"],
				["settings.audio.title", "settings.facets.tips.audio"],
				["settings.facets.transcript", "settings.facets.tips.transcript"],
				["editor.editClipDialog.title", "editor.inspector.editClipTip"],
			];
			for (const [name, tip] of names) {
				const opened = await tooltipOf(name);
				expect(opened.text).toBe(tip);
				expect(opened.side).toBe("left");
				expect(opened.hasChip).toBe(false);
			}
		});

		it("uses no native title on any rail button", () => {
			render(<FloatingInspector {...defaultProps} clips={oneClip} />);
			const rail = screen.getByRole("button", { name: "settings.layout.title" }).parentElement;
			const buttons = Array.from(rail?.querySelectorAll("button") ?? []);
			expect(buttons.length).toBeGreaterThanOrEqual(5);
			for (const button of buttons) expect(button).not.toHaveAttribute("title");
		});

		it("names a rail button on hover, and Escape closes it", async () => {
			render(<FloatingInspector {...defaultProps} clips={oneClip} />);
			fireEvent.pointerMove(screen.getByRole("button", { name: "settings.audio.title" }));
			expect((await screen.findByRole("tooltip")).textContent).toBe("settings.facets.tips.audio");

			fireEvent.keyDown(document.body, { key: "Escape" });
			await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
		});

		// Issue #1016: the focus comes back to the clicked button when the window is switched back
		// to, and its tooltip opened then, over the panel and the next buttons, until a blur.
		it("leaves no tooltip on a clicked rail button when the focus comes back to it", () => {
			render(<FloatingInspector {...defaultProps} clips={oneClip} />);
			const audio = screen.getByRole("button", { name: "settings.audio.title" });
			fireEvent.pointerDown(audio);
			fireEvent.mouseDown(audio);
			act(() => audio.focus());
			fireEvent.pointerUp(audio);
			fireEvent.mouseUp(audio);
			fireEvent.click(audio);
			act(() => {
				audio.blur();
				audio.focus();
			});
			expect(audio).toHaveFocus();
			expect(screen.queryByRole("tooltip")).toBeNull();
		});
	});

	// Issue #1006: drawn inside the stage, the list was clipped by the stage's edge and its last
	// rows sat under the timeline, where no click reached them.
	describe("clip picker", () => {
		beforeEach(() => {
			vi.stubGlobal("ResizeObserver", StubResizeObserver);
		});
		afterEach(() => {
			vi.unstubAllGlobals();
		});

		const threeClips = [0, 1, 2].map((i) =>
			clipSchema.parse({
				id: `c${i}`,
				assetId: "a1",
				sourceStartSec: i * 10,
				sourceEndSec: i * 10 + 10,
				timelineStartSec: i * 10,
				timelineEndSec: i * 10 + 10,
				origin: "user",
			}),
		);
		const editClip = () => screen.getByRole("button", { name: "editor.editClipDialog.title" });

		it("opens outside the stage, and every row opens its clip", () => {
			const onEditClip = vi.fn();
			const { container } = render(
				<FloatingInspector {...defaultProps} clips={threeClips} onEditClip={onEditClip} />,
			);
			fireEvent.click(editClip());
			const menu = screen.getByRole("menu", { name: "editor.editClipDialog.pickClipTitle" });
			expect(container).not.toContainElement(menu);
			expect(editClip()).toHaveAttribute("aria-expanded", "true");

			const rows = within(menu).getAllByRole("menuitem");
			expect(rows).toHaveLength(3);
			fireEvent.click(rows[2]);
			expect(onEditClip).toHaveBeenCalledWith(threeClips[2]);
			expect(screen.queryByRole("menu")).toBeNull();
		});

		it("closes on Escape without opening a clip", async () => {
			const onEditClip = vi.fn();
			render(<FloatingInspector {...defaultProps} clips={threeClips} onEditClip={onEditClip} />);
			fireEvent.click(editClip());
			fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
			await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
			expect(onEditClip).not.toHaveBeenCalled();
		});

		it("opens the only clip at once, with no menu", () => {
			const onEditClip = vi.fn();
			render(
				<FloatingInspector
					{...defaultProps}
					clips={threeClips.slice(0, 1)}
					onEditClip={onEditClip}
				/>,
			);
			expect(editClip()).not.toHaveAttribute("aria-haspopup");
			fireEvent.click(editClip());
			expect(onEditClip).toHaveBeenCalledWith(threeClips[0]);
			expect(screen.queryByRole("menu")).toBeNull();
		});
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

	describe("annotation pane", () => {
		const text = {
			id: "a",
			startMs: 0,
			endMs: 1000,
			type: "text",
			content: "Hi",
			space: "frame",
			position: { x: 45, y: 45 },
			size: { width: 10, height: 10 },
			style: {
				color: "#ffffff",
				backgroundColor: "transparent",
				fontSize: 32,
				fontFamily: "Inter",
				fontWeight: "bold",
				fontStyle: "normal",
				textDecoration: "none",
				textAlign: "center",
			},
			zIndex: 1,
		};
		const annotationTl = () => {
			const updateAnnotationLive = vi.fn();
			const tl = {
				...defaultProps.tl,
				selection: { kind: "annotation", id: "a" },
				annotationRegions: [text],
				updateAnnotationLive,
				commitAnnotationChange: vi.fn(),
			} as unknown as React.ComponentProps<typeof FloatingInspector>["tl"];
			return { tl, updateAnnotationLive };
		};
		const centreOf = (patch: { position: { x: number }; size: { width: number } }) =>
			patch.position.x + patch.size.width / 2;

		it("refits the box to the words as they are typed, around the same centre", () => {
			const { tl, updateAnnotationLive } = annotationTl();
			render(<FloatingInspector {...defaultProps} tl={tl} />);
			fireEvent.change(screen.getByPlaceholderText("settings.annotation.textPlaceholder"), {
				target: { value: "A much longer line" },
			});
			const patch = updateAnnotationLive.mock.calls[0][1];
			expect(patch.content).toBe("A much longer line");
			expect(patch.size.width).toBeGreaterThan(text.size.width);
			expect(centreOf(patch)).toBeCloseTo(50, 6);
		});

		it("resizes the text from the preset row and refits its box", () => {
			const { tl, updateAnnotationLive } = annotationTl();
			render(<FloatingInspector {...defaultProps} tl={tl} />);
			const row = screen.getByRole("group", { name: "settings.annotation.size" });
			fireEvent.click(within(row).getByRole("button", { name: "72" }));
			const patch = updateAnnotationLive.mock.calls[0][1];
			expect(patch.style.fontSize).toBe(72);
			expect(centreOf(patch)).toBeCloseTo(50, 6);
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

		it("lists off, then the orbit, then the fixed angles", () => {
			const { tl } = zoomTl({});
			render(<FloatingInspector {...defaultProps} tl={tl} />);
			expect(cameraButtons().map((b) => b.getAttribute("aria-label"))).toEqual([
				"settings.zoom.camera.off",
				"settings.zoom.camera.preset.orbit",
				"settings.zoom.camera.preset.left",
				"settings.zoom.camera.preset.right",
			]);
		});

		it("writes the camera into rotationPreset, and off by absence", () => {
			const { tl, updateZoomRotation } = zoomTl({ rotationPreset: "orbit" });
			render(<FloatingInspector {...defaultProps} tl={tl} />);
			expect(
				screen.getByRole("button", { name: "settings.zoom.camera.preset.orbit" }),
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

		it("offers the orbit with the cursor hidden only where the focus point poses it, or once picked", () => {
			editorSettings.cursorShow = false;
			const offered = (region: Record<string, unknown>) => {
				const { unmount } = render(<FloatingInspector {...defaultProps} tl={zoomTl(region).tl} />);
				const orbit = screen.queryByRole("button", { name: "settings.zoom.camera.preset.orbit" });
				unmount();
				return orbit !== null;
			};
			try {
				expect(offered({ focusMode: "auto" })).toBe(false);
				expect(offered({ focusMode: "manual" })).toBe(true);
				expect(offered({})).toBe(true);
				expect(offered({ focusMode: "auto", rotationPreset: "orbit" })).toBe(true);
				// The timeline's Auto-Focus makes every zoom auto, whatever it stores.
				editorSettings.autoFocusAll = true;
				expect(offered({ focusMode: "manual" })).toBe(false);
			} finally {
				editorSettings.cursorShow = true;
				editorSettings.autoFocusAll = false;
			}
		});
	});

	describe("cursor facet", () => {
		const cursorFacet = () => screen.queryByRole("button", { name: "settings.cursor.title" });

		/** A read that has not answered yet, and the way to let it answer. */
		function pendingRead() {
			let open: (() => void) | undefined;
			const gate = new Promise<void>((resolve) => {
				open = resolve;
			});
			return {
				gate,
				release: () =>
					act(async () => {
						open?.();
						await gate;
					}),
			};
		}

		/**
		 * One clip per recording. A recording is the number of samples its cursor file holds, or a
		 * gate its read waits on before finding three.
		 */
		function openProject(...takes: Array<number | Promise<void>>) {
			// A path per test: every recording is read once per session.
			const run = crypto.randomUUID();
			const takeOf = new Map<string, number | Promise<void>>();
			const assets = takes.map((take, i) => {
				const originalPath = `/recordings/${run}-${i}.mp4`;
				takeOf.set(originalPath, take);
				return assetSchema.parse({ id: `a${i}`, label: "take", originalPath });
			});
			const clips = assets.map((asset, i) =>
				clipSchema.parse({
					id: `c${i}`,
					assetId: asset.id,
					sourceStartSec: 0,
					sourceEndSec: 10,
					timelineStartSec: i * 10,
					timelineEndSec: i * 10 + 10,
					origin: "user",
				}),
			);
			const read = vi
				.spyOn(nativeBridgeClient.cursor, "getRecordingData")
				.mockImplementation(async (videoPath) => {
					const take = takeOf.get(videoPath ?? "") ?? 0;
					if (typeof take !== "number") await take;
					return {
						version: 2,
						provider: "native",
						assets: [],
						samples: Array.from({ length: typeof take === "number" ? take : 3 }, (_, i) => ({
							timeMs: i * 100,
							cx: 0.5,
							cy: 0.5,
						})),
					};
				});
			const document = createEmptyDocument({ projectId: "p", title: "t" });
			useProjectStore.setState({
				projectId: "p",
				document: { ...document, assets, timeline: { ...document.timeline, clips } },
			});
			return read;
		}

		/** Lets the recordings' cursor files be read, so an absence is an answer and not a wait. */
		async function readAll(read: ReturnType<typeof openProject>) {
			await waitFor(() => expect(read).toHaveBeenCalled());
			await act(async () => {
				await Promise.all(read.mock.results.map((r) => r.value));
			});
		}

		afterEach(() => {
			vi.restoreAllMocks();
			useProjectStore.setState({ document: null });
		});

		it("is offered when a recording on the timeline has cursor data", async () => {
			openProject(3);
			render(<FloatingInspector {...defaultProps} />);
			expect(await screen.findByRole("button", { name: "settings.cursor.title" })).toBeVisible();
		});

		// A system-cursor take has the cursor baked into its pixels and no cursor file.
		it("is left out for a take with no cursor data", async () => {
			const read = openProject(0);
			render(<FloatingInspector {...defaultProps} />);
			await readAll(read);
			expect(cursorFacet()).toBeNull();
			expect(screen.getByRole("button", { name: "settings.layout.title" })).toBeVisible();
		});

		it("is offered as soon as one of several recordings has cursor data", async () => {
			openProject(0, 2);
			render(<FloatingInspector {...defaultProps} />);
			expect(await screen.findByRole("button", { name: "settings.cursor.title" })).toBeVisible();
		});

		// The first read to find data settles it: the others cannot take the answer back.
		it("is offered before the other recordings have been read", async () => {
			const slow = pendingRead();
			openProject(3, slow.gate);
			render(<FloatingInspector {...defaultProps} />);
			expect(await screen.findByRole("button", { name: "settings.cursor.title" })).toBeVisible();
			await slow.release();
		});

		// The previous recording's answer says nothing about a recording swapped in for it.
		it("is not carried over to a recording that has not been read yet", async () => {
			openProject(3);
			render(<FloatingInspector {...defaultProps} />);
			expect(await screen.findByRole("button", { name: "settings.cursor.title" })).toBeVisible();
			const slow = pendingRead();
			act(() => void openProject(slow.gate));
			await waitFor(() => expect(cursorFacet()).toBeNull());
			await slow.release();
			expect(await screen.findByRole("button", { name: "settings.cursor.title" })).toBeVisible();
		});

		it("is left out with nothing on the timeline", async () => {
			render(<FloatingInspector {...defaultProps} />);
			await act(() => Promise.resolve());
			expect(cursorFacet()).toBeNull();
		});

		it("falls back to the first facet when the chosen one is left out", async () => {
			const read = openProject(0);
			render(<FloatingInspector {...defaultProps} facet="cursor" />);
			await readAll(read);
			expect(screen.getByTestId("effects-pane")).toBeInTheDocument();
			expect(screen.queryByTestId("cursor-pane")).toBeNull();
			expect(screen.getByRole("button", { name: "settings.effects.title" })).toHaveAttribute(
				"aria-pressed",
				"true",
			);
		});

		it("shows the cursor pane once the chosen facet has data", async () => {
			openProject(3);
			render(<FloatingInspector {...defaultProps} facet="cursor" />);
			expect(await screen.findByTestId("cursor-pane")).toBeInTheDocument();
			expect(cursorFacet()).toHaveAttribute("aria-pressed", "true");
		});

		it("says what the cursor facet holds, once it is offered", async () => {
			vi.stubGlobal("ResizeObserver", StubResizeObserver);
			openProject(3);
			render(<FloatingInspector {...defaultProps} />);
			const facet = await screen.findByRole("button", { name: "settings.cursor.title" });
			// A keyboard focus: one the mouse gave opens no tooltip.
			fireEvent.keyDown(window, { key: "Tab" });
			act(() => facet.focus());
			expect((await screen.findByRole("tooltip")).textContent).toBe("settings.facets.tips.cursor");
			expect(facet).not.toHaveAttribute("title");
			vi.unstubAllGlobals();
		});
	});

	describe("full camera pane", () => {
		const camTl = (region: Record<string, unknown>) => {
			const updateCameraFullscreenOrientation = vi.fn();
			const updateCameraFullscreenDeskLabel = vi.fn();
			const tl = {
				...defaultProps.tl,
				selection: { kind: "cameraFullscreen", id: "cf" },
				cameraFullscreenRegions: [{ id: "cf", startMs: 0, endMs: 2000, ...region }],
				updateCameraFullscreenOrientation,
				updateCameraFullscreenDeskLabel,
				removeRegion: vi.fn(),
			} as unknown as React.ComponentProps<typeof FloatingInspector>["tl"];
			return { tl, updateCameraFullscreenOrientation, updateCameraFullscreenDeskLabel };
		};

		it("desk view sets both fields in one call", () => {
			const { tl, updateCameraFullscreenOrientation } = camTl({});
			render(<FloatingInspector {...defaultProps} tl={tl} />);
			const desk = screen.getByRole("button", { name: "settings.cameraFullscreen.deskView" });
			expect(desk).toHaveAttribute("aria-pressed", "false");
			fireEvent.click(desk);
			expect(updateCameraFullscreenOrientation).toHaveBeenCalledTimes(1);
			expect(updateCameraFullscreenOrientation).toHaveBeenCalledWith("cf", {
				rotation: 180,
				mirror: "auto",
			});
		});

		it("turns desk view off again in one call", () => {
			const { tl, updateCameraFullscreenOrientation } = camTl({ rotation: 180 });
			render(<FloatingInspector {...defaultProps} tl={tl} />);
			const desk = screen.getByRole("button", { name: "settings.cameraFullscreen.deskView" });
			expect(desk).toHaveAttribute("aria-pressed", "true");
			fireEvent.click(desk);
			expect(updateCameraFullscreenOrientation).toHaveBeenCalledWith("cf", {
				rotation: 0,
				mirror: "auto",
			});
		});

		// The pane button has no pressed look of its own, so desk view wears a toggle class
		// whose lit state is styled off aria-pressed — and only that button wears it.
		it("lights the desk view button off its pressed state", () => {
			const { tl } = camTl({ rotation: 180 });
			render(<FloatingInspector {...defaultProps} tl={tl} />);
			const desk = screen.getByRole("button", { name: "settings.cameraFullscreen.deskView" });
			expect(styles.paneToggle).toBeTruthy();
			expect(desk.classList).toContain(styles.paneToggle);
			expect(document.querySelectorAll(`.${styles.paneToggle}`)).toHaveLength(1);
			const css = readFileSync(path.join(__dirname, "EditorShellV4.module.css"), "utf8");
			expect(css).toMatch(/\.paneToggle\[aria-pressed="true"\]\s*[,{]/);
		});

		it("offers the label switch only on a turned section", () => {
			const plain = camTl({});
			const { unmount } = render(<FloatingInspector {...defaultProps} tl={plain.tl} />);
			expect(
				screen.queryByRole("button", { name: "settings.cameraFullscreen.showLabel" }),
			).toBeNull();
			unmount();
			const turned = camTl({ rotation: 180 });
			render(<FloatingInspector {...defaultProps} tl={turned.tl} />);
			const toggle = screen.getByRole("button", { name: "settings.cameraFullscreen.showLabel" });
			expect(toggle).toHaveAttribute("aria-pressed", "true");
			fireEvent.click(toggle);
			expect(turned.updateCameraFullscreenDeskLabel).toHaveBeenCalledWith("cf", false);
		});

		it("changes the mirror without touching the rotation", () => {
			const { tl, updateCameraFullscreenOrientation } = camTl({ rotation: 180 });
			render(<FloatingInspector {...defaultProps} tl={tl} />);
			fireEvent.click(screen.getByRole("button", { name: "settings.cameraFullscreen.mirror.on" }));
			expect(updateCameraFullscreenOrientation).toHaveBeenCalledWith("cf", {
				rotation: 180,
				mirror: "on",
			});
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

describe("AnnotationSizeControl", () => {
	const row = () => screen.getByRole("group", { name: "settings.annotation.size" });

	it("presses the preset the size is, and picks another in one click", () => {
		const onChange = vi.fn();
		render(<AnnotationSizeControl size={32} onChange={onChange} />);
		expect(within(row()).getByRole("button", { name: "32" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		fireEvent.click(within(row()).getByRole("button", { name: "48" }));
		expect(onChange).toHaveBeenCalledWith(48);
	});

	it("shows a size off the row in its free field, pressing no preset", () => {
		render(<AnnotationSizeControl size={40} onChange={vi.fn()} />);
		for (const button of within(row()).getAllByRole("button")) {
			expect(button).toHaveAttribute("aria-pressed", "false");
		}
		expect(screen.getByRole("textbox", { name: "settings.annotation.customSize" })).toHaveAttribute(
			"placeholder",
			"40",
		);
	});
});
