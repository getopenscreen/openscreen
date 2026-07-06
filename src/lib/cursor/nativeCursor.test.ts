import { describe, expect, it } from "vitest";
import type { NativeCursorAsset } from "@/native/contracts";
import {
	getNativeCursorClickBounceProgress,
	getNativeCursorClickBounceScale,
	hasNativeCursorRecordingData,
	projectNativeCursorToLocal,
	resolveInterpolatedNativeCursorFrame,
	resolveNativeCursorRenderAsset,
} from "./nativeCursor";

describe("native cursor click bounce", () => {
	it("keeps click progress visible across several frames", () => {
		const recordingData = {
			version: 2,
			provider: "native" as const,
			assets: [],
			samples: [
				{ timeMs: 0, cx: 0.5, cy: 0.5, interactionType: "move" as const },
				{ timeMs: 100, cx: 0.5, cy: 0.5, interactionType: "click" as const },
				{ timeMs: 133, cx: 0.5, cy: 0.5, interactionType: "move" as const },
				{ timeMs: 166, cx: 0.5, cy: 0.5, interactionType: "move" as const },
				{ timeMs: 200, cx: 0.5, cy: 0.5, interactionType: "move" as const },
				{ timeMs: 300, cx: 0.5, cy: 0.5, interactionType: "move" as const },
			],
		};

		expect(getNativeCursorClickBounceProgress(recordingData, 133)).toBeGreaterThan(0);
		expect(getNativeCursorClickBounceProgress(recordingData, 200)).toBeGreaterThan(0);
		expect(getNativeCursorClickBounceProgress(recordingData, 400)).toBe(0);
	});

	it("applies a visible press and rebound scale at high intensity", () => {
		expect(getNativeCursorClickBounceScale(5, 1)).toBe(1);
		expect(getNativeCursorClickBounceScale(5, 0.82)).toBeLessThan(0.9);
		expect(getNativeCursorClickBounceScale(5, 0.28)).toBeGreaterThan(1.05);
		expect(getNativeCursorClickBounceScale(5, 0)).toBe(1);
	});

	it("uses the default cursor asset for telemetry-only macOS recordings", () => {
		const recordingData = {
			version: 2,
			provider: "none" as const,
			assets: [],
			samples: [
				{ timeMs: 0, cx: 0.25, cy: 0.4, visible: true },
				{ timeMs: 100, cx: 0.75, cy: 0.6, visible: true },
			],
		};

		expect(hasNativeCursorRecordingData(recordingData)).toBe(true);
		const frame = resolveInterpolatedNativeCursorFrame(recordingData, 50);
		expect(frame?.asset.cursorType).toBe("arrow");
		expect(frame?.sample.cx).toBeCloseTo(0.5);
		expect(frame?.sample.cy).toBeCloseTo(0.5);
	});

	it("renders the natively captured cursor bitmap for untyped macOS samples", () => {
		const capturedAsset: NativeCursorAsset = {
			id: "sha-custom",
			platform: "darwin",
			imageDataUrl: "data:image/png;base64,CUSTOMCURSOR",
			width: 48,
			height: 48,
			hotspotX: 8,
			hotspotY: 8,
			scaleFactor: 2,
		};
		const recordingData = {
			version: 2,
			provider: "native" as const,
			assets: [capturedAsset],
			samples: [
				{ timeMs: 0, cx: 0.4, cy: 0.4, visible: true, assetId: "sha-custom" },
				{ timeMs: 100, cx: 0.6, cy: 0.6, visible: true, assetId: "sha-custom" },
			],
		};

		const frame = resolveInterpolatedNativeCursorFrame(recordingData, 50);
		expect(frame?.asset.id).toBe("sha-custom");

		// No cursorType => no bundled pretty SVG substitution => real captured bitmap,
		// downscaled from pixels to points via the asset scale factor.
		const rendered = resolveNativeCursorRenderAsset(capturedAsset, 1, frame?.sample);
		expect(rendered.imageDataUrl).toBe("data:image/png;base64,CUSTOMCURSOR");
		expect(rendered.width).toBe(24);
		expect(rendered.hotspotX).toBe(4);
	});

	it("applies click bounce to telemetry-only macOS recordings", () => {
		const recordingData = {
			version: 2,
			provider: "none" as const,
			assets: [],
			samples: [
				{ timeMs: 0, cx: 0.5, cy: 0.5, visible: true, interactionType: "move" as const },
				{ timeMs: 100, cx: 0.5, cy: 0.5, visible: true, interactionType: "click" as const },
				{ timeMs: 133, cx: 0.5, cy: 0.5, visible: true, interactionType: "move" as const },
			],
		};

		expect(getNativeCursorClickBounceProgress(recordingData, 133)).toBeGreaterThan(0);
	});
});

