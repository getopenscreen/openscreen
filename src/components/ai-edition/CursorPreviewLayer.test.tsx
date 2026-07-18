import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { CursorPreviewLayer } from "./CursorPreviewLayer";

const bridgeMocks = vi.hoisted(() => ({
	getRecordingData: vi.fn(),
	getTelemetry: vi.fn(),
}));

class StubResizeObserver {
	private callback: ResizeObserverCallback;
	private target: Element | null = null;
	constructor(callback: ResizeObserverCallback) {
		this.callback = callback;
	}
	observe(target: Element) {
		this.target = target;
		return undefined;
	}
	unobserve() {
		return undefined;
	}
	disconnect() {
		return undefined;
	}
}

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		cursor: {
			getRecordingData: bridgeMocks.getRecordingData,
			getTelemetry: bridgeMocks.getTelemetry,
		},
	},
}));

vi.mock("@/lib/cursor/pixiCursorRenderer", () => ({
	DEFAULT_CURSOR_CONFIG: { dotRadius: 28, smoothingFactor: 0, motionBlur: 0, clickBounce: 1 },
	preloadCursorAssets: vi.fn(async () => undefined),
	PixiCursorOverlay: class {
		public container = { label: "" };
		// ponytail: no-op stubs — the test asserts on the React boundary,
		// not on Pixi internals.
		update() {
			/* no-op */
		}
		setDotRadius() {
			/* no-op */
		}
		setSmoothingFactor() {
			/* no-op */
		}
		setMotionBlur() {
			/* no-op */
		}
		setClickBounce() {
			/* no-op */
		}
		reset() {
			/* no-op */
		}
		destroy() {
			/* no-op */
		}
	},
}));

vi.mock("pixi.js", () => ({
	Application: class {
		public canvas = document.createElement("canvas");
		public stage = { addChild: vi.fn() };
		public ticker = { maxFPS: 60 };
		public renderer = {};
		// ponytail: no-op stubs — the test asserts on the React boundary,
		// not on Pixi internals.
		async init() {
			/* no-op */
		}
		destroy() {
			/* no-op */
		}
	},
	Container: class {},
}));

const SAMPLE_DOC = {
	schemaVersion: 3,
	project: {
		id: "proj_test",
		title: "Test",
		createdAt: "2026-06-25T10:00:00.000Z",
		updatedAt: "2026-06-25T10:00:00.000Z",
	},
	assets: [],
	transcript: null,
	transcripts: [],
	timeline: {
		clips: [],
		gaps: [],
		trimRanges: [],
		muteRanges: [],
		speedRegions: [],
		captionRanges: [],
	},
	annotations: [],
	zoomRanges: [],
	legacyEditor: null,
	agent: { pendingQuestions: [], suggestions: [], lastAppliedOperations: [] },
	preview: { strategy: "seek", revision: 0 },
	export: { preset: "final-balanced", lastJobId: null },
	history: { revisions: [] },
};

function renderWithVideo(props: Partial<ComponentProps<typeof CursorPreviewLayer>> = {}): {
	host: HTMLDivElement;
	video: HTMLVideoElement;
} {
	const stage = document.createElement("div");
	const video = document.createElement("video");
	stage.appendChild(video);
	document.body.appendChild(stage);
	vi.spyOn(video, "getBoundingClientRect").mockReturnValue({
		x: 0,
		y: 0,
		width: 1920,
		height: 1080,
		top: 0,
		right: 1920,
		bottom: 1080,
		left: 0,
		toJSON: () => "",
	});

	const host = document.createElement("div");
	stage.appendChild(host);
	act(() => {
		render(
			<CursorPreviewLayer
				videoPath="/tmp/recording.mp4"
				currentTimeSec={0.5}
				isPlaying={false}
				{...props}
			/>,
			{ container: host },
		);
	});
	return { host: stage, video };
}

