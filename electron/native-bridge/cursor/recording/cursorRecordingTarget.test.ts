import { describe, expect, it, vi } from "vitest";
import { resolveCursorRecordingTarget } from "./cursorRecordingTarget";

describe("cursor recording target resolution", () => {
	it("uses the recording request snapshot instead of stale selected-source fields", () => {
		const selectedBounds = vi.fn(() => ({ x: 0, y: 0, width: 3072, height: 1728 }));
		const requestedBounds = vi.fn(() => ({ x: -1920, y: -1080, width: 1920, height: 1080 }));
		const selected = {
			displayId: 1,
			getDisplayBounds: selectedBounds,
			sourceId: "screen:1:0",
		};
		const requested = {
			displayId: 2,
			getDisplayBounds: requestedBounds,
			sourceId: "window:424242:0",
		};

		const resolved = resolveCursorRecordingTarget(requested, selected);

		expect(resolved).toBe(requested);
		expect(resolved.displayId).toBe(2);
		expect(resolved.sourceId).toBe("window:424242:0");
		expect(resolved.getDisplayBounds()).toEqual({
			x: -1920,
			y: -1080,
			width: 1920,
			height: 1080,
		});
		expect(selectedBounds).not.toHaveBeenCalled();
	});

	it("retains the selected-source path for non-native fallback capture", () => {
		const selected = {
			displayId: 1,
			getDisplayBounds: vi.fn(() => ({ x: 0, y: 0, width: 3072, height: 1728 })),
			sourceId: "screen:1:0",
		};

		expect(resolveCursorRecordingTarget(undefined, selected)).toBe(selected);
	});
});
