import { describe, expect, it } from "vitest";
import type { AxcutDocument, AxcutShaderEffect, AxcutShaderEffectRange } from "./schema";
import { createEmptyDocument } from "./schema";
import { withPastedShaderEffect } from "./shaderEffects";

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