describe("custom cursor themes", () => {
	const arrowAsset: NativeCursorAsset = {
		id: "telemetry-arrow",
		platform: "darwin",
		imageDataUrl: "default-arrow",
		width: 32,
		height: 32,
		hotspotX: 16,
		hotspotY: 15,
		cursorType: "arrow",
	};

	it("substitutes the themed art for an overridden cursor type", () => {
		const rendered = resolveNativeCursorRenderAsset(
			arrowAsset,
			1,
			{ timeMs: 0, cx: 0.5, cy: 0.5, cursorType: "arrow" },
			"hello-kitty-watermelon",
		);

		expect(rendered.id).toBe("theme:hello-kitty-watermelon:arrow");
		expect(rendered.imageDataUrl).toContain("cursors/hello-kitty-watermelon/arrow.png");
		expect(rendered.width).toBe(32);
		expect(rendered.hotspotX).toBeCloseTo(1.5);
	});

	it("classifies an untyped macOS arrow bitmap (top-left hotspot) as the themed arrow", () => {
		const macArrow: NativeCursorAsset = {
			id: "sha-arrow",
			platform: "darwin",
			imageDataUrl: "captured-bitmap",
			width: 34,
			height: 46,
			hotspotX: 8,
			hotspotY: 8,
			scaleFactor: 2,
		};
		const rendered = resolveNativeCursorRenderAsset(
			macArrow,
			1,
			{ timeMs: 0, cx: 0.5, cy: 0.5 },
			"hello-kitty-watermelon",
		);

		expect(rendered.id).toBe("theme:hello-kitty-watermelon:arrow");
		expect(rendered.imageDataUrl).toContain("cursors/hello-kitty-watermelon/arrow.png");
	});

	it("classifies an untyped macOS hand bitmap (upper-center hotspot) as the themed pointer", () => {
		const macHand: NativeCursorAsset = {
			id: "sha-hand",
			platform: "darwin",
			imageDataUrl: "captured-bitmap",
			width: 64,
			height: 64,
			hotspotX: 26,
			hotspotY: 16,
			scaleFactor: 2,
		};
		const rendered = resolveNativeCursorRenderAsset(
			macHand,
			1,
			{ timeMs: 0, cx: 0.5, cy: 0.5 },
			"hello-kitty-watermelon",
		);

		expect(rendered.id).toBe("theme:hello-kitty-watermelon:pointer");
		expect(rendered.imageDataUrl).toContain("cursors/hello-kitty-watermelon/pointer.png");
	});

	it("leaves an untyped text/crosshair bitmap (centered hotspot) as the real captured cursor", () => {
		const macText: NativeCursorAsset = {
			id: "sha-text",
			platform: "darwin",
			imageDataUrl: "captured-ibeam",
			width: 18,
			height: 36,
			hotspotX: 8,
			hotspotY: 18,
			scaleFactor: 2,
		};
		const rendered = resolveNativeCursorRenderAsset(
			macText,
			1,
			{ timeMs: 0, cx: 0.5, cy: 0.5 },
			"hello-kitty-watermelon",
		);

		expect(rendered.id).toBe("sha-text");
		expect(rendered.imageDataUrl).toBe("captured-ibeam");
	});

	it("keeps the default art for the default theme id", () => {
		const rendered = resolveNativeCursorRenderAsset(
			arrowAsset,
			1,
			{ timeMs: 0, cx: 0.5, cy: 0.5, cursorType: "arrow" },
			"default",
		);

		expect(rendered.id).toBe("pretty:arrow");
		expect(rendered.imageDataUrl).not.toContain("hello-kitty-watermelon");
	});

	it("falls back to default art for a cursor type the theme does not override", () => {
		const rendered = resolveNativeCursorRenderAsset(
			{ ...arrowAsset, cursorType: "text" },
			1,
			{ timeMs: 0, cx: 0.5, cy: 0.5, cursorType: "text" },
			"hello-kitty-watermelon",
		);

		expect(rendered.id).toBe("pretty:text");
	});
});

