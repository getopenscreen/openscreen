/**
 * The picture-in-picture camera's shadow styles. A style is three stored numbers, so a project,
 * the agent or a hand edit can still hold any combination inside `SETTING_BOUNDS`; the pane only
 * offers the combinations below, chosen by what they look like.
 *
 * Every style follows the same light: one soft source above the scene. The higher the camera
 * floats, the further its shadow drops and the wider it spreads, and the lighter its core reads,
 * which is what keeps a large shadow from turning into a dark halo. `ambient` is the exception on
 * purpose: an overcast, almost directionless light that lifts the camera without a drop.
 *
 * - `intensity` is `webcamShadowIntensity`: 0.6 is the historical opacity (35%), and the
 *   compositor scales linearly from it (`frame_geometry.rs`, `WEBCAM_SHADOW_OPACITY`).
 * - `blur` and `distance` multiply the tuned spread (32 px) and drop (12 px), both measured
 *   against a 1080 px frame and scaled with the output.
 *
 * `soft` is exactly the shadow every project had before the styles, and stays the default.
 *
 * Import-free on purpose, like `projectDefaults.ts`.
 */
export type WebcamShadowStyleId = "none" | "close" | "soft" | "lifted" | "floating" | "ambient";

export interface WebcamShadowStyle {
	id: WebcamShadowStyleId;
	intensity: number;
	blur: number;
	distance: number;
}

export const WEBCAM_SHADOW_STYLES: readonly WebcamShadowStyle[] = [
	{ id: "none", intensity: 0, blur: 1, distance: 1 },
	// Resting on the wallpaper: a tight, darker contact shadow (50%, 16 px, 4 px drop).
	{ id: "close", intensity: 0.85, blur: 0.5, distance: 0.35 },
	// The historical default (35%, 32 px, 12 px drop).
	{ id: "soft", intensity: 0.6, blur: 1, distance: 1 },
	// A clear lift off the page (41%, 51 px, 24 px drop).
	{ id: "lifted", intensity: 0.7, blur: 1.6, distance: 2 },
	// High above it: wide and diffuse, so its core stays light (38%, 77 px, 42 px drop).
	{ id: "floating", intensity: 0.65, blur: 2.4, distance: 3.5 },
	// Overcast light: an even glow on every side, almost no drop (29%, 64 px, 3 px drop).
	{ id: "ambient", intensity: 0.5, blur: 2, distance: 0.25 },
];

export const DEFAULT_WEBCAM_SHADOW_STYLE: WebcamShadowStyleId = "soft";

/** The stored fields a style writes, ready to patch into the editor settings. */
export function webcamShadowStylePatch(id: WebcamShadowStyleId): {
	webcamShadowIntensity: number;
	webcamShadowBlur: number;
	webcamShadowDistance: number;
} {
	const style = WEBCAM_SHADOW_STYLES.find((s) => s.id === id) ?? WEBCAM_SHADOW_STYLES[2];
	return {
		webcamShadowIntensity: style.intensity,
		webcamShadowBlur: style.blur,
		webcamShadowDistance: style.distance,
	};
}

const EPSILON = 1e-3;

/**
 * The style the stored values spell, or `null` for a combination no style offers: a project
 * saved with the earlier Light / Strong levels, or one an agent tuned by hand. It keeps
 * rendering exactly as stored; the pane simply shows no style pressed.
 *
 * Any zero intensity is `none`: without opacity the spread and drop draw nothing.
 */
export function matchWebcamShadowStyle(values: {
	webcamShadowIntensity: number;
	webcamShadowBlur: number;
	webcamShadowDistance: number;
}): WebcamShadowStyleId | null {
	if (values.webcamShadowIntensity <= EPSILON) return "none";
	const match = WEBCAM_SHADOW_STYLES.find(
		(s) =>
			s.id !== "none" &&
			Math.abs(s.intensity - values.webcamShadowIntensity) < EPSILON &&
			Math.abs(s.blur - values.webcamShadowBlur) < EPSILON &&
			Math.abs(s.distance - values.webcamShadowDistance) < EPSILON,
	);
	return match?.id ?? null;
}
