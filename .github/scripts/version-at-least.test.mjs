import { describe, expect, it } from "vitest";
import { versionAtLeast } from "./version-at-least.mjs";

describe("versionAtLeast", () => {
	it("holds for the same version", () => {
		expect(versionAtLeast("2.1.0", "2.1.0")).toBe(true);
	});

	it("holds when main is past the release, so promote never sets it back", () => {
		expect(versionAtLeast("2.1.0", "2.0.1")).toBe(true);
		expect(versionAtLeast("3.0.0", "2.10.0")).toBe(true);
	});

	it("fails when main is behind", () => {
		// v2.1.0's promotion found main at 2.0.0.
		expect(versionAtLeast("2.0.0", "2.1.0")).toBe(false);
		expect(versionAtLeast("2.9.0", "2.10.0")).toBe(false);
	});

	it("puts a prerelease below the release of the same core", () => {
		expect(versionAtLeast("2.1.0-rc.1", "2.1.0")).toBe(false);
		expect(versionAtLeast("2.2.0-rc.1", "2.1.0")).toBe(true);
	});

	it("refuses what is not a version", () => {
		expect(() => versionAtLeast("v2.1.0", "2.1.0")).toThrow(/invalid version/);
	});
});