describe("CursorPreviewLayer (shared)", () => {
	beforeEach(() => {
		Object.defineProperty(window, "ResizeObserver", {
			writable: true,
			value: StubResizeObserver,
		});
		useProjectStore.getState().clear();
		useProjectStore.setState({
			projectId: "proj_test",
			document: SAMPLE_DOC,
			revision: 1,
			status: "ready",
			error: null,
			sourceDurationSec: 0,
			currentTimeSec: 0,
			dirty: false,
			lastSavedAt: new Date(),
		});
		for (const mock of Object.values(bridgeMocks)) {
			mock.mockReset();
		}
	});

	afterEach(() => {
		cleanup();
		document.body.innerHTML = "";
	});

	it("renders nothing when videoPath is null", () => {
		bridgeMocks.getRecordingData.mockResolvedValue(null);
		bridgeMocks.getTelemetry.mockResolvedValue([]);
		const host = document.createElement("div");
		document.body.appendChild(host);
		act(() => {
			render(<CursorPreviewLayer videoPath={null} currentTimeSec={0} isPlaying={false} />, {
				container: host,
			});
		});
		expect(host.querySelector("img")).toBeNull();
	});

	it("uses cursor data supplied by the parent without querying the native bridge", async () => {
		renderWithVideo({
			cursorRecordingData: null,
			cursorTelemetry: [{ timeMs: 500, cx: 0.4, cy: 0.6 }],
		});

		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});

		expect(bridgeMocks.getRecordingData).not.toHaveBeenCalled();
		expect(bridgeMocks.getTelemetry).not.toHaveBeenCalled();
	});

	it("hides the native cursor <img> when settings.cursorShow is false", async () => {
		const document = useProjectStore.getState().document;
		useProjectStore.setState({
			document: { ...document!, legacyEditor: { cursorShow: false } },
		});
		const { host } = renderWithVideo();

		// ponytail: let the rAF tick fire + flush.
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 16));
		});

		const img = host.querySelector("img");
		expect(img).toBeTruthy();
		expect((img as HTMLImageElement).style.display).toBe("none");
	});

	it("shows recorded and edited paths with a draggable control for the selected region", async () => {
		const onControlPointChange = vi.fn();
		const onControlPointCommit = vi.fn();
		const cursorRecordingData = {
			version: 2,
			provider: "native" as const,
			assets: [
				{
					id: "cursor-arrow",
					platform: "win32",
					imageDataUrl: "data:image/png;base64,AA==",
					width: 32,
					height: 32,
					hotspotX: 0,
					hotspotY: 0,
				},
			],
			samples: [
				{ timeMs: 0, cx: 0.2, cy: 0.5, visible: true, assetId: "cursor-arrow" },
				{ timeMs: 1000, cx: 0.8, cy: 0.5, visible: true, assetId: "cursor-arrow" },
			],
		};
		const region = {
			id: "motion_1",
			clipId: "clip_1",
			assetId: "asset_1",
			startMs: 0,
			endMs: 1000,
			sourceStartMs: 0,
			sourceEndMs: 1000,
			startPoint: { cx: 0.2, cy: 0.5 },
			endPoint: { cx: 0.8, cy: 0.5 },
			controlPoints: [{ cx: 0.5, cy: 0.2 }],
			startAnchor: "manual" as const,
			endAnchor: "click" as const,
			segmentKind: "move" as const,
			preset: "arc" as const,
			speed: 1,
			cycles: 1,
			easing: "linear" as const,
		};
		const { host } = renderWithVideo({
			cursorRecordingData,
			cursorTelemetry: [],
			assetId: "asset_1",
			clipId: "clip_1",
			cursorMotionRegions: [region],
			selectedCursorMotionRegionId: region.id,
			onControlPointChange,
			onControlPointCommit,
		});

		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});

		const overlay = host.querySelector('svg[aria-label="Selected cursor path"]');
		expect(overlay).toBeTruthy();
		expect(overlay?.querySelectorAll("polyline")).toHaveLength(2);
		expect(overlay?.querySelectorAll("circle")).toHaveLength(3);
		expect(overlay?.querySelectorAll("polyline")[0].getAttribute("points")).not.toBe(
			overlay?.querySelectorAll("polyline")[1].getAttribute("points"),
		);

		const control = overlay?.querySelectorAll("circle")[2] as SVGCircleElement;
		vi.spyOn(overlay as SVGSVGElement, "getBoundingClientRect").mockReturnValue({
			x: 0,
			y: 0,
			width: 100,
			height: 100,
			top: 0,
			right: 100,
			bottom: 100,
			left: 0,
			toJSON: () => "",
		});
		Object.defineProperties(control, {
			setPointerCapture: { value: vi.fn() },
			hasPointerCapture: { value: vi.fn(() => true) },
			releasePointerCapture: { value: vi.fn() },
		});

		fireEvent.pointerDown(control, { pointerId: 1, clientX: 55, clientY: 35 });
		fireEvent.pointerMove(control, { pointerId: 1, clientX: 75, clientY: 45 });
		fireEvent.pointerUp(control, { pointerId: 1, clientX: 75, clientY: 45 });

		expect(onControlPointChange).toHaveBeenLastCalledWith(region.id, 0, {
			cx: 0.75,
			cy: 0.45,
		});
		expect(onControlPointCommit).toHaveBeenCalledTimes(1);
	});

	it("projects a cropped motion overlay and saves dragged controls in source coordinates", async () => {
		const onControlPointChange = vi.fn();
		const cursorRecordingData = {
			version: 2,
			provider: "native" as const,
			assets: [
				{
					id: "cursor-arrow",
					platform: "win32",
					imageDataUrl: "data:image/png;base64,AA==",
					width: 32,
					height: 32,
					hotspotX: 0,
					hotspotY: 0,
				},
			],
			samples: [
				{ timeMs: 0, cx: 0.25, cy: 0.25, visible: true, assetId: "cursor-arrow" },
				{ timeMs: 1000, cx: 0.75, cy: 0.75, visible: true, assetId: "cursor-arrow" },
			],
		};
		const region = {
			id: "motion_crop",
			clipId: "clip_1",
			assetId: "asset_1",
			startMs: 0,
			endMs: 1000,
			sourceStartMs: 0,
			sourceEndMs: 1000,
			startPoint: { cx: 0.25, cy: 0.25 },
			endPoint: { cx: 0.75, cy: 0.75 },
			controlPoints: [{ cx: 0.5, cy: 0.5 }],
			startAnchor: "manual" as const,
			endAnchor: "click" as const,
			segmentKind: "move" as const,
			preset: "arc" as const,
			speed: 1,
			cycles: 1,
			easing: "linear" as const,
		};
		const { host } = renderWithVideo({
			cursorRecordingData,
			cursorTelemetry: [],
			cropRegion: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
			assetId: "asset_1",
			clipId: "clip_1",
			cursorMotionRegions: [region],
			selectedCursorMotionRegionId: region.id,
			onControlPointChange,
		});

		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});

		const overlay = host.querySelector('svg[aria-label="Selected cursor path"]');
		const circles = overlay?.querySelectorAll("circle");
		expect(circles).toHaveLength(3);
		expect(circles?.[0]).toHaveAttribute("cx", "0");
		expect(circles?.[0]).toHaveAttribute("cy", "0");
		expect(circles?.[1]).toHaveAttribute("cx", "1");
		expect(circles?.[1]).toHaveAttribute("cy", "1");
		expect(circles?.[2]).toHaveAttribute("cx", "0.5");
		expect(circles?.[2]).toHaveAttribute("cy", "0.5");

		vi.spyOn(overlay as SVGSVGElement, "getBoundingClientRect").mockReturnValue({
			x: 0,
			y: 0,
			width: 100,
			height: 100,
			top: 0,
			right: 100,
			bottom: 100,
			left: 0,
			toJSON: () => "",
		});
		const control = circles?.[2] as SVGCircleElement;
		Object.defineProperties(control, {
			setPointerCapture: { value: vi.fn() },
			hasPointerCapture: { value: vi.fn(() => true) },
			releasePointerCapture: { value: vi.fn() },
		});
		fireEvent.pointerDown(control, { pointerId: 2, clientX: 80, clientY: 20 });

		expect(onControlPointChange).toHaveBeenLastCalledWith(region.id, 0, {
			cx: 0.65,
			cy: 0.35,
		});
	});
});
