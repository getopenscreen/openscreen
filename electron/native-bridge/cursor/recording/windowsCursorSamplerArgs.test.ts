import { describe, expect, it } from "vitest";
import { buildWindowsCursorSamplerArgs } from "./windowsCursorSamplerArgs";

describe("Windows cursor sampler arguments", () => {
	it("passes one physical bounds snapshot without the unused Electron display id", () => {
		expect(
			buildWindowsCursorSamplerArgs(33, null, {
				x: -2400,
				y: -1350,
				width: 2400,
				height: 1350,
			}),
		).toEqual(["33", "null", "-2400", "-1350", "2400", "1350"]);
	});
});
