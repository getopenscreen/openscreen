import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { V4Timeline } from "./V4Timeline";

const bridgeMocks = vi.hoisted(() => ({
	getRecordingData: vi.fn(),
	getTelemetry: vi.fn(),
}));

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => key,
}));

vi.mock("@/hooks/useAudioPeaks", () => ({ useAudioPeaks: () => null }));

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		cursor: {
			getRecordingData: bridgeMocks.getRecordingData,
			getTelemetry: bridgeMocks.getTelemetry,
		},
	},
}));

vi.mock("@/lib/ai-edition/store/useEditorSettings", () => ({
	useEditorSettings: () => ({
		settings: {
			aspectRatio: "16:9",
			autoZoomEnabled: true,
			autoFocusAll: false,
			cursor: { smoothing: 0 },
		},
		set: vi.fn(),
	}),
}));

vi.mock("@/components/ui/popover", () => ({
	Popover: ({ children }: { children: ReactNode }) => children,
	PopoverContent: ({ children }: { children: ReactNode }) => children,
	PopoverTrigger: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("../TransportBar", () => ({ TransportBar: () => null }));

function createTimeline() {
	return {
		clips: [
			{
				id: "clip_1",
				assetId: "asset_1",
				timelineStartSec: 0,
				timelineEndSec: 10,
				sourceStartSec: 0,
				sourceEndSec: 10,
			},
		],
		assets: [{ id: "asset_1", label: "Recording", durationSec: 10 }],
		annotationRegions: [],
		speedRegions: [],
		trimRanges: [],
		zoomRegions: [
			{
				id: "zoom_1",
				startMs: 1000,
				endMs: 3000,
				depth: 3,
				mode: "manual",
				focus: { cx: 0.5, cy: 0.5 },
			},
		],
		cursorMotionRegions: [
			{
				id: "motion_1",
				clipId: "clip_1",
				assetId: "asset_1",
				startMs: 3000,
				endMs: 5000,
				sourceStartMs: 3000,
				sourceEndMs: 5000,
				startPoint: { cx: 0.2, cy: 0.3 },
				endPoint: { cx: 0.8, cy: 0.7 },
				controlPoints: [],
				startAnchor: "manual",
				endAnchor: "click",
				segmentKind: "move",
				preset: "arc",
				speed: 1,
				cycles: 1,
				easing: "ease-in-out",
			},
		],
		cameraFullscreenRegions: [],
		selection: null,
		multiSelection: [],
		clipSelection: null,
		selectRegion: vi.fn(),
		clearSelection: vi.fn(),
		selectClip: vi.fn(),
		addTrim: vi.fn(),
		addAnnotation: vi.fn(),
		addSpeed: vi.fn(),
		addZoom: vi.fn(),
		addCameraFullscreen: vi.fn(),
		addZoomsBulk: vi.fn(),
		completePendingAutoZoom: vi.fn(),
		setAutoZoomEnabled: vi.fn(),
		setAutoFocusAll: vi.fn(),
		addCursorMotionRegions: vi.fn(),
		moveClip: vi.fn(),
		removeClip: vi.fn(),
		setTrimEntries: vi.fn(),
		updateAnnotationSpan: vi.fn(),
		updateCameraFullscreenSpan: vi.fn(),
		updateSpeedSpan: vi.fn(),
		updateZoomSpan: vi.fn(),
	};
}

describe("V4Timeline region selection", () => {
	afterEach(() => {
		cleanup();
		bridgeMocks.getRecordingData.mockReset();
		bridgeMocks.getTelemetry.mockReset();
	});

	it("keeps existing zoom pills selectable and selects cursor motion pills", () => {
		const tl = createTimeline();
		const setCurrentTime = vi.fn();
		render(
			<V4Timeline
				tl={tl as never}
				currentTimeSec={0}
				setCurrentTime={setCurrentTime}
				playing={false}
				loop={false}
				onTogglePlay={vi.fn()}
				onPrevClip={vi.fn()}
				onNextClip={vi.fn()}
				onToggleLoop={vi.fn()}
				onExpand={vi.fn()}
				onEditClip={vi.fn()}
			/>,
		);

		fireEvent.pointerDown(screen.getByTitle("1.80×"), { button: 0, pointerId: 1 });
		expect(tl.selectRegion).toHaveBeenLastCalledWith("zoom", "zoom_1", { additive: false });
		fireEvent.pointerUp(window, { pointerId: 1 });

		fireEvent.pointerDown(screen.getByTitle("arc"), { button: 0, pointerId: 2 });
		expect(tl.selectRegion).toHaveBeenLastCalledWith("cursorMotion", "motion_1", {
			additive: false,
		});
		expect(setCurrentTime).toHaveBeenCalledWith(3.001);
	});

	it("keeps auto zoom available while cursor telemetry is loading", async () => {
		let resolveRecordingData: (value: null) => void = () => undefined;
		bridgeMocks.getRecordingData.mockReturnValue(
			new Promise<null>((resolve) => {
				resolveRecordingData = resolve;
			}),
		);
		bridgeMocks.getTelemetry.mockResolvedValue([]);
		const tl = createTimeline();
		render(
			<V4Timeline
				tl={tl as never}
				currentTimeSec={0}
				setCurrentTime={vi.fn()}
				videoSources={[{ id: "asset_1", label: "Recording", src: "file:///C:/recording.webm" }]}
				playing={false}
				loop={false}
				onTogglePlay={vi.fn()}
				onPrevClip={vi.fn()}
				onNextClip={vi.fn()}
				onToggleLoop={vi.fn()}
				onExpand={vi.fn()}
				onEditClip={vi.fn()}
			/>,
		);

		const cursorButton = screen.getByLabelText("cursorMotion.create");
		fireEvent.click(cursorButton);
		await waitFor(() => expect(cursorButton).toBeDisabled());
		expect(screen.getByLabelText("toolbar.autoEnhance")).not.toBeDisabled();

		await act(async () => resolveRecordingData(null));
		await waitFor(() => expect(cursorButton).not.toBeDisabled());
	});

	it("restores direct automatic zoom and Auto-Focus controls", () => {
		const tl = createTimeline();
		render(
			<V4Timeline
				tl={tl as never}
				currentTimeSec={0}
				setCurrentTime={vi.fn()}
				playing={false}
				loop={false}
				onTogglePlay={vi.fn()}
				onPrevClip={vi.fn()}
				onNextClip={vi.fn()}
				onToggleLoop={vi.fn()}
				onExpand={vi.fn()}
				onEditClip={vi.fn()}
			/>,
		);

		fireEvent.click(screen.getByLabelText("buttons.autoZoomOn"));
		expect(tl.setAutoZoomEnabled).toHaveBeenCalledWith(false);

		fireEvent.click(screen.getByLabelText("buttons.autoFocusAllOff"));
		expect(tl.setAutoFocusAll).toHaveBeenCalledWith(true);
	});

	it("automatically processes a newly imported pending recording once telemetry is ready", async () => {
		bridgeMocks.getTelemetry.mockResolvedValue([
			{ timeMs: 1000, cx: 0.25, cy: 0.4 },
			{ timeMs: 1600, cx: 0.25, cy: 0.4 },
		]);
		const tl = createTimeline();
		tl.zoomRegions = [];
		tl.assets[0] = { ...tl.assets[0], autoZoomState: "pending" } as never;
		render(
			<V4Timeline
				tl={tl as never}
				currentTimeSec={0}
				setCurrentTime={vi.fn()}
				videoSources={[{ id: "asset_1", label: "Recording", src: "file:///C:/recording.webm" }]}
				playing={false}
				loop={false}
				onTogglePlay={vi.fn()}
				onPrevClip={vi.fn()}
				onNextClip={vi.fn()}
				onToggleLoop={vi.fn()}
				onExpand={vi.fn()}
				onEditClip={vi.fn()}
			/>,
		);

		await waitFor(() => expect(tl.completePendingAutoZoom).toHaveBeenCalledTimes(1));
		expect(tl.completePendingAutoZoom).toHaveBeenCalledWith(
			"asset_1",
			expect.arrayContaining([
				expect.objectContaining({ focus: expect.objectContaining({ cx: 0.25, cy: 0.4 }) }),
			]),
		);
	});
});
