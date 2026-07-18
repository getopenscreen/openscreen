import "@testing-library/jest-dom";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AxcutClip, AxcutZoomRegion } from "@/lib/ai-edition/schema";
import { VirtualPreview } from "./VirtualPreview";

const mocks = vi.hoisted(() => ({
	computeZoomPreviewTransform: vi.fn(() => ({
		scale: 1,
		translateXPercent: 0,
		translateYPercent: 0,
	})),
	getRecordingData: vi.fn(),
	getTelemetry: vi.fn(),
	cursorLayerProps: vi.fn(),
}));

vi.mock("@/lib/ai-edition/timeline/zoom-preview", () => ({
	IDENTITY_ZOOM_TRANSFORM: { scale: 1, translateXPercent: 0, translateYPercent: 0 },
	computeZoomPreviewTransform: mocks.computeZoomPreviewTransform,
}));

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		cursor: {
			getRecordingData: mocks.getRecordingData,
			getTelemetry: mocks.getTelemetry,
		},
	},
}));

vi.mock("@/lib/ai-edition/store/useEditorSettings", () => ({
	useEditorSettings: () => ({ settings: { cursorShow: true } }),
}));

vi.mock("./CursorPreviewLayer", () => ({
	CursorPreviewLayer: (props: Record<string, unknown>) => {
		mocks.cursorLayerProps(props);
		return <div data-testid="cursor-layer" />;
	},
}));

const clips: AxcutClip[] = [
	{
		id: "clip-a",
		assetId: "asset-a",
		sourceStartSec: 5,
		sourceEndSec: 6,
		timelineStartSec: 0,
		timelineEndSec: 1,
		wordRefs: [],
		origin: "system",
		reason: "",
	},
	{
		id: "clip-b",
		assetId: "asset-b",
		sourceStartSec: 20,
		sourceEndSec: 21,
		timelineStartSec: 1,
		timelineEndSec: 2,
		wordRefs: [],
		origin: "system",
		reason: "",
	},
];

const zoomRegions: AxcutZoomRegion[] = [
	{
		id: "zoom-auto",
		startMs: 0,
		endMs: 2000,
		depth: 3,
		focus: { cx: 0.5, cy: 0.5 },
		focusMode: "auto",
	},
];

describe("VirtualPreview cursor data", () => {
	beforeEach(() => {
		for (const mock of Object.values(mocks)) mock.mockClear();
	});

	afterEach(() => cleanup());

	it("loads each active asset once and never applies the previous asset's telemetry", async () => {
		let resolveRecordingB: ((value: unknown) => void) | undefined;
		let resolveTelemetryB: ((value: unknown) => void) | undefined;
		mocks.getRecordingData.mockImplementation((path: string) => {
			if (path.includes("b.mp4")) {
				return new Promise((resolve) => {
					resolveRecordingB = resolve;
				});
			}
			return Promise.resolve({
				version: 2,
				provider: "native",
				assets: [],
				samples: [{ timeMs: 5000, cx: 0.2, cy: 0.4 }],
			});
		});
		mocks.getTelemetry.mockImplementation((path: string) => {
			if (path.includes("b.mp4")) {
				return new Promise((resolve) => {
					resolveTelemetryB = resolve;
				});
			}
			return Promise.resolve([{ timeMs: 5000, cx: 0.25, cy: 0.45 }]);
		});

		const sources = [
			{ id: "asset-a", src: "file:///a.mp4", label: "A" },
			{ id: "asset-b", src: "file:///b.mp4", label: "B" },
		];
		const view = render(
			<VirtualPreview videoSources={sources} clips={clips} zoomRegions={zoomRegions} />,
		);

		await waitFor(() => {
			expect(
				mocks.computeZoomPreviewTransform.mock.calls.some(
					(call) => (call[2] as Array<{ cx: number }>)[0]?.cx === 0.2,
				),
			).toBe(true);
		});
		const recordingCallsForA = mocks.getRecordingData.mock.calls.filter(([path]) =>
			String(path).includes("a.mp4"),
		).length;
		const telemetryCallsForA = mocks.getTelemetry.mock.calls.filter(([path]) =>
			String(path).includes("a.mp4"),
		).length;
		expect(recordingCallsForA).toBeGreaterThan(0);
		expect(telemetryCallsForA).toBeGreaterThan(0);

		view.rerender(
			<VirtualPreview
				videoSources={sources}
				clips={clips}
				zoomRegions={zoomRegions}
				seekTarget={{ timeSec: 1.5, requestId: 1 }}
			/>,
		);

		await waitFor(() => {
			expect(
				mocks.getRecordingData.mock.calls.some(([path]) => String(path).includes("b.mp4")),
			).toBe(true);
			expect(mocks.getTelemetry.mock.calls.some(([path]) => String(path).includes("b.mp4"))).toBe(
				true,
			);
		});
		expect(
			mocks.getRecordingData.mock.calls.filter(([path]) => String(path).includes("a.mp4")),
		).toHaveLength(recordingCallsForA);
		expect(
			mocks.getTelemetry.mock.calls.filter(([path]) => String(path).includes("a.mp4")),
		).toHaveLength(telemetryCallsForA);
		await waitFor(() => {
			const lastCall = mocks.computeZoomPreviewTransform.mock.calls.at(-1);
			expect(lastCall?.[2]).toEqual([]);
		});

		resolveRecordingB?.({
			version: 2,
			provider: "native",
			assets: [],
			samples: [{ timeMs: 20000, cx: 0.8, cy: 0.6 }],
		});
		resolveTelemetryB?.([{ timeMs: 20000, cx: 0.75, cy: 0.55 }]);

		await waitFor(() => {
			const lastCall = mocks.computeZoomPreviewTransform.mock.calls.at(-1);
			expect((lastCall?.[2] as Array<{ cx: number }>)[0]?.cx).toBe(0.8);
		});
		expect(
			mocks.getRecordingData.mock.calls.filter(([path]) => String(path).includes("a.mp4")),
		).toHaveLength(recordingCallsForA);
		expect(
			mocks.getTelemetry.mock.calls.filter(([path]) => String(path).includes("a.mp4")),
		).toHaveLength(telemetryCallsForA);
	});
});
