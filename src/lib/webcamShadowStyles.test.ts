import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_APPEARANCE, SETTING_BOUNDS } from "./projectDefaults";
import {
	DEFAULT_WEBCAM_SHADOW_PRESET,
	describeWebcamShadow,
	WEBCAM_SHADOW_BOUNDS,
	WEBCAM_SHADOW_PRESETS,
	type WebcamShadowValues,
	webcamShadowCss,
	webcamShadowPreset,
	webcamShadowPresetPatch,
} from "./webcamShadowStyles";

const within = (value: number, [lo, hi]: readonly [number, number]) => value >= lo && value <= hi;
const preset = (id: Parameters<typeof webcamShadowPreset>[0]) => webcamShadowPreset(id);

describe("webcam shadow presets", () => {
	it("keeps the default preset the shadow every project had before the presets", () => {
		const d = DEFAULT_PROJECT_APPEARANCE;
		expect(webcamShadowPresetPatch(DEFAULT_WEBCAM_SHADOW_PRESET)).toEqual({
			webcamShadowPreset: d.webcamShadowPreset,
			webcamShadowOffsetX: d.webcamShadowOffsetX,
			webcamShadowOffsetY: d.webcamShadowOffsetY,
			webcamShadowBlur: d.webcamShadowBlur,
			webcamShadowSpread: d.webcamShadowSpread,
			webcamShadowOpacity: d.webcamShadowOpacity,
			webcamShadowColor: d.webcamShadowColor,
		});
		// The tuned shadow: 35% black, a 32 px fade, a 12 px drop.
		expect(preset("soft")).toMatchObject({
			offsetY: 12,
			blur: 32,
			opacity: 0.35,
			color: "#000000",
		});
	});

	it("holds the pane's bounds and the stored ones together, and every preset inside them", () => {
		expect(SETTING_BOUNDS.webcamShadowOffset).toEqual(WEBCAM_SHADOW_BOUNDS.offset);
		expect(SETTING_BOUNDS.webcamShadowBlur).toEqual(WEBCAM_SHADOW_BOUNDS.blur);
		expect(SETTING_BOUNDS.webcamShadowSpread).toEqual(WEBCAM_SHADOW_BOUNDS.spread);
		expect(SETTING_BOUNDS.webcamShadowOpacity).toEqual(WEBCAM_SHADOW_BOUNDS.opacity);
		for (const p of WEBCAM_SHADOW_PRESETS) {
			expect(within(p.offsetX, WEBCAM_SHADOW_BOUNDS.offset)).toBe(true);
			expect(within(p.offsetY, WEBCAM_SHADOW_BOUNDS.offset)).toBe(true);
			expect(within(p.blur, WEBCAM_SHADOW_BOUNDS.blur)).toBe(true);
			expect(within(p.spread, WEBCAM_SHADOW_BOUNDS.spread)).toBe(true);
			expect(within(p.opacity, WEBCAM_SHADOW_BOUNDS.opacity)).toBe(true);
			expect(p.color).toMatch(/^#[0-9a-f]{6}$/);
		}
	});

	// One light above the scene: the higher the camera floats, the further and wider its shadow.
	it("drops and widens the shadow as the camera rises", () => {
		const order = (["close", "soft", "lifted", "floating"] as const).map(preset);
		for (let i = 1; i < order.length; i++) {
			expect(order[i].offsetY).toBeGreaterThan(order[i - 1].offsetY);
			expect(order[i].blur).toBeGreaterThan(order[i - 1].blur);
		}
	});

	it("describes a shadow by its preset, edited or not", () => {
		const lifted: WebcamShadowValues = preset("lifted");
		expect(describeWebcamShadow(lifted, "lifted")).toEqual({ preset: "lifted", edited: false });
		// A value that matches a preset is that preset, whatever it was tuned from.
		expect(describeWebcamShadow(lifted, "soft")).toEqual({ preset: "lifted", edited: false });
		expect(describeWebcamShadow({ ...lifted, blur: 60 }, "lifted")).toEqual({
			preset: "lifted",
			edited: true,
		});
		// Saved before the presets, and matching none: nothing pressed, nothing to reset to.
		expect(describeWebcamShadow({ ...preset("soft"), opacity: 0.525 }, null)).toEqual({
			preset: null,
			edited: false,
		});
		// Any invisible shadow is None.
		expect(describeWebcamShadow({ ...lifted, opacity: 0 }, null)).toEqual({
			preset: "none",
			edited: false,
		});
	});

	it("draws the preview as one CSS shadow centred on the native fade", () => {
		expect(webcamShadowCss(preset("soft"), 0.5)).toBe("0px 6px 16px 8px rgb(0 0 0 / 0.35)");
		expect(webcamShadowCss(preset("none"), 1)).toBe("none");
		expect(webcamShadowCss({ ...preset("soft"), color: "nope" }, 1)).toContain("rgb(0 0 0");
	});
});