describe("projectNativeCursorToLocal", () => {
	const identityCrop = { x: 0, y: 0, width: 1, height: 1 };

	it("maps a sample onto the supplied painted rectangle 1:1 with no crop", () => {
		const point = projectNativeCursorToLocal({
			cropRegion: identityCrop,
			maskRect: { x: 100, y: 200, width: 1280, height: 720 },
			sample: { timeMs: 0, cx: 0.25, cy: 0.5, visible: true },
		});

		expect(point?.x).toBeCloseTo(100 + 0.25 * 1280);
		expect(point?.y).toBeCloseTo(200 + 0.5 * 720);
	});

	it("maps a sample into the cropped region of the painted rectangle", () => {
		const point = projectNativeCursorToLocal({
			cropRegion: { x: 0.25, y: 0.0, width: 0.5, height: 1.0 },
			maskRect: { x: 0, y: 0, width: 1920, height: 1080 },
			sample: { timeMs: 0, cx: 0.5, cy: 0.5, visible: true },
		});

		expect(point?.x).toBeCloseTo(0 + ((0.5 - 0.25) / 0.5) * 1920);
		expect(point?.y).toBeCloseTo(0 + (0.5 / 1.0) * 1080);
	});

	it("projects onto the cropped (cover-letterboxed) painted rect, not the mask rect", () => {
		const screenRect = { x: 0, y: 0, width: 1920, height: 1080 };
		const croppedRect = { x: 0, y: -540, width: 1920, height: 2160 };

		const point = projectNativeCursorToLocal({
			cropRegion: { x: 0.0, y: 0.0, width: 0.5, height: 1.0 },
			maskRect: croppedRect,
			sample: { timeMs: 0, cx: 0.25, cy: 0.25, visible: true },
		});

		const wrong = screenRect.y + 0.25 * screenRect.height;
		expect(wrong).toBe(270);

		expect(point?.x).toBeCloseTo(croppedRect.x + ((0.25 - 0) / 0.5) * croppedRect.width);
		expect(point?.y).toBeCloseTo(croppedRect.y + (0.25 / 1.0) * croppedRect.height);
		expect(point?.y).toBe(0);
		expect(point?.y).not.toBe(wrong);
	});

	it("returns null for a sample outside the cropped region", () => {
		const point = projectNativeCursorToLocal({
			cropRegion: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
			maskRect: { x: 0, y: 0, width: 1920, height: 1080 },
			sample: { timeMs: 0, cx: 0.1, cy: 0.5, visible: true },
		});

		expect(point).toBeNull();
	});

	it("returns null for a degenerate (zero-size) crop region", () => {
		const point = projectNativeCursorToLocal({
			cropRegion: { x: 0, y: 0, width: 0, height: 1 },
			maskRect: { x: 0, y: 0, width: 1920, height: 1080 },
			sample: { timeMs: 0, cx: 0.5, cy: 0.5, visible: true },
		});

		expect(point).toBeNull();
	});
});
