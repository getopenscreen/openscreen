import { describe, expect, it } from "vitest";
import type { GradientEditorState } from "@/components/ui/gradient-editor";
import { buildGradientFromEditor } from "./gradientBuilder";

const baseState = (overrides: Partial<GradientEditorState> = {}): GradientEditorState => ({
	points: [{ id: "main", x: 30, y: 40, color: "rgb(255, 0, 0)" }],
	mainX: 30,
	mainY: 40,
	mainColor: "rgb(255, 0, 0)",
	brightness: 100,
	harmonyType: "splitComplementary",
	...overrides,
});

const threePoints = (brightness: number): GradientEditorState =>
	baseState({
		brightness,
		points: [
			{ id: "main", x: 30, y: 40, color: "rgb(255, 0, 0)" },
			{ id: "o1", x: 70, y: 20, color: "rgb(0, 255, 0)" },
			{ id: "o2", x: 50, y: 80, color: "rgb(0, 0, 255)" },
		],
	});

describe("buildGradientFromEditor", () => {
	it("emits a 3-stop linear gradient at 135deg", () => {
		const css = buildGradientFromEditor(threePoints(100));
		expect(css).toBe(
			"linear-gradient(135deg, rgb(255, 0, 0) 0%, rgb(0, 255, 0) 50%, rgb(0, 0, 255) 100%)",
		);
	});

	it("scales every stop's color with the brightness slider", () => {
		const full = buildGradientFromEditor(threePoints(100));
		const half = buildGradientFromEditor(threePoints(50));
		expect(half).toBe(
			"linear-gradient(135deg, rgb(128, 0, 0) 0%, rgb(0, 128, 0) 50%, rgb(0, 0, 128) 100%)",
		);
		expect(full).not.toBe(half);
	});

	it("handles one and two point states", () => {
		const one = buildGradientFromEditor(baseState({ brightness: 100 }));
		expect(one).toBe("linear-gradient(135deg, rgb(255, 0, 0) 0%, rgb(255, 0, 0) 100%)");

		const two = buildGradientFromEditor(
			baseState({
				brightness: 100,
				points: [
					{ id: "main", x: 30, y: 40, color: "rgb(10, 20, 30)" },
					{ id: "o1", x: 70, y: 20, color: "rgb(40, 50, 60)" },
				],
			}),
		);
		expect(two).toBe(
			"linear-gradient(135deg, rgb(10, 20, 30) 0%, rgb(40, 50, 60) 50%, rgb(40, 50, 60) 100%)",
		);
	});

	it("falls back to a brightness-driven base color when there are no points", () => {
		expect(buildGradientFromEditor(baseState({ points: [], brightness: 0 }))).toBe(
			"hsl(0, 0%, 0%)",
		);
		expect(buildGradientFromEditor(baseState({ points: [], brightness: 100 }))).toBe(
			"hsl(0, 0%, 18%)",
		);
	});
});
