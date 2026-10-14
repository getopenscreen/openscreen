import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ BrowserWindow: class {} }));

import { gifFrameIndexAt, isGifPath } from "./hidden-video";

describe("isGifPath", () => {
	it("picks a GIF by its extension, in any case", () => {
		expect(isGifPath("/tmp/out.gif")).toBe(true);
		expect(isGifPath("C:\\exports\\OUT.GIF")).toBe(true);
		expect(isGifPath("/tmp/out.mp4")).toBe(false);
		expect(isGifPath("/tmp/gif/out.webm")).toBe(false);
	});
});

describe("gifFrameIndexAt", () => {
	// A 15 fps GIF: delays are whole centiseconds, so frames alternate 70 and 60 ms.
	const starts = [0, 0.07, 0.13, 0.2, 0.26];

	it("shows the frame whose span holds the time", () => {
		expect(gifFrameIndexAt(starts, 0)).toBe(0);
		expect(gifFrameIndexAt(starts, 0.069)).toBe(0);
		expect(gifFrameIndexAt(starts, 0.07)).toBe(1);
		expect(gifFrameIndexAt(starts, 0.2)).toBe(3);
	});

	it("holds the last frame past the end and the first before the start", () => {
		expect(gifFrameIndexAt(starts, 99)).toBe(4);
		expect(gifFrameIndexAt(starts, -1)).toBe(0);
	});

	it("answers 0 for a one-frame GIF", () => {
		expect(gifFrameIndexAt([0], 3)).toBe(0);
	});
});
