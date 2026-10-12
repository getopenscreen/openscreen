// A clip's main picture can be turned by 180° (a desk camera mounted upside down, an
// imported video filmed the wrong way up). Absent means upright; 0 is never stored.
export type ClipRotation = 0 | 180;

export function clipRotation(clip: { rotation?: 180 }): ClipRotation {
	return clip.rotation === 180 ? 180 : 0;
}

// The same rectangle seen on the turned picture. Crops are stored in source coordinates;
// anything that shows or edits them on the turned picture goes through this, both ways.
export function turnCropRegion<T extends { x: number; y: number; width: number; height: number }>(
	r: T,
): T {
	return { ...r, x: 1 - r.x - r.width, y: 1 - r.y - r.height };
}
