// @vitest-environment jsdom
// What the inspector panes say on hover (technical-documentation/engineering/tooltips.md):
// * a switch beside jargon ("Click impact") gets one line saying what it does, on the switch
//   itself so a keyboard user reaches it too (rules 2 and 10);
// * nothing repeats a label the eye already reads (rule 3), and a hint is never hung on a plain
//   label, where a keyboard or screen-reader user cannot reach it (rule 10).

import "@testing-library/jest-dom";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { LOCALE_STORAGE_KEY } from "@/i18n/config";
import { type AxcutDocument, createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { CursorPane, LayoutPane, VideoEffectsPane } from "./RightPanes";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
// On, so the camera background row (Original, Blur, Cutout, Custom) is offered.
vi.mock("@/native/hooks/useSegmentationSupport", () => ({
	useCanSegmentCamera: () => true,
}));

// jsdom has none, and a Radix tooltip measures its trigger when it opens.
class StubResizeObserver {
	observe() {
		return undefined;
	}
	unobserve() {
		return undefined;
	}
	disconnect() {
		return undefined;
	}
}

beforeEach(() => {
	vi.stubGlobal("ResizeObserver", StubResizeObserver);
	localStorage.clear();
	localStorage.setItem(LOCALE_STORAGE_KEY, "en");
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	localStorage.clear();
	useProjectStore.getState().clear();
});

function project(legacyEditor: Record<string, unknown> = {}): AxcutDocument {
	const base = createEmptyDocument({ projectId: "p1", title: "T" });
	return {
		...base,
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "screen.webm",
				originalPath: "/tmp/screen.webm",
				durationSec: 10,
				video: { codec: "unknown", width: 1920, height: 1080, fps: 30 },
				cameraTrack: { sourcePath: "/tmp/camera.webm", startMs: 0, offsetMs: 0, visible: true },
			},
		],
		project: { ...base.project, primaryAssetId: "asset_1" },
		timeline: {
			...base.timeline,
			clips: [
				{
					id: "clip_1",
					assetId: "asset_1",
					sourceStartSec: 0,
					sourceEndSec: 10,
					timelineStartSec: 0,
					timelineEndSec: 10,
					wordRefs: [],
					origin: "user",
					reason: "test",
				},
			],
		},
		// A tilted zoom, so the depth-of-field row is offered.
		zoomRanges: [
			{
				id: "z1",
				startMs: 0,
				endMs: 2000,
				depth: 3,
				focus: { cx: 0.5, cy: 0.5 },
				rotationPreset: "left",
			},
		],
		legacyEditor: { webcamLayoutPreset: "picture-in-picture", ...legacyEditor },
	} as unknown as AxcutDocument;
}

function mount(pane: React.ReactElement, legacyEditor: Record<string, unknown> = {}) {
	useProjectStore.setState({
		projectId: "p1",
		document: project(legacyEditor),
		revision: 1,
		status: "ready",
	});
	return render(<I18nProvider>{pane}</I18nProvider>).container;
}

// Radix draws the visible tooltip and a visually hidden `role="tooltip"` copy for assistive
// technology, so the styled node is found by its slot.
const visibleTooltip = () => document.querySelector('[data-slot="tooltip-content"]');

function focusSwitch(name: string) {
	const toggle = screen.getByRole("button", { name });
	act(() => toggle.focus());
	return toggle;
}

describe("inspector switch tooltips", () => {
	it.each([
		["Depth of field", "Blurs the far side of a tilted screen", <VideoEffectsPane key="e" />],
		[
			"Auto-hide when inactive",
			"The cursor fades out when it stops moving",
			<CursorPane key="a" />,
		],
		["3D cursor", "Draws the default cursor as a 3D object with a shadow", <CursorPane key="m" />],
		["Click impact", "The screen moves a little with each click", <CursorPane key="c" />],
		[
			"Shrink on zoom",
			"The camera gets smaller while the video is zoomed in",
			<LayoutPane key="l" />,
		],
	])("%s: says what it does, on the switch", (name, tip, pane) => {
		mount(pane);
		const toggle = focusSwitch(name);

		expect(visibleTooltip()).toHaveTextContent(tip);
		// The switch keeps its label as its name; the tooltip only describes it.
		expect(toggle).toHaveAccessibleName(name);
		expect(toggle).toHaveAccessibleDescription(tip);
	});

	it("gives a switch with a clear label no tooltip", () => {
		mount(<CursorPane />);
		focusSwitch("Show cursor");

		expect(visibleTooltip()).toBeNull();
	});
});

describe("inspector labels", () => {
	// Every choice row, tile and label in these panes, with a frame on so the theme row shows.
	it.each([
		["Composition", <VideoEffectsPane key="e" />],
		["Camera layout", <LayoutPane key="l" />],
		["Cursor", <CursorPane key="c" />],
	])("%s: no tooltip repeats the text it sits on", (_pane, pane) => {
		const root = mount(pane, { frame: "laptop" });

		const repeated = [...root.querySelectorAll("[title]")]
			.filter((el) => el.getAttribute("title") === el.textContent?.trim())
			.map((el) => el.getAttribute("title"));
		expect(repeated).toEqual([]);
	});

	it("hangs no hint on the Style and Theme labels", () => {
		mount(<VideoEffectsPane />, { frame: "laptop" });

		for (const name of ["Style", "Theme"]) {
			const label = screen.getByRole("group", { name }).previousElementSibling;
			expect(label).toHaveTextContent(name);
			expect(label).not.toHaveAttribute("title");
		}
	});

	it("hangs no tooltip on the camera background labels or the crop zoom value", () => {
		const root = mount(<LayoutPane />);

		for (const name of ["Original", "Blur", "Cutout", "Custom"]) {
			expect(screen.getByRole("button", { name }).querySelector("[title]")).toBeNull();
		}
		expect(root.querySelector('[title="Zoom"]')).toBeNull();
	});
});
