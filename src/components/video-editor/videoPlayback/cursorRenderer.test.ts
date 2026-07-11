import { describe, expect, it } from "vitest";
import type { CropRegion } from "../types";
import { type CursorViewportRect, mapCursorToCroppedViewport } from "./cursorRenderer";

const FULL_CROP: CropRegion = { x: 0, y: 0, width: 1, height: 1 };
const VIEWPORT: CursorViewportRect = { x: 100, y: 50, width: 800, height: 400 };

describe("mapCursorToCroppedViewport", () => {
	it("maps positions directly onto the viewport when there is no crop", () => {
		const center = mapCursorToCroppedViewport(0.5, 0.5, VIEWPORT, FULL_CROP);
		expect(center).toEqual({ px: 500, py: 250 });

		const topLeft = mapCursorToCroppedViewport(0, 0, VIEWPORT, FULL_CROP);
		expect(topLeft).toEqual({ px: 100, py: 50 });

		const bottomRight = mapCursorToCroppedViewport(1, 1, VIEWPORT, FULL_CROP);
		expect(bottomRight).toEqual({ px: 900, py: 450 });
	});

	it("re-normalizes a full-frame position into the cropped viewport", () => {
		// Crop the right-bottom half of the frame. A telemetry point at the frame
		// center (0.5, 0.5) sits at the top-left corner of this crop.
		const crop: CropRegion = { x: 0.5, y: 0.5, width: 0.5, height: 0.5 };

		const atCropOrigin = mapCursorToCroppedViewport(0.5, 0.5, VIEWPORT, crop);
		expect(atCropOrigin).toEqual({ px: 100, py: 50 });

		// The frame center of the crop (0.75, 0.75) maps to the viewport center.
		const atCropCenter = mapCursorToCroppedViewport(0.75, 0.75, VIEWPORT, crop);
		expect(atCropCenter).toEqual({ px: 500, py: 250 });
	});

	it("does not drift: a point on the visible cropped content keeps its relative offset", () => {
		// Regression test for issue #64. Before the fix the cursor was projected with
		// the full-frame normalized coordinate directly onto the cropped viewport,
		// which shifted (drifted) it away from the underlying pixel after cropping.
		const crop: CropRegion = { x: 0.2, y: 0.1, width: 0.6, height: 0.6 };
		const normX = 0.6; // inside the crop, but offset from the crop's own center
		const normY = 0.4;

		const mapped = mapCursorToCroppedViewport(normX, normY, VIEWPORT, crop);

		// Expected: re-normalize against the crop, then project onto the viewport.
		const expectedPx = VIEWPORT.x + ((normX - crop.x) / crop.width) * VIEWPORT.width;
		const expectedPy = VIEWPORT.y + ((normY - crop.y) / crop.height) * VIEWPORT.height;
		expect(mapped).toEqual({ px: expectedPx, py: expectedPy });

		// The naive (buggy) projection would have produced a different point.
		const buggyPx = VIEWPORT.x + normX * VIEWPORT.width;
		expect(mapped!.px).not.toBeCloseTo(buggyPx, 5);
	});

	it("returns null when the position falls outside the visible crop", () => {
		const crop: CropRegion = { x: 0.5, y: 0.5, width: 0.5, height: 0.5 };
		// (0.1, 0.1) is in the top-left of the frame, outside the bottom-right crop.
		expect(mapCursorToCroppedViewport(0.1, 0.1, VIEWPORT, crop)).toBeNull();
	});

	it("returns null for a degenerate crop", () => {
		expect(
			mapCursorToCroppedViewport(0.5, 0.5, VIEWPORT, { x: 0, y: 0, width: 0, height: 0 }),
		).toBeNull();
	});
});
