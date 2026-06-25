import { describe, expect, it } from "vitest";
import {
	applyAnnotationAttributes,
	applySpeedAttributes,
	applyZoomAttributes,
	buildPastedAnnotation,
	extractAnnotationAttributes,
	extractSpeedAttributes,
	extractZoomAttributes,
} from "./regionClipboard";
import {
	type AnnotationRegion,
	DEFAULT_ANNOTATION_POSITION,
	DEFAULT_ANNOTATION_SIZE,
	DEFAULT_ANNOTATION_STYLE,
	DEFAULT_FIGURE_DATA,
	type SpeedRegion,
	type ZoomRegion,
} from "./types";

const zoom: ZoomRegion = {
	id: "zoom-1",
	startMs: 1000,
	endMs: 3000,
	depth: 4,
	customScale: 2.75,
	focus: { cx: 0.2, cy: 0.8 },
	focusMode: "manual",
	rotationPreset: "iso",
	source: "manual",
};

const speed: SpeedRegion = { id: "speed-1", startMs: 0, endMs: 500, speed: 2 };

const annotation: AnnotationRegion = {
	id: "annotation-1",
	startMs: 0,
	endMs: 2000,
	type: "figure",
	content: "hello",
	position: { x: 10, y: 90 },
	size: { width: 40, height: 25 },
	style: { ...DEFAULT_ANNOTATION_STYLE, color: "#ff0000", textAnimation: "pop" },
	zIndex: 3,
	figureData: { ...DEFAULT_FIGURE_DATA, color: "#123456" },
};

describe("zoom attribute copy/paste", () => {
	it("round-trips the copyable attributes onto a different clip while keeping its identity/timing", () => {
		const attrs = extractZoomAttributes(zoom);
		const target: ZoomRegion = {
			id: "zoom-2",
			startMs: 9000,
			endMs: 9500,
			depth: 1,
			focus: { cx: 0.5, cy: 0.5 },
			source: "manual",
		};
		const result = applyZoomAttributes(target, attrs);

		expect(result.id).toBe("zoom-2");
		expect(result.startMs).toBe(9000);
		expect(result.endMs).toBe(9500);
		expect(result.depth).toBe(4);
		expect(result.customScale).toBe(2.75);
		expect(result.focus).toEqual({ cx: 0.2, cy: 0.8 });
		expect(result.focusMode).toBe("manual");
		expect(result.rotationPreset).toBe("iso");
	});

	it("deep-copies focus so the source and target are decoupled", () => {
		const attrs = extractZoomAttributes(zoom);
		const result = applyZoomAttributes({ ...zoom, id: "zoom-2" }, attrs);
		result.focus.cx = 0.99;
		expect(zoom.focus.cx).toBe(0.2);
	});
});

describe("speed attribute copy/paste", () => {
	it("copies only the speed value", () => {
		const attrs = extractSpeedAttributes(speed);
		const target: SpeedRegion = { id: "speed-2", startMs: 4000, endMs: 5000, speed: 1 };
		const result = applySpeedAttributes(target, attrs);
		expect(result).toEqual({ id: "speed-2", startMs: 4000, endMs: 5000, speed: 2 });
	});
});

describe("annotation copy captures everything", () => {
	it("captures styling plus content, type, and position", () => {
		const attrs = extractAnnotationAttributes(annotation);
		expect(attrs.type).toBe("figure");
		expect(attrs.content).toBe("hello");
		expect(attrs.position).toEqual({ x: 10, y: 90 });
		expect(attrs.style.color).toBe("#ff0000");
		expect(attrs.figureData?.color).toBe("#123456");
	});
});

describe("paste onto an existing annotation applies styling only", () => {
	it("overwrites the look/feel but keeps the target's content, position, timing, and zIndex", () => {
		const attrs = extractAnnotationAttributes(annotation);
		const target: AnnotationRegion = {
			id: "annotation-2",
			startMs: 7000,
			endMs: 8000,
			type: "text",
			content: "world",
			position: { ...DEFAULT_ANNOTATION_POSITION },
			size: { ...DEFAULT_ANNOTATION_SIZE },
			style: { ...DEFAULT_ANNOTATION_STYLE },
			zIndex: 9,
		};
		const result = applyAnnotationAttributes(target, attrs);

		expect(result.content).toBe("world");
		expect(result.position).toEqual(DEFAULT_ANNOTATION_POSITION);
		expect(result.startMs).toBe(7000);
		expect(result.zIndex).toBe(9);
		expect(result.style.color).toBe("#ff0000");
		expect(result.style.textAnimation).toBe("pop");
		expect(result.size).toEqual({ width: 40, height: 25 });
		expect(result.figureData?.color).toBe("#123456");
	});

	it("keeps the target's own figure data when the copied region has none", () => {
		const textAttrs = extractAnnotationAttributes({ ...annotation, figureData: undefined });
		const figureTarget: AnnotationRegion = { ...annotation, id: "annotation-3" };
		const result = applyAnnotationAttributes(figureTarget, textAttrs);
		expect(result.figureData?.color).toBe("#123456");
	});
});

describe("paste as a new annotation clones the full copy", () => {
	it("clones type, content, styling, and position; takes timing/identity from the base", () => {
		const attrs = extractAnnotationAttributes(annotation);
		const result = buildPastedAnnotation(
			{ id: "annotation-4", startMs: 12000, endMs: 14000, zIndex: 5 },
			attrs,
		);

		expect(result.id).toBe("annotation-4");
		expect(result.startMs).toBe(12000);
		expect(result.endMs).toBe(14000);
		expect(result.zIndex).toBe(5);
		expect(result.type).toBe("figure");
		expect(result.content).toBe("hello");
		expect(result.position).toEqual({ x: 10, y: 90 });
		expect(result.style.color).toBe("#ff0000");
		expect(result.figureData?.color).toBe("#123456");
	});

	it("deep-copies position so source and clone are decoupled", () => {
		const attrs = extractAnnotationAttributes(annotation);
		const result = buildPastedAnnotation(
			{ id: "annotation-5", startMs: 0, endMs: 1000, zIndex: 1 },
			attrs,
		);
		result.position.x = 99;
		expect(annotation.position.x).toBe(10);
	});
});
