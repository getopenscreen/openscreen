import { describe, expect, it } from "vitest";
import { createTextAnnotationRegion, resolveTextAnnotationContent } from "./types";

// Regression coverage for #127: a freshly created text annotation must start with
// truly empty content so the properties panel's placeholder shows and typing
// replaces rather than appends to baked-in text.
describe("createTextAnnotationRegion", () => {
	it("starts with empty content, not a baked-in placeholder string", () => {
		const region = createTextAnnotationRegion({
			id: "annotation-1",
			startMs: 1000,
			endMs: 2000,
			zIndex: 1,
		});

		expect(region.content).toBe("");
		expect(region.type).toBe("text");
	});
});

describe("resolveTextAnnotationContent", () => {
	it("falls back to empty content when no prior text was stored", () => {
		expect(resolveTextAnnotationContent(undefined)).toBe("");
	});

	it("preserves existing text content when converting an existing region to text", () => {
		expect(resolveTextAnnotationContent("hello world")).toBe("hello world");
	});
});
