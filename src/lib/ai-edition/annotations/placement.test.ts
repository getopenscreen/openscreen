import { describe, expect, it } from "vitest";
import type { AxcutAnnotationRegion } from "@/lib/ai-edition/schema";
import {
	convertAnnotationKind,
	fitTextBox,
	type MeasureText,
	measureTextBlock,
	refitFrameAnnotations,
	toFrameSpace,
} from "./placement";

const WIDE = 16 / 9;
// The footage padded in to 80 % of a 16:9 frame, centred.
const FOOTAGE = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };

function region(overrides: Partial<AxcutAnnotationRegion> = {}): AxcutAnnotationRegion {
	return {
		id: "ann1",
		startMs: 0,
		endMs: 1000,
		type: "text",
		content: "Hello",
		position: { x: 35, y: 40 },
		size: { width: 30, height: 20 },
		style: {
			color: "#ffffff",
			backgroundColor: "transparent",
			fontSize: 32,
			fontFamily: "Inter",
			fontWeight: "bold",
			fontStyle: "normal",
			textDecoration: "none",
			textAlign: "center",
			textAnimation: "none",
		},
		zIndex: 1,
		...overrides,
	};
}

const center = (r: Pick<AxcutAnnotationRegion, "position" | "size">) => ({
	x: r.position.x + r.size.width / 2,
	y: r.position.y + r.size.height / 2,
});

/** 100 px wide and 40 px tall per line, whatever the text: the box math, not the font. */
const measure: MeasureText = (content) => ({
	width: 100,
	height: 40 * content.split("\n").length,
});

describe("toFrameSpace", () => {
	it("moves an annotation off the footage without moving it on screen", () => {
		const patch = toFrameSpace(region(), FOOTAGE);
		expect(patch?.space).toBe("frame");
		// 10 % + 35 % of 80 %, and so on: the same pixels, measured on the frame.
		expect(patch?.position?.x).toBeCloseTo(38, 6);
		expect(patch?.position?.y).toBeCloseTo(42, 6);
		expect(patch?.size?.width).toBeCloseTo(24, 6);
		expect(patch?.size?.height).toBeCloseTo(16, 6);
	});

	it("keeps the letters their size: the text size follows the reference box's height", () => {
		// 32 px of an 80 %-high footage is 25.6 px of the frame, rounded.
		expect(toFrameSpace(region(), FOOTAGE)?.style?.fontSize).toBe(26);
	});

	it("leaves a blur on the footage, and an annotation already on the frame alone", () => {
		expect(toFrameSpace(region({ type: "blur" }), FOOTAGE)).toBeNull();
		expect(toFrameSpace(region({ space: "frame" }), FOOTAGE)).toBeNull();
	});
});

describe("fitTextBox", () => {
	it("hugs the text: its width plus the plate's margin, measured against the frame", () => {
		const { size } = fitTextBox(region({ space: "frame" }), WIDE, measure);
		// 100 px + (0.4 em of plate + 0.25 em of slack) × 32, on a 1920-wide reference frame.
		expect(size.width).toBeCloseTo(((100 + 0.65 * 32) / 1920) * 100, 6);
		// 40 px + (0.2 em + 0.125 em) × 32, on 1080.
		expect(size.height).toBeCloseTo(((40 + 0.325 * 32) / 1080) * 100, 6);
	});

	it("keeps the box where it was: its centre does not move", () => {
		const before = region({ space: "frame" });
		const after = fitTextBox(before, WIDE, measure);
		expect(center(after).x).toBeCloseTo(center(before).x, 6);
		expect(center(after).y).toBeCloseTo(center(before).y, 6);
	});

	it("grows with the words and with the size", () => {
		const one = fitTextBox(region({ space: "frame" }), WIDE, measure).size;
		const two = fitTextBox(region({ space: "frame", content: "a\nb" }), WIDE, measure).size;
		expect(two.height).toBeGreaterThan(one.height);
		const big = fitTextBox(
			region({ space: "frame", style: { ...region().style, fontSize: 96 } }),
			WIDE,
			measureTextBlock,
		).size;
		const small = fitTextBox(region({ space: "frame" }), WIDE, measureTextBlock).size;
		expect(big.width / small.width).toBeCloseTo(3, 6);
	});

	it("stays in the frame at its edge, never at a negative position", () => {
		const atEdge = fitTextBox(
			region({ space: "frame", position: { x: 99, y: 99 }, size: { width: 1, height: 1 } }),
			WIDE,
			measure,
		);
		expect(atEdge.position.x + atEdge.size.width).toBeCloseTo(100, 6);
		expect(atEdge.position.y + atEdge.size.height).toBeCloseTo(100, 6);
		const huge = fitTextBox(
			region({ space: "frame", content: "x".repeat(400) }),
			WIDE,
			measureTextBlock,
		);
		expect(huge.size.width).toBeGreaterThan(100);
		expect(huge.position.x).toBe(0);
	});
});

describe("measureTextBlock without a canvas", () => {
	it("counts lines and the longest one", () => {
		const one = measureTextBlock("abcd", region().style);
		const two = measureTextBlock("ab\nabcd", region().style);
		expect(two.width).toBe(one.width);
		expect(two.height).toBe(one.height * 2);
	});
});

