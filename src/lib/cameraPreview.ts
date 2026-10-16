export const CAMERA_PREVIEW_SIZES = [160, 224, 320] as const;
export const CAMERA_PREVIEW_DEFAULT_SIZE = 224;
const WINDOW_PADDING = 16;

type Rect = { x: number; y: number; width: number; height: number };

function clampBounds(x: number, y: number, diameter: number, workArea: Rect): Rect {
	const size = Math.min(diameter + WINDOW_PADDING, workArea.width, workArea.height);
	return {
		x: Math.round(Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - size))),
		y: Math.round(Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - size))),
		width: size,
		height: size,
	};
}

/** Place the circle just above the bar's right end, including the transparent window padding. */
export function cameraPreviewBounds(workArea: Rect, bar?: Rect): Rect {
	const size = CAMERA_PREVIEW_DEFAULT_SIZE + WINDOW_PADDING;
	return clampBounds(
		bar ? bar.x + bar.width - size : workArea.x + workArea.width / 2 + 160,
		(bar?.y ?? workArea.y + workArea.height - 84) - size - 8,
		CAMERA_PREVIEW_DEFAULT_SIZE,
		workArea,
	);
}

/** Grow upward from the bottom centre, retaining its distance from the recording bar. */
export function resizedCameraPreviewBounds(bounds: Rect, workArea: Rect, diameter: number): Rect {
	const size = diameter + WINDOW_PADDING;
	return clampBounds(
		bounds.x + (bounds.width - size) / 2,
		bounds.y + bounds.height - size,
		diameter,
		workArea,
	);
}
