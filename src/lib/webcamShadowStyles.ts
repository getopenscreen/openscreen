/**
 * The picture-in-picture camera's drop shadow: a preset to start from, and five values to tune
 * from there. Lengths are pixels at a 1080 px frame, like every other length a user sees; the
 * scene turns them into fractions (`sceneDescription.ts`) and the compositor scales them to the
 * output, so a 4K export carries the same shadow as the preview.
 *
 * - `offsetX` / `offsetY`: where the shadow falls, away from its light.
 * - `blur`: how far the penumbra fades, from the camera's edge outward.
 * - `spread`: grows (or, negative, shrinks) the shape before it fades. A negative spread under a
 *   wide blur is what keeps a high shadow from reading as a dark halo.
 * - `opacity`: the shadow's darkest point, right under the camera.
 * - `color`: `#rrggbb`. Ink rather than pure black reads more natural on a coloured wallpaper.
 *
 * Import-free on purpose, like `projectDefaults.ts`: the main process reads it too.
 */
export type WebcamShadowPresetId = "none" | "close" | "soft" | "lifted" | "floating" | "ambient";

export interface WebcamShadowValues {
	offsetX: number;
	offsetY: number;
	blur: number;
	spread: number;
	opacity: number;
	color: string;
}

export interface WebcamShadowPreset extends WebcamShadowValues {
	id: WebcamShadowPresetId;
}

/** The ranges every stored value is clamped into. `WEBCAM_SHADOW_*_RANGE` in
 *  crates/compositor/src/frame_geometry.rs holds the native side to the same. */
export const WEBCAM_SHADOW_BOUNDS = {
	offset: [-80, 80],
	blur: [0, 120],
	spread: [-40, 40],
	opacity: [0, 1],
} as const;

/**
 * Every preset follows one soft light above the scene: the higher the camera floats, the further
 * its shadow drops, the wider it fades and the lighter its core. `ambient` is the overcast
 * exception, an even glow with no drop.
 */
export const WEBCAM_SHADOW_PRESETS: readonly WebcamShadowPreset[] = [
	{ id: "none", offsetX: 0, offsetY: 0, blur: 0, spread: 0, opacity: 0, color: "#000000" },
	// Resting on the wallpaper: a short, darker contact shadow.
	{ id: "close", offsetX: 0, offsetY: 4, blur: 14, spread: 0, opacity: 0.5, color: "#0b1220" },
	// The shadow every project had before the presets, value for value.
	{ id: "soft", offsetX: 0, offsetY: 12, blur: 32, spread: 0, opacity: 0.35, color: "#000000" },
	{ id: "lifted", offsetX: 0, offsetY: 22, blur: 52, spread: -4, opacity: 0.4, color: "#0b1220" },
	// High above it: the shrunk shape keeps the core light under a very wide fade.
	{
		id: "floating",
		offsetX: 0,
		offsetY: 40,
		blur: 88,
		spread: -14,
		opacity: 0.38,
		color: "#0b1220",
	},
	{ id: "ambient", offsetX: 0, offsetY: 2, blur: 64, spread: 4, opacity: 0.24, color: "#0b1220" },
];

export const DEFAULT_WEBCAM_SHADOW_PRESET: WebcamShadowPresetId = "soft";

/** Colours that read as a shadow, in the colour picker: neutral inks first, then tinted ones,
 *  then white, which casts a glow on a dark wallpaper. */
export const WEBCAM_SHADOW_COLORS: readonly string[] = [
	"#000000",
	"#0b1220",
	"#334155",
	"#3b2414",
	"#1e1b4b",
	"#052e2b",
	"#4c0519",
	"#ffffff",
];

export function webcamShadowPreset(id: WebcamShadowPresetId): WebcamShadowPreset {
	return (
		WEBCAM_SHADOW_PRESETS.find((p) => p.id === id) ??
		(WEBCAM_SHADOW_PRESETS.find((p) => p.id === DEFAULT_WEBCAM_SHADOW_PRESET) as WebcamShadowPreset)
	);
}

export function isWebcamShadowPresetId(value: unknown): value is WebcamShadowPresetId {
	return typeof value === "string" && WEBCAM_SHADOW_PRESETS.some((p) => p.id === value);
}

/** The stored fields a preset writes, ready to patch into the editor settings. */
export function webcamShadowPresetPatch(id: WebcamShadowPresetId) {
	const { offsetX, offsetY, blur, spread, opacity, color } = webcamShadowPreset(id);
	return {
		webcamShadowPreset: id,
		webcamShadowOffsetX: offsetX,
		webcamShadowOffsetY: offsetY,
		webcamShadowBlur: blur,
		webcamShadowSpread: spread,
		webcamShadowOpacity: opacity,
		webcamShadowColor: color,
	};
}

const EPSILON = 1e-3;

/** Whether two shadows draw the same thing. Any two invisible shadows are equal. */
export function sameWebcamShadow(a: WebcamShadowValues, b: WebcamShadowValues): boolean {
	if (a.opacity <= EPSILON && b.opacity <= EPSILON) return true;
	return (
		Math.abs(a.offsetX - b.offsetX) < EPSILON &&
		Math.abs(a.offsetY - b.offsetY) < EPSILON &&
		Math.abs(a.blur - b.blur) < EPSILON &&
		Math.abs(a.spread - b.spread) < EPSILON &&
		Math.abs(a.opacity - b.opacity) < EPSILON &&
		a.color.toLowerCase() === b.color.toLowerCase()
	);
}

/**
 * What the pane shows for a stored shadow:
 * - `preset` is the preset tile to press: the one the values match, else the one they were
 *   tuned from (`base`), else none (a project from before the presets, tuned another way);
 * - `edited` is true when the values have moved off that preset.
 */
export function describeWebcamShadow(
	values: WebcamShadowValues,
	base: WebcamShadowPresetId | null,
): { preset: WebcamShadowPresetId | null; edited: boolean } {
	if (base && sameWebcamShadow(values, webcamShadowPreset(base))) {
		return { preset: base, edited: false };
	}
	const match = WEBCAM_SHADOW_PRESETS.find((p) => sameWebcamShadow(values, p));
	if (match) return { preset: match.id, edited: false };
	return { preset: base, edited: base !== null };
}

/**
 * The shadow as CSS `box-shadow`, at `scale` of its 1080 px size, for the pane's previews.
 *
 * The compositor's penumbra is full strength at the camera's edge and gone `blur` px further
 * out; a CSS blur is a Gaussian whose half-strength line sits on the edge. Pushing the CSS
 * spread out by half the blur puts that line halfway through the native fade, which is as close
 * as one CSS shadow gets to it.
 */
export function webcamShadowCss(values: WebcamShadowValues, scale: number): string {
	if (values.opacity <= EPSILON) return "none";
	const hex = /^#[0-9a-f]{6}$/i.test(values.color) ? values.color : "#000000";
	const r = Number.parseInt(hex.slice(1, 3), 16);
	const g = Number.parseInt(hex.slice(3, 5), 16);
	const b = Number.parseInt(hex.slice(5, 7), 16);
	const px = (n: number) => `${Math.round(n * scale * 100) / 100}px`;
	return `${px(values.offsetX)} ${px(values.offsetY)} ${px(values.blur)} ${px(values.spread + values.blur / 2)} rgb(${r} ${g} ${b} / ${values.opacity})`;
}
