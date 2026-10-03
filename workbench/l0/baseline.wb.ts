import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { baselineBinding, baselineFromRun, readBaseline } from "../lib/baseline";

const DIRECTORY = mkdtempSync(join(tmpdir(), "wb-baseline-binding-"));

afterAll(() => rmSync(DIRECTORY, { recursive: true, force: true }));

describe("legacy baseline binding", () => {
	it("keeps historical check-id ratchets while labelling their numbers unbound", () => {
		const file = join(DIRECTORY, "legacy.json");
		writeFileSync(
			file,
			JSON.stringify({
				scenario: "legacy",
				expectedFailures: ["beh.known"],
				behaviour: 0.5,
				dsl: 1,
				recordedAt: "2026-07-31",
			}),
			"utf8",
		);
		const baseline = readBaseline(file);
		expect(baseline?.expectedFailures).toEqual(["beh.known"]);
		expect(baseline && baselineBinding(baseline)).toBe("legacy-unbound");
	});

	it("marks newly written check-id ratchets as legacy/unbound too", () => {
		const baseline = baselineFromRun({
			scenarioId: "probe",
			results: [],
			behaviour: 0.75,
			dsl: 1,
			now: new Date("2026-09-12T00:00:00Z"),
		});
		expect(baseline).toMatchObject({ schema: 1, binding: "legacy-unbound" });
	});
});
