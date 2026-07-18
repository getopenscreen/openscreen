export interface PhysicalPoint {
	x: number;
	y: number;
}

export interface PhysicalBounds extends PhysicalPoint {
	width: number;
	height: number;
}

export interface NormalizedPhysicalPoint {
	x: number;
	y: number;
	withinBounds: boolean;
}

export function resolveWindowsCursorPhysicalBounds(
	sampleBounds: PhysicalBounds | null | undefined,
	readyBounds: PhysicalBounds | null | undefined,
	fallbackDipBounds: PhysicalBounds,
	convertDipToPhysical: (bounds: PhysicalBounds) => PhysicalBounds,
): PhysicalBounds {
	return sampleBounds ?? readyBounds ?? convertDipToPhysical(fallbackDipBounds);
}

/**
 * Normalizes one physical screen-pixel point against a physical capture rect.
 *
 * Keeping both values in the same native coordinate space makes the result
 * independent of Windows' configured scale and of the virtual-screen origin.
 */
export function normalizePhysicalPoint(
	point: PhysicalPoint,
	bounds: PhysicalBounds,
): NormalizedPhysicalPoint {
	const width = Math.max(1, bounds.width);
	const height = Math.max(1, bounds.height);
	const x = (point.x - bounds.x) / width;
	const y = (point.y - bounds.y) / height;

	return {
		x,
		y,
		withinBounds: x >= 0 && x <= 1 && y >= 0 && y <= 1,
	};
}
