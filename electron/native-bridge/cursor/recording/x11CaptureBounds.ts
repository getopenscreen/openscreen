import type { Rectangle } from "electron";

interface DisplayGeometry {
	bounds: Rectangle;
	scaleFactor: number;
}

/** Resolve only an unambiguous portal monitor, never the display under the pointer. */
export function resolveX11CaptureBounds(options: {
	displays: readonly DisplayGeometry[];
	sourceKind?: string;
	origin: { x: number; y: number } | null;
	size: { width: number; height: number } | null;
}): Rectangle | null {
	if (options.sourceKind !== "monitor") return null;
	const { origin, size } = options;
	// The helper does not tag the origin's coordinate space. A nonzero X11
	// pixel origin can coincide with a DIFFERENT monitor's DIP origin at scale
	// > 1. Zero is invariant; otherwise decline rather than guess that monitor.
	if (
		origin &&
		(origin.x !== 0 || origin.y !== 0) &&
		options.displays.some(({ scaleFactor }) => scaleFactor !== 1)
	) {
		return null;
	}
	const matches = options.displays.filter(({ bounds, scaleFactor }) => {
		if (origin) return bounds.x === origin.x && bounds.y === origin.y;
		if (!size) return false;
		// Stream dimensions are pixels; Electron coordinates are DIP. Require a
		// unique match across both representations (including mixed-DPI layouts).
		return (
			(bounds.width === size.width && bounds.height === size.height) ||
			(Math.round(bounds.width * scaleFactor) === size.width &&
				Math.round(bounds.height * scaleFactor) === size.height)
		);
	});
	return matches.length === 1 ? matches[0].bounds : null;
}
