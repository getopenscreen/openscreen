import type {
	AnnotationPosition,
	AnnotationRegion,
	AnnotationSize,
	AnnotationTextStyle,
	AnnotationType,
	FigureData,
	PlaybackSpeed,
	Rotation3DPreset,
	SpeedRegion,
	ZoomDepth,
	ZoomFocus,
	ZoomFocusMode,
	ZoomRegion,
} from "./types";

/** Timeline Region kinds whose attributes can be copied. Trim has no attributes */
export type RegionKind = "zoom" | "speed" | "annotation";

/** ZoomRegion attributes that can be copied */
export interface ZoomAttributes {
	kind: "zoom";
	depth: ZoomDepth;
	customScale?: number;
	focus: ZoomFocus;
	focusMode?: ZoomFocusMode;
	rotationPreset?: Rotation3DPreset;
}

/** SpeedRegion attributes that can be copied */
export interface SpeedAttributes {
	kind: "speed";
	speed: PlaybackSpeed;
}

/** AnnotationRegion attributes that can be copied. Copy captures everything; paste then
 * uses only the styling for an existing region, or the full set for a brand-new one. */
export interface AnnotationAttributes {
	kind: "annotation";
	// Styling — applied both when pasting onto an existing region and onto a new one.
	style: AnnotationTextStyle;
	size: AnnotationSize;
	figureData?: FigureData;
	// Content & placement — used only when pasting as a brand-new region.
	type: AnnotationType;
	content: string;
	textContent?: string;
	imageContent?: string;
	position: AnnotationPosition;
}

export type CopiedRegion = ZoomAttributes | SpeedAttributes | AnnotationAttributes;

export function extractZoomAttributes(region: ZoomRegion): ZoomAttributes {
	return {
		kind: "zoom",
		depth: region.depth,
		customScale: region.customScale,
		focus: { ...region.focus },
		focusMode: region.focusMode,
		rotationPreset: region.rotationPreset,
	};
}

export function extractSpeedAttributes(region: SpeedRegion): SpeedAttributes {
	return { kind: "speed", speed: region.speed };
}

export function extractAnnotationAttributes(region: AnnotationRegion): AnnotationAttributes {
	return {
		kind: "annotation",
		style: { ...region.style },
		size: { ...region.size },
		figureData: region.figureData ? { ...region.figureData } : undefined,
		type: region.type,
		content: region.content,
		textContent: region.textContent,
		imageContent: region.imageContent,
		position: { ...region.position },
	};
}

/** Returns a new region with the copied attributes overwriting its own. Identity and
 * timing (id, startMs, endMs) are preserved; nested objects are deep-copied. */
export function applyZoomAttributes(region: ZoomRegion, attrs: ZoomAttributes): ZoomRegion {
	return {
		...region,
		depth: attrs.depth,
		customScale: attrs.customScale,
		focus: { ...attrs.focus },
		focusMode: attrs.focusMode,
		rotationPreset: attrs.rotationPreset,
	};
}

export function applySpeedAttributes(region: SpeedRegion, attrs: SpeedAttributes): SpeedRegion {
	return { ...region, speed: attrs.speed };
}

/** Pastes onto an EXISTING annotation: only the styling is overwritten — the target keeps
 * its own type, text/image content, position, timing, and stacking order. */
export function applyAnnotationAttributes(
	region: AnnotationRegion,
	attrs: AnnotationAttributes,
): AnnotationRegion {
	return {
		...region,
		style: { ...attrs.style },
		size: { ...attrs.size },
		// Keep the target's own figure data when the copied region has none (e.g. text → figure).
		figureData: attrs.figureData ? { ...attrs.figureData } : region.figureData,
	};
}

/** Builds a BRAND-NEW annotation from a full copy: clones type, content, styling, size,
 * figure data, and position. Identity, timing, and stacking order come from `base`. */
export function buildPastedAnnotation(
	base: Pick<AnnotationRegion, "id" | "startMs" | "endMs" | "zIndex">,
	attrs: AnnotationAttributes,
): AnnotationRegion {
	return {
		...base,
		type: attrs.type,
		content: attrs.content,
		textContent: attrs.textContent,
		imageContent: attrs.imageContent,
		position: { ...attrs.position },
		size: { ...attrs.size },
		style: { ...attrs.style },
		figureData: attrs.figureData ? { ...attrs.figureData } : undefined,
	};
}
