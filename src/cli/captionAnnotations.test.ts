import { describe, expect, it } from "vitest";
import { DEFAULT_CAPTION_SETTINGS } from "@/lib/ai-edition/captions/settings";
import type { CaptionSegment } from "@/lib/captioning/transcribe";
import { captionSegmentsToAnnotationRegions } from "./captionAnnotations";

const words = (...texts: string[]): CaptionSegment[] =>
	texts.map((text, i) => ({ text, startSec: i * 0.5, endSec: i * 0.5 + 0.4 }));

describe("captionSegmentsToAnnotationRegions", () => {
	it("numbers ids and z-indexes from the given start, with non-empty spans", () => {
		const regions = captionSegmentsToAnnotationRegions(words("one", "two", "three", "four"), 7, 3);

		expect(regions.length).toBeGreaterThan(0);
		expect(regions.map((r) => r.id)).toEqual(regions.map((_, i) => `annotation-${7 + i}`));
		expect(regions.map((r) => r.zIndex)).toEqual(regions.map((_, i) => 3 + i));
		for (const region of regions) {
			expect(region.endMs).toBeGreaterThan(region.startMs);
			expect(region.annotationSource).toBe("auto-caption");
			expect(region.content.trim()).not.toBe("");
		}
	});

	it("groups phrase-granularity segments one line at a time", () => {
		const regions = captionSegmentsToAnnotationRegions(
			[
				{ text: "hello there", startSec: 0, endSec: 1 },
				{ text: "second line", startSec: 1.2, endSec: 2 },
			],
			1,
			1,
			{ timestampGranularity: "phrase" },
		);

		expect(regions.map((r) => r.content)).toEqual(["hello there", "second line"]);
	});

	it("looks like the editor's captions, not a faint annotation", () => {
		const [region] = captionSegmentsToAnnotationRegions(words("one", "two"), 1, 1);
		expect(region.style).toMatchObject({
			fontSize: DEFAULT_CAPTION_SETTINGS.fontSize,
			fontWeight: DEFAULT_CAPTION_SETTINGS.fontWeight,
			color: DEFAULT_CAPTION_SETTINGS.color,
			backgroundColor: "rgba(0, 0, 0, 0.55)",
		});
		// The editor's caption box: 16:9 safe column, bottom edge 1.5% off the frame's, room for
		// a caption that wraps. The text is bottom-anchored in it (see sceneDescription).
		expect(region.position.x).toBe(16);
		expect(region.size.width).toBe(68);
		expect(region.position.y + region.size.height).toBeCloseTo(98.5);
		// Three 48 px lines of 1.5 em plus the plate padding: a wrapped caption is not clipped.
		expect(region.size.height).toBeCloseTo(((48 * (3 * 1.5 + 0.2)) / 1080) * 100);
	});
});
