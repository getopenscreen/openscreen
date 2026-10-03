import { describe, expect, it } from "vitest";
import { TRANSITION_WINDOW_MS } from "@/lib/zoomMath/constants";
import { DESK_COVER_FADE_MS, deskCoverLabelWindows } from "./deskCover";

describe("deskCoverLabelWindows", () => {
	it("covers the hold plus the fade at each end, like the compositor", () => {
		const w = deskCoverLabelWindows({ startMs: 10_000, endMs: 30_000 });
		expect(w.start).toEqual([10_000, 10_000 + TRANSITION_WINDOW_MS + DESK_COVER_FADE_MS]);
		expect(w.end).toEqual([30_000 - TRANSITION_WINDOW_MS * 1.5 - DESK_COVER_FADE_MS, 30_000]);
	});

	it("short sections keep both label pieces inside the section", () => {
		for (const length of [300, 1500, 2200, 3600]) {
			const w = deskCoverLabelWindows({ startMs: 0, endMs: length });
			expect(w.start[0]).toBe(0);
			expect(w.end[1]).toBe(length);
			expect(w.start[1]).toBeLessThanOrEqual(length / 2);
			expect(w.end[0]).toBeGreaterThanOrEqual(w.start[1]);
			expect(w.start[1]).toBeGreaterThan(w.start[0]);
			expect(w.end[1]).toBeGreaterThan(w.end[0]);
		}
	});

	it("pins the 2.2 s case: the fades share the 85 ms left between the holds", () => {
		const w = deskCoverLabelWindows({ startMs: 0, endMs: 2200 });
		const fade = (2200 - TRANSITION_WINDOW_MS - 1100) / 2;
		expect(w.start[0]).toBe(0);
		expect(w.start[1]).toBeCloseTo(TRANSITION_WINDOW_MS + fade, 6);
		expect(w.end[0]).toBeCloseTo(1100 - fade, 6);
		expect(w.end[1]).toBe(2200);
	});

	it("pins the 2.6 s case: the start window ends where the end window begins", () => {
		const w = deskCoverLabelWindows({ startMs: 0, endMs: 2600 });
		const fade = (2600 - TRANSITION_WINDOW_MS - 1300) / 2;
		expect(w.start[1]).toBeCloseTo(TRANSITION_WINDOW_MS + fade, 6);
		expect(w.end[0]).toBeCloseTo(1300 - fade, 6);
		expect(w.start[1]).toBeLessThanOrEqual(w.end[0] + 1e-9);
	});
});
