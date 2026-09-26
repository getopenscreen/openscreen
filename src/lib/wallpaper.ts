import type { CSSProperties } from "react";
import { getAssetPath } from "@/lib/assetPath";

export const WALLPAPER_COUNT = 18;

// Picker order, by file number. The first is the default; files keep their names so saved
// projects still resolve. 2 sits away from 11, the two look almost alike side by side.
const WALLPAPER_ORDER = [11, 1, 3, 4, 5, 6, 7, 8, 9, 10, 2, 12, 13, 14, 15, 16, 17, 18];

export const WALLPAPER_PATHS: readonly string[] = WALLPAPER_ORDER.map(
	(n) => `/wallpapers/wallpaper${n}.jpg`,
);

// Small (96x96, ~1-3KB: three times the ~30px swatch) pre-generated copies used ONLY for the picker grid's swatches — the
// full-res originals (up to 4+MB, up to 7680px) are what `settings.wallpaper` still stores and
// what actually gets rendered/exported. Without this the grid was decoding all 18 originals
// (~20MB combined) simultaneously just to paint a few dozen px each (reported: picker felt slow
// to load).
export const WALLPAPER_THUMB_PATHS: readonly string[] = WALLPAPER_ORDER.map(
	(n) => `/wallpapers/thumbs/wallpaper${n}.jpg`,
);

export const DEFAULT_WALLPAPER = WALLPAPER_PATHS[0];

export type WallpaperClassification =
	| { kind: "color"; value: string }
	| { kind: "gradient"; value: string }
	| { kind: "image"; path: string };

const GRADIENT_RE = /^(repeating-)?(linear|radial|conic)-gradient\(/;
const COLOR_FUNC_RE = /^(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\(/;
const IMAGE_URL_RE = /^(\/|https?:\/\/|file:\/\/|data:)/;

export function classifyWallpaper(value: string): WallpaperClassification {
	const trimmed = value.trim();
	if (trimmed === "") {
		return { kind: "color", value: "#000000" };
	}
	// Multi-background (e.g. "url(noise), linear-gradient(...)") - peel
	// the gradient layer off so the existing parser can still handle it.
	// Noise/url overlays are lost on export, but the live preview paints
	// the full string via CSS so the overlay shows up there.
	if (trimmed.startsWith("url(")) {
		const gradient = extractTrailingGradient(trimmed);
		if (gradient) return { kind: "gradient", value: gradient };
	}
	if (trimmed.startsWith("#") || COLOR_FUNC_RE.test(trimmed)) {
		return { kind: "color", value: trimmed };
	}
	if (GRADIENT_RE.test(trimmed)) {
		return { kind: "gradient", value: trimmed };
	}
	if (IMAGE_URL_RE.test(trimmed)) {
		return { kind: "image", path: trimmed };
	}
	return { kind: "color", value: trimmed };
}

/**
 * `value` as a CSS background that fills its box, for the preview frame and the camera crop
 * thumbnail. Image wallpapers must go through `resolveImageWallpaperUrl` (→ getAssetPath): in
 * the packaged Electron app the renderer loads over file://, where a bare `/wallpapers/foo.jpg`
 * points at the filesystem root and 404s, so the background silently failed to paint (worked in
 * the http dev server only). An image that does not resolve paints nothing.
 */
export function wallpaperStyle(value: string): CSSProperties {
	const w = classifyWallpaper(value);
	if (w.kind === "color") return { backgroundColor: w.value };
	if (w.kind === "gradient") return { backgroundImage: w.value, backgroundSize: "cover" };
	let url: string;
	try {
		url = resolveImageWallpaperUrl(w.path);
	} catch {
		return {};
	}
	return {
		backgroundImage: `url(${url})`,
		backgroundSize: "cover",
		backgroundPosition: "center",
		backgroundRepeat: "no-repeat",
	};
}

function extractTrailingGradient(value: string): string | null {
	const match = value.match(/,\s*((?:repeating-)?(?:linear|radial|conic)-gradient\(.*\))\s*$/);
	return match?.[1] ?? null;
}

const ALLOWED_IMAGE_PREFIX = "/wallpapers/";

export class UnsafeImagePrefixError extends Error {
	constructor(prefix: string) {
		super(`Image wallpaper path must live under ${prefix}`);
		this.name = "UnsafeImagePrefixError";
	}
}

export function resolveImageWallpaperUrl(imagePath: string): string {
	if (
		imagePath.startsWith("http://") ||
		imagePath.startsWith("https://") ||
		imagePath.startsWith("file://") ||
		imagePath.startsWith("data:")
	) {
		return imagePath;
	}
	const withLeadingSlash = imagePath.startsWith("/") ? imagePath : `/${imagePath}`;
	if (!withLeadingSlash.startsWith(ALLOWED_IMAGE_PREFIX)) {
		throw new BackgroundLoadError(imagePath, new UnsafeImagePrefixError(ALLOWED_IMAGE_PREFIX));
	}
	try {
		return getAssetPath(withLeadingSlash.slice(1));
	} catch (cause) {
		if (cause instanceof BackgroundLoadError) throw cause;
		throw new BackgroundLoadError(imagePath, cause);
	}
}

export class BackgroundLoadError extends Error {
	readonly url: string;
	readonly cause?: unknown;

	constructor(url: string, cause?: unknown) {
		super(`Failed to load background image: ${displayBasename(url)}`);
		this.name = "BackgroundLoadError";
		this.url = url;
		this.cause = cause;
	}

	get displayUrl(): string {
		return displayBasename(this.url);
	}
}

function displayBasename(url: string): string {
	if (url.startsWith("data:")) {
		return "data:…";
	}
	try {
		const parsed = new URL(url);
		const last = parsed.pathname.split("/").filter(Boolean).pop();
		return last ? decodeURIComponent(last) : "(unknown)";
	} catch {
		const last = url.split("/").filter(Boolean).pop();
		return last ?? "(unknown)";
	}
}
