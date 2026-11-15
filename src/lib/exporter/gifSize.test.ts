import { describe, expect, it } from "vitest";
import { gifPresetDims, gifSizeChoices } from "./gifSize";

describe("gifPresetDims", () => {
	it("caps the height and keeps both sides even", () => {
		expect(gifPresetDims("small", { width: 1920, height: 1080 })).toEqual({
			width: 852,
			height: 480,
		});
	});

	it("never upscales", () => {
		expect(gifPresetDims("large", { width: 584, height: 360 })).toEqual({
			width: 584,
			height: 360,
		});
	});
});

describe("gifSizeChoices", () => {
	// v2.3.0-rc.1 e2e (macOS D2): every preset wrote the same 584x360 file under its own label.
	it("offers one choice when the source is below every cap", () => {
		expect(gifSizeChoices({ width: 584, height: 360 })).toEqual([
			{ preset: "original", dims: { width: 584, height: 360 } },
		]);
	});

	it("folds presets that write the same file into the largest one", () => {
		expect(gifSizeChoices({ width: 1920, height: 1080 }).map((c) => c.preset)).toEqual([
			"small",
			"medium",
			"original",
		]);
		expect(gifSizeChoices({ width: 2560, height: 1440 }).map((c) => c.preset)).toEqual([
			"small",
			"medium",
			"large",
			"original",
		]);
	});
});
