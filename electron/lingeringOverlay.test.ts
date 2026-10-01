import { describe, expect, it } from "vitest";
import { isOnlyLingeringOverlay } from "./lingeringOverlay";

const window = (destroyed = false) => ({ isDestroyed: () => destroyed });

describe("isOnlyLingeringOverlay", () => {
	it("is true when the hidden overlay is the last window open", () => {
		const overlay = window();
		expect(isOnlyLingeringOverlay([overlay], overlay)).toBe(true);
		expect(isOnlyLingeringOverlay([overlay, window(true)], overlay)).toBe(true);
	});

	it("is false while the HUD or the editor is still open", () => {
		const overlay = window();
		expect(isOnlyLingeringOverlay([window(), overlay], overlay)).toBe(false);
	});

	it("is false without an overlay to close", () => {
		expect(isOnlyLingeringOverlay([], null)).toBe(false);
		const gone = window(true);
		expect(isOnlyLingeringOverlay([gone], gone)).toBe(false);
	});
});
