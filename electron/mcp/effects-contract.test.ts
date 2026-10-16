import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EFFECTS_CONTRACT } from "./effects-contract";

// The compositor's prelude is the authority on what an effect can read; the resource agents read
// must name every field of it, or an agent writes against a contract that is not the real one.
describe("the effect contract resource", () => {
	const shaderFx = readFileSync(
		path.join(__dirname, "../../crates/compositor/src/shader_fx.rs"),
		"utf8",
	);
	const prelude = shaderFx.slice(
		shaderFx.indexOf("pub const PRELUDE_V1"),
		shaderFx.indexOf("@group(0) @binding(0)"),
	);
	const fields = [...prelude.matchAll(/^\s+([a-z_]+): /gm)].map((m) => m[1]);

	it("names every field of the compositor's FxContext", () => {
		expect(fields).toEqual(
			expect.arrayContaining([
				"resolution",
				"time",
				"region",
				"cursor",
				"clicks",
				"footage",
				"camera",
			]),
		);
		for (const field of fields) expect(EFFECTS_CONTRACT).toContain(`ctx.${field}`);
	});

	it("names every helper the prelude gives", () => {
		for (const helper of [
			"frame(uv)",
			"fx_px(n)",
			"fx_hash(p)",
			"fx_to_footage(uv)",
			"fx_from_footage(p)",
		]) {
			expect(EFFECTS_CONTRACT).toContain(helper);
		}
	});
});
