import { describe, expect, it } from "vitest";
import {
	collectMacCaptureExcludedWindowIds,
	parseMacDisplayIdFromSourceId,
	parseMacWindowIdFromSourceId,
	supportsMacPresenterOverlay,
	updateMacPresenterOverlayState,
} from "./nativeMacRecording";

describe("nativeMacRecording source parsing", () => {
	it("collects unique native window ids for ScreenCaptureKit exclusion", () => {
		expect(
			collectMacCaptureExcludedWindowIds([
				"window:42:0",
				"screen:1:0",
				"window:7:0",
				"window:42:0",
				"window:not-a-number:0",
				null,
			]),
		).toEqual([42, 7]);
		expect(collectMacCaptureExcludedWindowIds([])).toEqual([]);
	});

	it("rejects window ids outside the ScreenCaptureKit UInt32 range", () => {
		expect(
			collectMacCaptureExcludedWindowIds([
				"window:0:0",
				"window:4294967295:0",
				"window:4294967296:0",
			]),
		).toEqual([4294967295]);
	});

	it("parses Electron window source ids into ScreenCaptureKit window ids", () => {
		expect(parseMacWindowIdFromSourceId("window:12345:0")).toBe(12345);
		expect(parseMacWindowIdFromSourceId("window:987")).toBe(987);
	});

	it("rejects non-window source ids for window parsing", () => {
		expect(parseMacWindowIdFromSourceId("screen:1:0")).toBeNull();
		expect(parseMacWindowIdFromSourceId("window:not-a-number:0")).toBeNull();
		expect(parseMacWindowIdFromSourceId(null)).toBeNull();
	});

	it("parses Electron display source ids into ScreenCaptureKit display ids", () => {
		expect(parseMacDisplayIdFromSourceId("screen:1:0")).toBe(1);
		expect(parseMacDisplayIdFromSourceId("screen:69733248")).toBe(69733248);
	});

	it("rejects non-display source ids for display parsing", () => {
		expect(parseMacDisplayIdFromSourceId("window:123:0")).toBeNull();
		expect(parseMacDisplayIdFromSourceId("screen:not-a-number:0")).toBeNull();
		expect(parseMacDisplayIdFromSourceId(undefined)).toBeNull();
	});
});

describe("Presenter Overlay capability", () => {
	it.each([
		["darwin", "14.0", "arm64", false, true],
		["darwin", "15.7.1", "arm64", false, true],
		["darwin", "15.7.1", "x64", true, true],
		["darwin", "15.7.1", "x64", false, false],
		["darwin", "13.7", "arm64", false, false],
		["darwin", "unknown", "arm64", false, false],
		["win32", "15", "arm64", false, false],
		["linux", "26", "arm64", false, false],
	])("%s %s %s translated=%s", (platform, version, arch, translated, expected) => {
		expect(supportsMacPresenterOverlay(platform, version, arch, translated)).toBe(expected);
	});
});

describe("Presenter Overlay recording combinations", () => {
	it.each([false, true])("does not flag camera-off takes (overlay=%s)", (active) => {
		expect(
			updateMacPresenterOverlayState({ active: false, cameraInterrupted: false }, active, false),
		).toEqual({ active, cameraInterrupted: false });
	});
	it("keeps normal independent-camera recording clear until an effect starts", () => {
		expect(
			updateMacPresenterOverlayState({ active: false, cameraInterrupted: false }, false, true),
		).toEqual({ active: false, cameraInterrupted: false });
	});
	it("retains a camera warning when the effect stops, until a new take", () => {
		const affected = updateMacPresenterOverlayState(
			{ active: false, cameraInterrupted: false },
			true,
			true,
		);
		expect(affected).toEqual({ active: true, cameraInterrupted: true });
		expect(updateMacPresenterOverlayState(affected, false, true)).toEqual({
			active: false,
			cameraInterrupted: true,
		});
	});
});
