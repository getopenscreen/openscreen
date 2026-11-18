import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_APPEARANCE, SETTING_BOUNDS } from "./projectDefaults";
import {
	DEFAULT_WEBCAM_SHADOW_STYLE,
	matchWebcamShadowStyle,
	WEBCAM_SHADOW_STYLES,
	webcamShadowStylePatch,
} from "./webcamShadowStyles";

const within = (value: number, [lo, hi]: readonly [number, number]) => value >= lo && value <= hi;

describe("webcam shadow styles", () => {
	it("keeps the default style the shadow every project had before the styles", () => {
		expect(webcamShadowStylePatch(DEFAULT_WEBCAM_SHADOW_STYLE)).toEqual({
			webcamShadowIntensity: DEFAULT_PROJECT_APPEARANCE.webcamShadowIntensity,
			webcamShadowBlur: DEFAULT_PROJECT_APPEARANCE.webcamShadowBlur,
			webcamShadowDistance: DEFAULT_PROJECT_APPEARANCE.webcamShadowDistance,
		});
		expect(
			matchWebcamShadowStyle({
				webcamShadowIntensity: DEFAULT_PROJECT_APPEARANCE.webcamShadowIntensity,
				webcamShadowBlur: DEFAULT_PROJECT_APPEARANCE.webcamShadowBlur,
				webcamShadowDistance: DEFAULT_PROJECT_APPEARANCE.webcamShadowDistance,
			}),
		).toBe("soft");
	});

	it("stays inside the stored bounds", () => {
		for (const style of WEBCAM_SHADOW_STYLES) {
			expect(within(style.intensity, SETTING_BOUNDS.webcamShadowIntensity)).toBe(true);
			expect(within(style.blur, SETTING_BOUNDS.webcamShadowBlur)).toBe(true);
			expect(within(style.distance, SETTING_BOUNDS.webcamShadowDistance)).toBe(true);
		}
	});

	it("round-trips every style through its stored values", () => {
		for (const style of WEBCAM_SHADOW_STYLES) {
			expect(matchWebcamShadowStyle(webcamShadowStylePatch(style.id))).toBe(style.id);
		}
	});

	// One light above the scene: the higher the camera floats, the further and wider its shadow.
	it("drops and spreads the shadow further as the camera rises", () => {
		const order = ["close", "soft", "lifted", "floating"].map(
			(id) => WEBCAM_SHADOW_STYLES.find((s) => s.id === id)!,
		);
		for (let i = 1; i < order.length; i++) {
			expect(order[i].distance).toBeGreaterThan(order[i - 1].distance);
			expect(order[i].blur).toBeGreaterThan(order[i - 1].blur);
		}
	});

	it("reads any zero intensity as no shadow, and an unknown combination as no style", () => {
		expect(
			matchWebcamShadowStyle({
				webcamShadowIntensity: 0,
				webcamShadowBlur: 3,
				webcamShadowDistance: 0,
			}),
		).toBe("none");
		// The earlier Strong level.
		expect(
			matchWebcamShadowStyle({
				webcamShadowIntensity: 0.9,
				webcamShadowBlur: 1,
				webcamShadowDistance: 1,
			}),
		).toBeNull();
	});
});
