import { describe, expect, it } from "vitest";

import type { AxcutDocument } from "../schema";
import { readTimelineMarkers } from "./timeline";

function docWith(legacy: Record<string, unknown> | null): Pick<AxcutDocument, "legacyEditor"> {
	return { legacyEditor: legacy } as Pick<AxcutDocument, "legacyEditor">;
}

describe("readTimelineMarkers", () => {
	it("returns an empty list when the envelope has none", () => {
		expect(readTimelineMarkers(docWith(null))).toEqual([]);
		expect(readTimelineMarkers(docWith({}))).toEqual([]);
		expect(readTimelineMarkers(docWith({ timelineMarkers: "nope" }))).toEqual([]);
	});

	it("keeps finite non-negative markers in stored order", () => {
		const doc = docWith({ timelineMarkers: [{ tMs: 5000 }, { tMs: 0 }, { tMs: 1200 }] });
		expect(readTimelineMarkers(doc)).toEqual([{ tMs: 5000 }, { tMs: 0 }, { tMs: 1200 }]);
	});

	it("drops unusable entries instead of failing the list", () => {
		const doc = docWith({
			timelineMarkers: [{ tMs: 1000 }, { tMs: -5 }, { tMs: Number.NaN }, { tMs: "x" }, null],
		});
		expect(readTimelineMarkers(doc)).toEqual([{ tMs: 1000 }]);
	});
});
