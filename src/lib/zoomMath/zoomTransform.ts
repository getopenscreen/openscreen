// Pure zoom geometry for the preview overlay. This module used to also own the
// Pixi camera application (applyZoomTransform + motion-blur filter state); the
// native D3D compositor renders zoom and motion blur now, so those exports had
// no callers and went with the Pixi export path. What is left is the geometry
// the overlay still needs, and it depends on nothing but arithmetic.

import { scaleLerp } from "./mathUtils";

interface AppliedTransform {
	scale: number;
	x: number;
	y: number;
}

interface ZoomTransformGeometry {
	stageSize: { width: number; height: number };
	baseMask: { x: number; y: number; width: number; height: number };
	zoomScale: number;
	zoomProgress?: number;
	focusX: number;
	focusY: number;
}

export function computeZoomTransform({
	stageSize,
	baseMask,
	zoomScale,
	zoomProgress = 1,
	focusX,
	focusY,
}: ZoomTransformGeometry): AppliedTransform {
	if (
		stageSize.width <= 0 ||
		stageSize.height <= 0 ||
		baseMask.width <= 0 ||
		baseMask.height <= 0
	) {
		return { scale: 1, x: 0, y: 0 };
	}

	const progress = Math.min(1, Math.max(0, zoomProgress));
	// Focus coords are stage-normalized (0-1 of full canvas), so map directly to stage pixels, not via baseMask.
	const focusStagePxX = focusX * stageSize.width;
	const focusStagePxY = focusY * stageSize.height;
	const stageCenterX = stageSize.width / 2;
	const stageCenterY = stageSize.height / 2;
	// Log-space scale (`scaleLerp`), while the focus point still travels to the centre linearly
	// on screen — the compositor's trajectory (`zoom_state_in`, crates/compositor/src/regions.rs).
	const scale = scaleLerp(1, zoomScale, progress);

	return {
		scale,
		x: focusStagePxX + (stageCenterX - focusStagePxX) * progress - focusStagePxX * scale,
		y: focusStagePxY + (stageCenterY - focusStagePxY) * progress - focusStagePxY * scale,
	};
}
