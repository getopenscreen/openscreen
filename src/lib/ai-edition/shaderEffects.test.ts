import { describe, expect, it } from "vitest";
import type { AxcutDocument, AxcutShaderEffect, AxcutShaderEffectRange } from "./schema";
import { createEmptyDocument } from "./schema";
import {
	nativeShaderEffectTrack,
	storedShaderEffectAnimate,
	withPastedShaderEffect,
} from "./shaderEffects";

const definition: AxcutShaderEffect = {
	id: "fx_1",
	name: "Dim",
	description: "",
	contract: 1,
	code: "fn effect(uv: vec2<f32>) -> vec4<f32> { return frame(uv); }",
	params: [],
	origin: "agent",
};
const fragment = (id: string, startMs: number, endMs: number): AxcutShaderEffectRange => ({
	id,
	startMs,
	endMs,
	effectId: "fx_1",
	values: {},
	target: "image",
});
const newId = () => "fx_new";

describe("withPastedShaderEffect", () => {
	const empty: AxcutDocument = createEmptyDocument({ projectId: "p", title: "t" });

	it("recreates the definition in a project that does not have it", () => {
		const next = withPastedShaderEffect(empty, definition, [fragment("fxr_1", 0, 1000)], newId);
		expect(next?.shaderEffects).toEqual([definition]);
		expect(next?.shaderEffectRanges).toHaveLength(1);
	});

	it("reuses the definition the project already has, and refuses a paste onto an effect", () => {
		const doc = withPastedShaderEffect(
			empty,
			definition,
			[fragment("fxr_1", 0, 1000)],
			newId,
		) as AxcutDocument;
		const again = withPastedShaderEffect(doc, definition, [fragment("fxr_2", 2000, 3000)], newId);
		expect(again?.shaderEffects).toHaveLength(1);
		expect(again?.shaderEffectRanges).toHaveLength(2);
		expect(
			withPastedShaderEffect(doc, definition, [fragment("fxr_3", 500, 1500)], newId),
		).toBeNull();
	});

	it("gives the paste its own id when the project holds another effect under that one", () => {
		const doc = withPastedShaderEffect(
			empty,
			definition,
			[fragment("fxr_1", 0, 1000)],
			newId,
		) as AxcutDocument;
		// Copied, then edited on the other side: same id, other code.
		const edited = { ...definition, code: definition.code.replace("frame(uv)", "frame(uv) * 0.5") };
		const next = withPastedShaderEffect(doc, edited, [fragment("fxr_2", 2000, 3000)], newId);
		expect(next?.shaderEffects?.map((e) => [e.id, e.code])).toEqual([
			["fx_1", definition.code],
			["fx_new", edited.code],
		]);
		expect(next?.shaderEffectRanges?.map((r) => r.effectId)).toEqual(["fx_1", "fx_new"]);
	});
});

describe("storedShaderEffectAnimate", () => {
	const params: AxcutShaderEffect["params"] = [
		{ type: "number", name: "level", label: "", default: 1, min: 0, max: 2 },
		{ type: "point", name: "at", label: "", default: { x: 0.5, y: 0.5 } },
	];

	it("sorts each track by atSec and clamps its values like plain values", () => {
		const stored = storedShaderEffectAnimate(
			{ params },
			{
				level: [
					{ atSec: 2, value: 9, ease: "ease-out" },
					{ atSec: 0, value: -1 },
				],
				at: [{ atSec: 1, value: { x: 1.5, y: 0.2 } }],
			},
		);
		expect(stored).toEqual({
			animate: {
				level: [
					{ atSec: 0, value: 0 },
					{ atSec: 2, value: 2, ease: "ease-out" },
				],
				at: [{ atSec: 1, value: { x: 1, y: 0.2 } }],
			},
		});
	});

	it("drops an empty track, and leaves nothing when no track is left", () => {
		expect(storedShaderEffectAnimate({ params }, { level: [] })).toEqual({ animate: undefined });
	});

	it("refuses a name the effect does not declare, listing the declared ones", () => {
		const refused = storedShaderEffectAnimate({ params }, { strength: [{ atSec: 0, value: 1 }] });
		expect(refused).toEqual({ error: expect.stringContaining('"strength"') });
		expect((refused as { error: string }).error).toContain("Declared: level, at.");
	});

	it("refuses a keyframe value of the wrong type, naming the keyframe and the type", () => {
		const refused = storedShaderEffectAnimate(
			{ params },
			{
				level: [
					{ atSec: 0, value: 1 },
					{ atSec: 1, value: "#ffffff" },
				],
			},
		);
		expect((refused as { error: string }).error).toMatch(/animate\.level\[1\].*a number/);
	});
});

describe("nativeShaderEffectTrack", () => {
	const level: AxcutShaderEffect["params"][number] = {
		type: "number",
		name: "level",
		label: "",
		default: 1,
		min: 0,
		max: 2,
	};

	it("turns named easings into bezier curves and passes the others as the compositor reads them", () => {
		expect(
			nativeShaderEffectTrack(level, [
				{ atSec: 0, value: 0 },
				{ atSec: 1, value: 1, ease: "linear" },
				{ atSec: 2, value: 1, ease: "ease-in" },
				{ atSec: 3, value: 1, ease: "ease-out" },
				{ atSec: 4, value: 1, ease: "ease-in-out" },
				{ atSec: 5, value: 1, ease: [0.1, 0.2, 0.3, 1.4] },
				{ atSec: 6, value: 1, ease: { spring: { bounce: 0.3 } } },
				{ atSec: 7, value: 5, ease: "hold" },
			]),
		).toEqual([
			{ atSec: 0, value: 0 },
			{ atSec: 1, value: 1, bezier: [0, 0, 1, 1] },
			{ atSec: 2, value: 1, bezier: [0.42, 0, 1, 1] },
			{ atSec: 3, value: 1, bezier: [0, 0, 0.58, 1] },
			{ atSec: 4, value: 1, bezier: [0.42, 0, 0.58, 1] },
			{ atSec: 5, value: 1, bezier: [0.1, 0.2, 0.3, 1.4] },
			{ atSec: 6, value: 1, spring: 0.3 },
			{ atSec: 7, value: 2, hold: true },
		]);
	});

	it("makes a toggle hold whatever its ease", () => {
		const toggle = { type: "toggle" as const, name: "on", label: "", default: false };
		expect(
			nativeShaderEffectTrack(toggle, [
				{ atSec: 0, value: false, ease: "ease-in" },
				{ atSec: 1, value: true },
			]),
		).toEqual([
			{ atSec: 0, value: 0, hold: true },
			{ atSec: 1, value: 1, hold: true },
		]);
	});
});