describe("convertAnnotationKind", () => {
	const context = { footage: FOOTAGE, frameAspect: WIDE, measure };

	it("puts a blur on the footage, at the default size, where the text was", () => {
		const text = region({
			space: "frame",
			position: { x: 45, y: 45 },
			size: { width: 10, height: 10 },
		});
		const patch = convertAnnotationKind(text, "blur", context);
		expect(patch.type).toBe("blur");
		expect(patch.space).toBeUndefined();
		expect("space" in patch).toBe(true);
		expect(patch.size).toEqual({ width: 30, height: 20 });
		// Centred on the text's centre, (50, 50) on the frame, which is (50, 50) on the footage.
		expect(center({ position: patch.position!, size: patch.size! })).toEqual({ x: 50, y: 50 });
	});

	it("takes a blur back to the frame without moving it on screen", () => {
		const blur = region({ type: "blur", content: "" });
		const patch = convertAnnotationKind(blur, "figure", context);
		expect(patch.space).toBe("frame");
		expect(patch.position?.x).toBeCloseTo(38, 6);
		expect(patch.size?.width).toBeCloseTo(24, 6);
	});

	it("keeps the box between image and arrow, and fits a text to its words", () => {
		const arrow = region({ type: "figure", content: "", space: "frame" });
		const image = convertAnnotationKind(arrow, "image", context);
		expect({ position: image.position, size: image.size }).toEqual({
			position: arrow.position,
			size: arrow.size,
		});
		const text = convertAnnotationKind(arrow, "text", context);
		expect(text.size).toEqual(fitTextBox({ ...arrow, space: "frame" }, WIDE, measure).size);
		expect(center({ position: text.position!, size: text.size! }).x).toBeCloseTo(
			center(arrow).x,
			6,
		);
	});

	it("parks each content in its slot and brings it back", () => {
		const text = region({ space: "frame", content: "hello" });
		const toImage = convertAnnotationKind(text, "image", context);
		expect(toImage).toMatchObject({ textContent: "hello", content: "" });
		const back = convertAnnotationKind(
			{ ...text, ...toImage, content: "data:image/png;base64,AAAA" },
			"text",
			context,
		);
		expect(back).toMatchObject({ content: "hello", imageContent: "data:image/png;base64,AAAA" });
	});

	it("changes only the kind when no footage is known", () => {
		const patch = convertAnnotationKind(region(), "figure", { ...context, footage: null });
		expect(patch).toEqual({ textContent: "Hello", type: "figure", content: "" });
	});

	it("takes a blur off the frame even when no footage is known", () => {
		const text = region({ space: "frame" });
		const patch = convertAnnotationKind(text, "blur", { ...context, footage: null });
		expect(patch.type).toBe("blur");
		expect("space" in patch && patch.space === undefined).toBe(true);
		expect(patch.position).toBeUndefined();
	});
});

describe("refitFrameAnnotations", () => {
	it("keeps each frame annotation's shape and centre across a format change", () => {
		const text = region({
			space: "frame",
			position: { x: 45, y: 40 },
			size: { width: 10, height: 6 },
		});
		const [after] = refitFrameAnnotations([text], WIDE, 9 / 16);
		// A width measured on the frame's height: three times the share of a frame three times
		// narrower in pixels.
		expect(after.size.width).toBeCloseTo(10 * (WIDE / (9 / 16)), 6);
		expect(after.size.height).toBe(6);
		expect(center(after).x).toBeCloseTo(50, 6);
		expect(after.position.y).toBe(40);
	});

	it("shrinks one that no longer fits the frame's width, its text with it", () => {
		const banner = region({
			space: "frame",
			position: { x: 30, y: 40 },
			size: { width: 40, height: 6 },
		});
		const [after] = refitFrameAnnotations([banner], WIDE, 9 / 16);
		// 40 % of a 16:9 frame is 126 % of a 9:16 one: brought back to the full width, around the
		// same centre, and shrunk as a whole.
		const shrink = 100 / (40 * (WIDE / (9 / 16)));
		expect(after.size.width).toBeCloseTo(100, 6);
		expect(after.position.x).toBe(0);
		expect(after.size.height).toBeCloseTo(6 * shrink, 6);
		expect(center(after).y).toBeCloseTo(43, 6);
		// Rounded down, so the words still fit the shrunk box.
		expect(after.style.fontSize).toBe(Math.floor(32 * shrink));
		const image = region({ type: "image", space: "frame", size: { width: 40, height: 6 } });
		expect(refitFrameAnnotations([image], WIDE, 9 / 16)[0].style).toBe(image.style);
	});

	it("leaves the footage's annotations, and an unchanged format, alone", () => {
		const blur = region({ type: "blur" });
		expect(refitFrameAnnotations([blur], WIDE, 1)[0]).toBe(blur);
		const list = [region({ space: "frame" })];
		expect(refitFrameAnnotations(list, WIDE, WIDE)).toBe(list);
	});
});
