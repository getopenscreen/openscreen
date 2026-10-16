import { describe, expect, it } from "vitest";
import { cameraPreviewBounds, resizedCameraPreviewBounds } from "./cameraPreview";

const workArea = { x: 0, y: 25, width: 1512, height: 900 };
const bar = { x: 300, y: 840, width: 900, height: 64 };

describe("camera preview placement", () => {
	it("starts just above the recording bar's right end", () => {
		const preview = cameraPreviewBounds(workArea, bar);
		expect(preview.x + preview.width).toBe(bar.x + bar.width);
		expect(preview.y + preview.height).toBe(bar.y - 8);
	});

	it("keeps the bottom centre fixed when resized near the bar", () => {
		const before = cameraPreviewBounds(workArea, bar);
		const after = resizedCameraPreviewBounds(before, workArea, 320);
		expect(after.width).toBe(336);
		expect(after.height).toBe(336);
		expect(after.y + after.height).toBe(before.y + before.height);
		expect(after.x + after.width / 2).toBe(before.x + before.width / 2);
	});

	it("keeps a preview on-screen on negative-origin displays and near the screen edge", () => {
		const display = { x: -1280, y: -100, width: 1280, height: 720 };
		const preview = resizedCameraPreviewBounds(
			{ x: -1280, y: -100, width: 176, height: 176 },
			display,
			320,
		);
		expect(preview.x).toBeGreaterThanOrEqual(display.x);
		expect(preview.y).toBeGreaterThanOrEqual(display.y);
		expect(preview.x + preview.width).toBeLessThanOrEqual(0);
		expect(preview.y + preview.height).toBeLessThanOrEqual(620);
	});
});
