import { describe, expect, it } from "vitest";
import {
	type CropPct,
	cropDraftFromRegion,
	cropFieldRangePx,
	cropPctToPx,
	isUsableFrameSize,
	MIN_CROP_PCT,
	PREVIEW_MAX_HEIGHT_PX,
	previewBoxStyle,
	setCropFieldPx,
} from "./cropDraft";

describe("crop draft helpers", () => {
	it("gives the preview box the video's own aspect ratio", () => {
		// The overlay and every drag are measured against the box while the
		// video letterboxes inside it — any box/video aspect mismatch shifts
		// the crop off the pixels it claims to select.
		for (const aspect of [16 / 9, 784 / 1082, 21 / 9]) {
			const style = previewBoxStyle(aspect);
			expect(style.aspectRatio).toBe(`${aspect}`);
			// Width is derived from the height cap so a clamped height can
			// never silently break the ratio (CSS keeps width and drops the
			// ratio when max-height wins).
			expect(style.width).toBe(`min(100%, calc(${PREVIEW_MAX_HEIGHT_PX}px * ${aspect}))`);
		}
	});

	it("falls back to 16:9 while the video metadata has not loaded", () => {
		for (const bogus of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(previewBoxStyle(bogus).aspectRatio).toBe(`${16 / 9}`);
		}
	});

	it("stores the draft as unrounded fractions", () => {
		const draft = cropDraftFromRegion({ x: 1 / 3, y: 0.1, width: 0.5, height: 0.8 });
		expect(draft.x).toBe(1 / 3);
		expect(draft.x).not.toBe(33);
	});
});

describe("crop pixel fields", () => {
	const frame = { width: 1920, height: 1080 };
	const crop: CropPct = { x: 10, y: 20, w: 50, h: 40 };

	it("converts the percent crop to whole source pixels", () => {
		expect(cropPctToPx(crop, frame)).toEqual({ x: 192, y: 216, w: 960, h: 432 });
		expect(cropPctToPx({ x: 0, y: 0, w: 100, h: 100 }, frame)).toEqual({
			x: 0,
			y: 0,
			w: 1920,
			h: 1080,
		});
	});

	it("rounds fractional pixels to the nearest pixel", () => {
		const px = cropPctToPx({ x: 33.333, y: 0, w: 33.333, h: 100 }, frame);
		expect(px.x).toBe(640);
		expect(px.w).toBe(640);
	});

	it("round-trips a typed pixel value through the stored percent", () => {
		for (const [field, value] of [
			["x", 123],
			["y", 77],
			["w", 801],
			["h", 333],
		] as const) {
			const next = setCropFieldPx(crop, field, value, frame);
			expect(cropPctToPx(next, frame)[field]).toBe(value);
		}
	});

	it("changes only the field that was typed into", () => {
		const next = setCropFieldPx(crop, "w", 1000, frame);
		expect(next).toEqual({ ...crop, w: (1000 / 1920) * 100 });
	});

	it("keeps the crop inside the frame", () => {
		// x can move up to the point where the right edge meets the frame.
		expect(setCropFieldPx(crop, "x", 5000, frame).x).toBe(50);
		expect(setCropFieldPx(crop, "x", -40, frame).x).toBe(0);
		expect(setCropFieldPx(crop, "y", 5000, frame).y).toBe(60);
		// Width and height can grow only to the frame edge from where the crop starts.
		expect(setCropFieldPx(crop, "w", 5000, frame).w).toBe(90);
		expect(setCropFieldPx(crop, "h", 5000, frame).h).toBe(80);
	});

	it("does not let a side shrink below the minimum", () => {
		expect(setCropFieldPx(crop, "w", 0, frame).w).toBe(MIN_CROP_PCT);
		expect(setCropFieldPx(crop, "h", -5, frame).h).toBe(MIN_CROP_PCT);
	});

	it("ignores a value that is not a number", () => {
		expect(setCropFieldPx(crop, "x", Number.NaN, frame)).toBe(crop);
		expect(setCropFieldPx(crop, "w", Number.POSITIVE_INFINITY, frame)).toBe(crop);
	});

	it("rounds a typed decimal to a whole pixel", () => {
		const next = setCropFieldPx(crop, "x", 100.4, frame);
		expect(cropPctToPx(next, frame).x).toBe(100);
	});

	it("reports the range each field accepts, matching what the setter allows", () => {
		expect(cropFieldRangePx(crop, "x", frame)).toEqual({ min: 0, max: 960 });
		expect(cropFieldRangePx(crop, "y", frame)).toEqual({ min: 0, max: 648 });
		expect(cropFieldRangePx(crop, "w", frame)).toEqual({ min: 77, max: 1728 });
		expect(cropFieldRangePx(crop, "h", frame)).toEqual({ min: 43, max: 864 });
		for (const field of ["x", "y", "w", "h"] as const) {
			const { min, max } = cropFieldRangePx(crop, field, frame);
			expect(cropPctToPx(setCropFieldPx(crop, field, max, frame), frame)[field]).toBe(max);
			expect(cropPctToPx(setCropFieldPx(crop, field, min, frame), frame)[field]).toBe(min);
		}
	});

	it("only trusts a frame size with real dimensions", () => {
		expect(isUsableFrameSize(frame)).toBe(true);
		expect(isUsableFrameSize(null)).toBe(false);
		expect(isUsableFrameSize({ width: 0, height: 1080 })).toBe(false);
		expect(isUsableFrameSize({ width: 1920, height: Number.NaN })).toBe(false);
	});
});
