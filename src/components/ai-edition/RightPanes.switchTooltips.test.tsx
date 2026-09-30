// @vitest-environment jsdom
// A switch beside a clear label needs no tooltip; one beside jargon ("Click impact") gets a
// single line saying what it does. The tooltip hangs on the switch itself, so a keyboard user
// reaches it too (technical-documentation/engineering/tooltips.md, rules 2 and 10).

import "@testing-library/jest-dom";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { LOCALE_STORAGE_KEY } from "@/i18n/config";
import { type AxcutDocument, createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { CursorPane, LayoutPane, VideoEffectsPane } from "./RightPanes";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock("@/native/hooks/useSegmentationSupport", () => ({
	useCanSegmentCamera: () => false,
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

function mount(pane: React.ReactElement) {
	useProjectStore.setState({
		projectId: "p1",
		document: project(),
		revision: 1,
		status: "ready",
	});
	render(<I18nProvider>{pane}</I18nProvider>);
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
