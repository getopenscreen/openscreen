// Pure crop-draft helpers for Edit Clip. The modal stores the rectangle as
// frame fractions (0–1), not rounded integer percents.

export interface CropDraft {
	x: number;
	y: number;
	width: number;
	height: number;
}

export function cropDraftFromRegion(region: CropDraft): CropDraft {
	return { x: region.x, y: region.y, width: region.width, height: region.height };
}

export function cropDraftToPct(draft: CropDraft): { x: number; y: number; w: number; h: number } {
	return {
		x: draft.x * 100,
		y: draft.y * 100,
		w: draft.width * 100,
		h: draft.height * 100,
	};
}

export const PREVIEW_MAX_HEIGHT_PX = 360;

/**
 * Preview box for the crop overlay. The crop rectangle and every drag are
 * measured against THIS element, while the <video> inside it letterboxes via
 * object-fit: contain — so the box must have the video's own aspect ratio or
 * the overlay drifts off the pixels it claims to crop (the old fixed
 * 409x230 box was 16:9 for exactly this reason). Width is therefore derived
 * from the height cap and the aspect: `min(100%, height-cap * aspect)`.
 * Declaring width this way — rather than `width: 100%` plus a max-height —
 * matters because when a max-height clamps an aspect-ratio box, CSS keeps
 * the width and BREAKS the ratio, which would letterbox portrait sources
 * all over again.
 */
export function previewBoxStyle(videoAspectRatio: number): {
	position: "relative";
	width: string;
	aspectRatio: string;
	margin: string;
	flexShrink: number;
	background: string;
	borderRadius: string;
	border: string;
	overflow: "hidden";
} {
	const aspect =
		Number.isFinite(videoAspectRatio) && videoAspectRatio > 0 ? videoAspectRatio : 16 / 9;
	return {
		position: "relative",
		width: `min(100%, calc(${PREVIEW_MAX_HEIGHT_PX}px * ${aspect}))`,
		aspectRatio: `${aspect}`,
		margin: "0 auto 14px",
		flexShrink: 0,
		background: "#0a0b0e",
		borderRadius: "var(--r-md)",
		border: "1px solid var(--border)",
		overflow: "hidden",
	};
}

/** The crop rectangle in percent of the frame (0-100), the unit the dialog edits in. */
export type CropPct = { x: number; y: number; w: number; h: number };

/** Smallest crop side, in percent of the frame, that the handles and the typed fields allow. */
export const MIN_CROP_PCT = 4;

export type CropField = keyof CropPct;

/** The source frame in pixels. */
export interface FrameSize {
	width: number;
	height: number;
}

export const isUsableFrameSize = (frame: FrameSize | null): frame is FrameSize =>
	!!frame &&
	Number.isFinite(frame.width) &&
	Number.isFinite(frame.height) &&
	frame.width > 0 &&
	frame.height > 0;

/** The crop in whole source pixels, as shown in the X / Y / Width / Height fields. */
export function cropPctToPx(crop: CropPct, frame: FrameSize): CropPct {
	return {
		x: Math.round((crop.x / 100) * frame.width),
		y: Math.round((crop.y / 100) * frame.height),
		w: Math.round((crop.w / 100) * frame.width),
		h: Math.round((crop.h / 100) * frame.height),
	};
}

/**
 * `crop` with one field set to a typed pixel value. The value is rounded to a whole pixel
 * and clamped so the crop stays inside the frame and no side drops under MIN_CROP_PCT; the
 * other three fields keep their exact stored values. A value that is not a number leaves the
 * crop as it was.
 */
export function setCropFieldPx(
	crop: CropPct,
	field: CropField,
	px: number,
	frame: FrameSize,
): CropPct {
	if (!Number.isFinite(px)) return crop;
	const horizontal = field === "x" || field === "w";
	const pct = (Math.round(px) / (horizontal ? frame.width : frame.height)) * 100;
	switch (field) {
		case "x":
			return { ...crop, x: Math.min(Math.max(0, 100 - crop.w), Math.max(0, pct)) };
		case "y":
			return { ...crop, y: Math.min(Math.max(0, 100 - crop.h), Math.max(0, pct)) };
		case "w":
			return { ...crop, w: Math.min(100 - crop.x, Math.max(MIN_CROP_PCT, pct)) };
		case "h":
			return { ...crop, h: Math.min(100 - crop.y, Math.max(MIN_CROP_PCT, pct)) };
	}
}

/** The pixel range a field accepts right now: what the stepper and the arrow keys stay within. */
export function cropFieldRangePx(
	crop: CropPct,
	field: CropField,
	frame: FrameSize,
): { min: number; max: number } {
	const horizontal = field === "x" || field === "w";
	const size = horizontal ? frame.width : frame.height;
	const toPx = (pct: number) => Math.round((pct / 100) * size);
	switch (field) {
		case "x":
			return { min: 0, max: toPx(100 - crop.w) };
		case "y":
			return { min: 0, max: toPx(100 - crop.h) };
		case "w":
			return { min: toPx(MIN_CROP_PCT), max: toPx(100 - crop.x) };
		case "h":
			return { min: toPx(MIN_CROP_PCT), max: toPx(100 - crop.y) };
	}
}
