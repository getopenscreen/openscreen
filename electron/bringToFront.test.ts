import { describe, expect, it, vi } from "vitest";
import { bringToFront } from "./bringToFront";

function fakeWindow(minimized: boolean) {
	const calls: string[] = [];
	return {
		calls,
		isMinimized: () => minimized,
		restore: vi.fn(() => calls.push("restore")),
		show: vi.fn(() => calls.push("show")),
		focus: vi.fn(() => calls.push("focus")),
	};
}

describe("bringToFront", () => {
	it("restores a minimized window before showing and focusing it", () => {
		const win = fakeWindow(true);
		bringToFront(win);
		expect(win.calls).toEqual(["restore", "show", "focus"]);
	});

	it("shows and focuses a window that is not minimized, hidden or behind others", () => {
		const win = fakeWindow(false);
		bringToFront(win);
		expect(win.calls).toEqual(["show", "focus"]);
	});
});
