// @vitest-environment jsdom
// The shim keeps presets in localStorage, so this needs a DOM.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { StylePresetAppearance } from "@/lib/ai-edition/stylePresets";
import { installBrowserShims } from "./browserShim";
import {
	isStylePresetNameTakenError,
	NativeBridgeRequestError,
	nativeBridgeClient,
} from "./client";

const APPEARANCE: StylePresetAppearance = {
	wallpaper: "#000000",
	wallpaperMotion: "none",
	frame: "none",
	aspectRatio: "16:9",
	shadowIntensity: 0.2,
	showBlur: false,
	motionBlurAmount: 0.2,
	depthOfField: true,
	borderRadius: 40,
	padding: 50,
	webcamLayoutPreset: "picture-in-picture",
	webcamMaskShape: "rectangle",
	webcamMirrored: false,
	webcamReactiveZoom: true,
	webcamSizePreset: 25,
	webcamBackgroundMode: "none",
	webcamWallpaper: "#ffffff",
	webcamBlurIntensity: 0.5,
	cursor: {
		size: 3,
		smoothing: 0.67,
		motionBlur: 0.35,
		clickBounce: 2.5,
		model3d: false,
		clipToBounds: false,
	},
	cursorShow: true,
	cursorAutoHide: false,
	cursorTheme: "default",
};

const presets = nativeBridgeClient.presets;

beforeAll(() => {
	window.history.replaceState(null, "", "/?browser");
	installBrowserShims();
});
beforeEach(() => {
	localStorage.clear();
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => null,
		(error: unknown) => error,
	);
}

describe("browserShim presets", () => {
	it("creates, lists sorted by name, updates and deletes", async () => {
		const b = await presets.create(" beta ", APPEARANCE);
		const a = await presets.create("Alpha", APPEARANCE);
		expect(b).toMatchObject({ id: "beta", name: "beta" });
		expect((await presets.list()).map((p) => p.name)).toEqual(["Alpha", "beta"]);

		const updated = await presets.update(a.id, { ...APPEARANCE, padding: 5 });
		expect(updated.appearance.padding).toBe(5);

		expect(await presets.delete(b.id)).toEqual({ success: true });
		expect((await presets.list()).map((p) => p.id)).toEqual(["Alpha"]);
		expect(await presets.reveal(a.id)).toEqual({ success: true });
	});

	it("rejects a taken name with NAME_TAKEN on create and rename", async () => {
		const one = await presets.create("One", APPEARANCE);
		await presets.create("Two", APPEARANCE);

		const onCreate = await rejection(presets.create("one", APPEARANCE));
		expect(onCreate).toBeInstanceOf(NativeBridgeRequestError);
		expect(isStylePresetNameTakenError(onCreate)).toBe(true);

		expect(isStylePresetNameTakenError(await rejection(presets.rename(one.id, "TWO")))).toBe(true);

		const renamed = await presets.rename(one.id, "Three");
		expect(renamed).toMatchObject({ id: "Three", name: "Three" });
		expect((await presets.list()).map((p) => p.id)).toEqual(["Three", "Two"]);
	});

	it("reserves the built-in preset id on create and rename", async () => {
		await expect(presets.create("openscreen-factory", APPEARANCE)).rejects.toMatchObject({
			code: "NAME_TAKEN",
		});
		const created = await presets.create("Mine", APPEARANCE);
		await expect(presets.rename(created.id, "OPENSCREEN-FACTORY")).rejects.toMatchObject({
			code: "NAME_TAKEN",
		});
	});

	it("rejects every mutation when localStorage persistence fails", async () => {
		const created = await presets.create("Mine", APPEARANCE);
		const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new DOMException("full", "QuotaExceededError");
		});
		try {
			for (const mutate of [
				() => presets.create("Other", APPEARANCE),
				() => presets.rename(created.id, "Renamed"),
				() => presets.update(created.id, { ...APPEARANCE, padding: 10 }),
				() => presets.delete(created.id),
			]) {
				await expect(mutate()).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
			}
		} finally {
			setItem.mockRestore();
		}
		expect((await presets.list()).map((preset) => preset.id)).toEqual(["Mine"]);
	});

	it("reports invalid input and missing presets with the bridge's codes", async () => {
		const invalid = await rejection(
			presets.create("Bad", { ...APPEARANCE, wallpaper: "file:///Users/alice/a.jpg" }),
		);
		expect(invalid).toMatchObject({ code: "INVALID_REQUEST" });
		expect(await rejection(presets.update("missing", APPEARANCE))).toMatchObject({
			code: "NOT_FOUND",
		});
	});
});
