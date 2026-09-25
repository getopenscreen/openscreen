import { describe, expect, it } from "vitest";
import { cropDraftFromRegion, PREVIEW_MAX_HEIGHT_PX, previewBoxStyle } from "./cropDraft";

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
