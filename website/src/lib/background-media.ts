/** Immutable R2 cut, published before the site points at it. */
export const BACKGROUND_BASE = "https://media.getopenscreen.com/loops/backgrounds/2026-10a";
export const BACKGROUND_WIDTHS = [960, 1920, 2560] as const;
export const BACKGROUND_WALLPAPERS = [2, 5, 8, 11] as const;
export const BACKGROUND_SIZES = "(max-width: 900px) calc(100vw - 36px), 92vw";
export const BACKGROUND_FADE_MS = 550;

export function backgroundSrcSet(index: number, format: "avif" | "webp"): string {
	return BACKGROUND_WIDTHS.map(
		(width) => `${BACKGROUND_BASE}/bg-${index + 1}-${width}.${format} ${width}w`,
	).join(", ");
}

export function backgroundFallback(index: number): string {
	return `/img/walkthrough/canvas-bg-${index + 1}.jpg`;
}
