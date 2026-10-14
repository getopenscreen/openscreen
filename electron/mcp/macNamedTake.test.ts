import { describe, expect, it } from "vitest";
import { NAMED_TAKE_NEEDS_SCREEN_ACCESS, namedTakeMayEnumerate } from "./macNamedTake";

describe("namedTakeMayEnumerate", () => {
	it("records the named source when Screen Recording is granted", () => {
		expect(namedTakeMayEnumerate("granted")).toBe(true);
	});

	it("refuses only on a refusal the probe read", () => {
		expect(namedTakeMayEnumerate("denied")).toBe(false);
	});

	it("does not take a probe that could not answer for a refusal", () => {
		for (const status of ["missing-helper", "error", "exited", "timeout"] as const) {
			expect(namedTakeMayEnumerate(status)).toBe(true);
		}
	});

	it("tells the client where the user grants the permission", () => {
		expect(NAMED_TAKE_NEEDS_SCREEN_ACCESS).toContain("Screen & System Audio Recording");
	});
});
