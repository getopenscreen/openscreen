import { describe, expect, it } from "vitest";
import type { CursorRecordingData } from "@/native/contracts";
import { FrameRenderer } from "./frameRenderer";
import { drawWebcamFrameImage } from "./webcamFrameDrawing";

type DrawCall =
	| ["drawImage", unknown, number, number, number, number, number, number, number, number]
	| ["restore"]
	| ["save"]
	| ["scale", number, number]
	| ["translate", number, number];

function createMockCanvasContext() {
	const calls: DrawCall[] = [];
	const ctx = {
		drawImage: (
			image: CanvasImageSource,
			sx: number,
			sy: number,
			sw: number,
			sh: number,
			dx: number,
			dy: number,
			dw: number,
			dh: number,
		) => calls.push(["drawImage", image, sx, sy, sw, sh, dx, dy, dw, dh]),
		restore: () => calls.push(["restore"]),
		save: () => calls.push(["save"]),
		scale: (x: number, y: number) => calls.push(["scale", x, y]),
		translate: (x: number, y: number) => calls.push(["translate", x, y]),
	};

	return { calls, ctx };
}

describe("drawWebcamFrameImage", () => {
	it("draws the webcam frame into the layout rect by default", () => {
		const { calls, ctx } = createMockCanvasContext();
		const frame = {} as CanvasImageSource;

		drawWebcamFrameImage(
			ctx,
			frame,
			{ x: 12, y: 8, width: 640, height: 360 },
			{ x: 100, y: 50, width: 320, height: 180 },
		);

		expect(calls).toEqual([["drawImage", frame, 12, 8, 640, 360, 100, 50, 320, 180]]);
	});

	it("mirrors around the webcam rect without changing the crop", () => {
		const { calls, ctx } = createMockCanvasContext();
		const frame = {} as CanvasImageSource;

		drawWebcamFrameImage(
			ctx,
			frame,
			{ x: 12, y: 8, width: 640, height: 360 },
			{ x: 100, y: 50, width: 320, height: 180 },
			true,
		);

		expect(calls).toEqual([
			["save"],
			["translate", 420, 50],
			["scale", -1, 1],
			["drawImage", frame, 12, 8, 640, 360, 0, 0, 320, 180],
			["restore"],
		]);
	});

	it("restores the canvas context if mirrored drawing fails", () => {
		const { calls, ctx } = createMockCanvasContext();
		const frame = {} as CanvasImageSource;
		const error = new Error("draw failed");
		ctx.drawImage = () => {
			calls.push(["drawImage", frame, 12, 8, 640, 360, 0, 0, 320, 180]);
			throw error;
		};

		expect(() =>
			drawWebcamFrameImage(
				ctx,
				frame,
				{ x: 12, y: 8, width: 640, height: 360 },
				{ x: 100, y: 50, width: 320, height: 180 },
				true,
			),
		).toThrow(error);

		expect(calls).toEqual([
			["save"],
			["translate", 420, 50],
			["scale", -1, 1],
			["drawImage", frame, 12, 8, 640, 360, 0, 0, 320, 180],
			["restore"],
		]);
	});
});

function recording(samples: CursorRecordingData["samples"]): CursorRecordingData {
	return { version: 2, provider: "native", assets: [], samples };
}

describe("FrameRenderer.setSource cursor telemetry", () => {
	it("replaces telemetry for each asset and clears it when the source has no samples", () => {
		const primary = recording([{ timeMs: 5, cx: 0.4, cy: 0.6, visible: true }]);
		const sourceA = recording([{ timeMs: 10, cx: 0.1, cy: 0.2, visible: true }]);
		const sourceB = recording([{ timeMs: 20, cx: 0.8, cy: 0.7, visible: true }]);
		const renderer = new FrameRenderer({
			width: 1920,
			height: 1080,
			wallpaper: "#000000",
			zoomRegions: [],
			showShadow: false,
			shadowIntensity: 0,
			showBlur: false,
			cropRegion: { x: 0, y: 0, width: 1, height: 1 },
			cursorRecordingData: primary,
			videoWidth: 1920,
			videoHeight: 1080,
			platform: "win32",
		});
		const config = (
			renderer as unknown as {
				config: { cursorTelemetry?: Array<{ timeMs: number; cx: number; cy: number }> };
			}
		).config;
		expect(config.cursorTelemetry).toEqual([{ timeMs: 5, cx: 0.4, cy: 0.6 }]);

		renderer.setSource({ videoWidth: 1920, videoHeight: 1080, cursorRecordingData: sourceA });
		expect(config.cursorTelemetry).toEqual([{ timeMs: 10, cx: 0.1, cy: 0.2 }]);

		renderer.setSource({ videoWidth: 1280, videoHeight: 720, cursorRecordingData: sourceB });
		expect(config.cursorTelemetry).toEqual([{ timeMs: 20, cx: 0.8, cy: 0.7 }]);

		renderer.setSource({
			videoWidth: 1280,
			videoHeight: 720,
			cursorRecordingData: recording([]),
		});
		expect(config.cursorTelemetry).toEqual([]);

		renderer.setSource({ videoWidth: 1280, videoHeight: 720, cursorRecordingData: null });
		expect(config.cursorTelemetry).toEqual([]);
	});
});
