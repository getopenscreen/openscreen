export const CAMERA_PREVIEW_SIZES = [160, 224, 320] as const;
export const CAMERA_PREVIEW_DEFAULT_SIZE = 224;
export const CAMERA_PREVIEW_DEFAULT_ASPECT_RATIO = 16 / 9;
const WINDOW_PADDING = 16;

type Rect = { x: number; y: number; width: number; height: number };

function previewSize(width: number, aspectRatio: number, workArea: Rect) {
	const contentWidth = Math.min(
		width,
		workArea.width - WINDOW_PADDING,
		(workArea.height - WINDOW_PADDING) * aspectRatio,
	);
	return {
		width: Math.round(contentWidth) + WINDOW_PADDING,
		height: Math.round(contentWidth / aspectRatio) + WINDOW_PADDING,
	};
}

function clampBounds(
	x: number,
	y: number,
	size: { width: number; height: number },
	workArea: Rect,
): Rect {
	return {
		x: Math.round(Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - size.width))),
		y: Math.round(Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - size.height))),
		...size,
	};
}

/** Place the complete camera frame just above the bar's right end. */
export function cameraPreviewBounds(workArea: Rect, bar?: Rect): Rect {
	const size = previewSize(
		CAMERA_PREVIEW_DEFAULT_SIZE,
		CAMERA_PREVIEW_DEFAULT_ASPECT_RATIO,
		workArea,
	);
	return clampBounds(
		bar ? bar.x + bar.width - size.width : workArea.x + workArea.width / 2 + 160,
		(bar?.y ?? workArea.y + workArea.height - 84) - size.height - 8,
		size,
		workArea,
	);
}

/** Resize without cropping, retaining the bottom centre and distance from the bar. */
export function resizedCameraPreviewBounds(
	bounds: Rect,
	workArea: Rect,
	width: number,
	aspectRatio = CAMERA_PREVIEW_DEFAULT_ASPECT_RATIO,
): Rect {
	const size = previewSize(width, aspectRatio, workArea);
	return clampBounds(
		bounds.x + (bounds.width - size.width) / 2,
		bounds.y + bounds.height - size.height,
		size,
		workArea,
	);
}
