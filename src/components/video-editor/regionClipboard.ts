import type {
	AnnotationPosition,
	AnnotationRegion,
	AnnotationSize,
	AnnotationTextStyle,
	AnnotationType,
	BlurData,
	FigureData,
	PlaybackSpeed,
	Rotation3DPreset,
	SpeedRegion,
	ZoomDepth,
	ZoomFocus,
	ZoomFocusMode,
	ZoomRegion,
} from "./types";

/** The copyable attributes of each region, tagged with its `kind` so paste can discriminate.
 * Trim has no attributes, so it isn't copyable. */
export type CopiedZoom = {
	kind: "zoom";
	depth: ZoomDepth;
	customScale?: number;
	focus: ZoomFocus;
	focusMode?: ZoomFocusMode;
	rotationPreset?: Rotation3DPreset;
};

export type CopiedSpeed = { kind: "speed"; speed: PlaybackSpeed };

/** Annotation copy captures everything; paste then uses only the styling for an existing
 * region, or the full set for a brand-new one. */
export type CopiedAnnotation = {
	kind: "annotation";
	// Styling — applied both when pasting onto an existing region and onto a new one.
	style: AnnotationTextStyle;
	size: AnnotationSize;
	figureData?: FigureData;
	blurData?: BlurData;
	// Content & placement — used only when pasting as a brand-new region.
	type: AnnotationType;
	content: string;
	textContent?: string;
	imageContent?: string;
	position: AnnotationPosition;
};

export type CopiedRegion = CopiedZoom | CopiedSpeed | CopiedAnnotation;

/** Session clipboard for "copy/paste region attributes" (not undoable, not persisted).
 * Module-level so it's shared regardless of which editor instance copied. */
let clipboard: CopiedRegion | null = null;

export function getCopiedRegion(): CopiedRegion | null {
	return clipboard;
}

export function setCopiedRegion(region: CopiedRegion): void {
	clipboard = region;
}

export function extractZoomAttributes(region: ZoomRegion): CopiedZoom {
	return {
		kind: "zoom",
		depth: region.depth,
		customScale: region.customScale,
		focus: { ...region.focus },
		focusMode: region.focusMode,
		rotationPreset: region.rotationPreset,
	};
}

export function extractSpeedAttributes(region: SpeedRegion): CopiedSpeed {
	return { kind: "speed", speed: region.speed };
}

/** Deep-clones blur data, including its nested freehand points array. */
function cloneBlurData(blurData?: BlurData): BlurData | undefined {
	if (!blurData) return undefined;
	return {
		...blurData,
		freehandPoints: blurData.freehandPoints ? [...blurData.freehandPoints] : undefined,
	};
}

export function extractAnnotationAttributes(region: AnnotationRegion): CopiedAnnotation {
	return {
		kind: "annotation",
		style: { ...region.style },
		size: { ...region.size },
		figureData: region.figureData ? { ...region.figureData } : undefined,
		blurData: cloneBlurData(region.blurData),
		type: region.type,
		content: region.content,
		textContent: region.textContent,
		imageContent: region.imageContent,
		position: { ...region.position },
	};
}

/** Returns a region carrying the copied attributes. Identity, timing, and source come from
 * `base` (so a full region keeps its own); every attribute comes from the copy, with nested
 * objects deep-copied. Passing a stub `base` builds a brand-new region; passing an existing
 * region overwrites ALL its attributes (e.g. a preset-only copy clears the target's customScale). */
export function buildZoomRegion(
	base: Pick<ZoomRegion, "id" | "startMs" | "endMs" | "source">,
	attrs: CopiedZoom,
): ZoomRegion {
	const { kind: _kind, ...zoomAttrs } = attrs;
	return { ...base, ...zoomAttrs, focus: { ...zoomAttrs.focus } };
}

export function buildSpeedRegion(
	base: Pick<SpeedRegion, "id" | "startMs" | "endMs">,
	attrs: CopiedSpeed,
): SpeedRegion {
	return { ...base, speed: attrs.speed };
}

/** Pastes onto an EXISTING annotation: only the styling is overwritten — the target keeps
 * its own type, text/image content, position, timing, and stacking order. */
export function replaceAnnotationAttributes(
	region: AnnotationRegion,
	attrs: CopiedAnnotation,
): AnnotationRegion {
	return {
		...region,
		style: { ...attrs.style },
		size: { ...attrs.size },
		// Only carry figure data onto a figure target; never attach it to a non-figure
		// (e.g. pasting a figure's attributes onto a text annotation keeps the text figure-less).
		figureData:
			region.type === "figure" && attrs.figureData ? { ...attrs.figureData } : region.figureData,
		// Likewise, only carry blur settings onto a blur target.
		blurData:
			region.type === "blur" && attrs.blurData ? cloneBlurData(attrs.blurData) : region.blurData,
	};
}

/** Builds a BRAND-NEW annotation from a full copy: clones type, content, styling, size,
 * figure data, and position. Identity, timing, and stacking order come from `base`. */
export function buildPastedAnnotation(
	base: Pick<AnnotationRegion, "id" | "startMs" | "endMs" | "zIndex">,
	attrs: CopiedAnnotation,
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
		blurData: cloneBlurData(attrs.blurData),
	};
}
