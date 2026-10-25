// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePresenterOverlayGuidance } from "./usePresenterOverlayGuidance";

const PREFS_KEY = "openscreen_user_preferences";

function storePreference(acknowledged: boolean) {
	localStorage.setItem(
		PREFS_KEY,
		JSON.stringify({ presenterOverlayGuidanceAcknowledged: acknowledged }),
	);
}

function emitStorageEvent() {
	window.dispatchEvent(new StorageEvent("storage", { key: PREFS_KEY }));
}

describe("usePresenterOverlayGuidance", () => {
	beforeEach(() => localStorage.clear());
	afterEach(() => {
		cleanup();
		localStorage.clear();
	});

	it("starts from the stored acknowledgement", () => {
		storePreference(true);
		const view = renderHook(() => usePresenterOverlayGuidance());
		expect(view.result.current.acknowledged).toBe(true);
	});

	it("persists an acknowledgement and updates this window", () => {
		const view = renderHook(() => usePresenterOverlayGuidance());
		expect(view.result.current.acknowledged).toBe(false);
		act(() => view.result.current.acknowledge());
		expect(view.result.current.acknowledged).toBe(true);
		expect(JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}")).toMatchObject({
			presenterOverlayGuidanceAcknowledged: true,
		});
	});

	it("keeps the guidance when the write is rejected", () => {
		const view = renderHook(() => usePresenterOverlayGuidance());
		const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("quota exceeded");
		});
		try {
			act(() => view.result.current.acknowledge());
		} finally {
			setItem.mockRestore();
		}
		expect(view.result.current.acknowledged).toBe(false);
	});

	it("follows an acknowledgement written by another window", () => {
		const view = renderHook(() => usePresenterOverlayGuidance());
		expect(view.result.current.acknowledged).toBe(false);
		act(() => {
			storePreference(true);
			emitStorageEvent();
		});
		expect(view.result.current.acknowledged).toBe(true);
	});

	it("stops listening once unmounted", () => {
		const view = renderHook(() => usePresenterOverlayGuidance());
		view.unmount();
		act(() => {
			storePreference(true);
			emitStorageEvent();
		});
		expect(view.result.current.acknowledged).toBe(false);
	});
});
