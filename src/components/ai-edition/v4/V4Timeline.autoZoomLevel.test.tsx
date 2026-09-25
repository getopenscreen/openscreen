// @vitest-environment jsdom
//
// "Automatic zooms" adds its zooms at the level picked right under it (#683). Picking a
// level runs nothing and is remembered; the next run hands that level to the timeline.
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => key,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));
vi.mock("@/hooks/useAudioPeaks", () => ({ useAudioPeaks: () => null }));
vi.mock("@/lib/ai-edition/store/useEditorSettings", () => ({
	useEditorSettings: () => ({
		settings: { audioGainDb: 0 },
		hasDocument: true,
		set: vi.fn(),
		setLive: vi.fn(),
		commit: vi.fn(),
	}),
}));

import { ShortcutsProvider } from "@/contexts/ShortcutsContext";
import { createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import type { useTimeline } from "@/lib/ai-edition/store/useTimeline";
import { nativeBridgeClient } from "@/native/client";
import { V4Timeline } from "./V4Timeline";

const CLIP_SEC = 10;
const RECORDING = "/tmp/rec.mp4";

beforeAll(() => {
	globalThis.ResizeObserver = class {
		observe() {
			/* noop */
		}
		unobserve() {
			/* noop */
		}
		disconnect() {
			/* noop */
		}
	} as unknown as typeof ResizeObserver;
	Object.defineProperty(HTMLElement.prototype, "clientWidth", {
		configurable: true,
		get: () => 900,
	});
});

beforeEach(() => {
	const store = new Map<string, string>();
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => store.set(key, String(value)),
			removeItem: (key: string) => store.delete(key),
			clear: () => store.clear(),
		},
	});
	const doc = createEmptyDocument({ projectId: "p_level", title: "Take" });
	useProjectStore.setState({
		projectId: doc.project.id,
		document: {
			...doc,
			assets: [
				{ id: "a1", kind: "video", label: "rec", originalPath: RECORDING, cameraTrack: null },
			],
			timeline: {
				...doc.timeline,
				clips: [
					{
						id: "c0",
						assetId: "a1",
						sourceStartSec: 0,
						sourceEndSec: CLIP_SEC,
						timelineStartSec: 0,
						timelineEndSec: CLIP_SEC,
						wordRefs: [],
						origin: "system",
						reason: "",
					},
				],
			},
		},
	});
	// The pointer rests 2 s around 4 s: the suggestion pass turns that dwell into one zoom.
	vi.spyOn(nativeBridgeClient.cursor, "getTelemetry").mockResolvedValue(
		[3000, 3500, 4000, 4500, 5000].map((timeMs) => ({ timeMs, cx: 0.4, cy: 0.6 })),
	);
});

function renderTimeline() {
	const tl = {
		transcripts: [],
		clips: useProjectStore.getState().document?.timeline.clips ?? [],
		assets: [{ id: "a1", label: "rec", durationSec: CLIP_SEC }],
		annotationRegions: [],
		speedRegions: [],
		cameraFullscreenRegions: [],
		zoomRegions: [],
		trimRanges: [],
		selection: null,
		multiSelection: [],
		clipSelection: null,
		audioTracks: [],
		selectedAudioTrackId: null,
		selectAudioTrack: vi.fn(),
		clearSelection: vi.fn(),
		selectRegion: vi.fn(),
		selectClip: vi.fn(),
		updateAnnotationSpan: vi.fn(async () => undefined),
		addZoom: vi.fn(async () => undefined),
		addZoomsBulk: vi.fn(async () => 1),
	};
	render(
		<ShortcutsProvider>
			<V4Timeline
				tl={tl as unknown as ReturnType<typeof useTimeline>}
				videoSources={[{ id: "a1", src: `file://${RECORDING}`, label: "rec" }]}
				setCurrentTime={vi.fn()}
				playing={false}
				onTogglePlay={vi.fn()}
				onPrevClip={vi.fn()}
				onNextClip={vi.fn()}
				onEditClip={vi.fn()}
				onAddVoiceover={vi.fn()}
			/>
		</ShortcutsProvider>,
	);
	return tl;
}

describe("Automatic zooms level", () => {
	it("adds the zooms at the level picked under the action, and remembers it", async () => {
		const tl = renderTimeline();
		fireEvent.click(screen.getByRole("button", { name: "toolbar.autoEnhance" }));
		const levels = await screen.findByRole("group", { name: "zoom.level" });

		fireEvent.click(within(levels).getByRole("button", { name: "2.2×" }));
		expect(tl.addZoomsBulk).not.toHaveBeenCalled();
		expect(JSON.parse(localStorage.getItem("openscreen_user_preferences") ?? "{}")).toMatchObject({
			autoZoomScale: 2.2,
		});

		fireEvent.click(screen.getByRole("button", { name: /toolbar\.automaticZooms/ }));
		await waitFor(() => expect(tl.addZoomsBulk).toHaveBeenCalledWith(expect.any(Array), 2.2));
	});

	it("starts on the level picked last time", async () => {
		localStorage.setItem("openscreen_user_preferences", JSON.stringify({ autoZoomScale: 1.5 }));
		renderTimeline();
		fireEvent.click(screen.getByRole("button", { name: "toolbar.autoEnhance" }));
		const levels = await screen.findByRole("group", { name: "zoom.level" });
		expect(within(levels).getByRole("button", { name: "1.5×" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
	});
});
