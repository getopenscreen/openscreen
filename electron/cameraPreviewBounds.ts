import type { CameraPreviewTransform } from "../src/lib/cameraPreview";

type Rect = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };
export const CAMERA_PREVIEW_GUTTER = 16;
const ASPECT = 16 / 9;

/** Keep the opposite corner anchored and the image (excluding shadow) in 16:9. */
export function cameraPreviewBounds(
	bounds: Rect,
	direction: CameraPreviewTransform,
	delta: Point,
	area: Rect,
): Rect {
	let { x, y, width, height } = bounds;
	if (direction === "move") {
		x += delta.x;
		y += delta.y;
	} else {
		const west = direction.includes("w");
		const north = direction.includes("n");
		const dx = west ? -delta.x : delta.x;
		const dy = (north ? -delta.y : delta.y) * ASPECT;
		const change = Math.abs(dx) >= Math.abs(dy) ? dx : dy;
		const maxWidth =
			Math.min(
				720,
				area.width - CAMERA_PREVIEW_GUTTER,
				(area.height - CAMERA_PREVIEW_GUTTER) * ASPECT,
			) + CAMERA_PREVIEW_GUTTER;
		width = Math.round(
			Math.max(
				Math.min(240 + CAMERA_PREVIEW_GUTTER, maxWidth),
				Math.min(maxWidth, bounds.width + change),
			),
		);
		height = Math.round((width - CAMERA_PREVIEW_GUTTER) / ASPECT) + CAMERA_PREVIEW_GUTTER;
		if (west) x += bounds.width - width;
		if (north) y += bounds.height - height;
	}
	return {
		x: Math.round(Math.max(area.x, Math.min(x, area.x + area.width - width))),
		y: Math.round(Math.max(area.y, Math.min(y, area.y + area.height - height))),
		width,
		height,
	};
}
