import { expect, it } from "vitest";
import { parseArgs } from "../cli";

it("accepts explicit response byte bounds without increasing defaults", () => {
	expect(parseArgs(["run"]).maxResponseBytes).toBeUndefined();
	expect(parseArgs(["run", "--max-response-bytes", "4194304"]).maxResponseBytes).toBe(4194304);
	for (const value of ["0", "-1", "1.5", "NaN"]) {
		expect(() => parseArgs(["run", "--max-response-bytes", value])).toThrow(/max-response-bytes/);
	}
});
