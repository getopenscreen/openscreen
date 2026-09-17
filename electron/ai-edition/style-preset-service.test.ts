import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StylePresetAppearance } from "../../src/lib/ai-edition/stylePresets";
import { StylePresetError, StylePresetService } from "./style-preset-service";

const APPEARANCE: StylePresetAppearance = {
	wallpaper: "#000000",
	aspectRatio: "16:9",
	shadowIntensity: 0.2,
	showBlur: false,
	motionBlurAmount: 0.2,
	borderRadius: 40,
	padding: 50,
	webcamLayoutPreset: "picture-in-picture",
	webcamMaskShape: "rectangle",
	webcamMirrored: false,
	webcamReactiveZoom: true,
	webcamSizePreset: 25,
	webcamBackgroundMode: "none",
	webcamWallpaper: "/wallpapers/wallpaper1.jpg",
	webcamBlurIntensity: 0.5,
	cursor: {
		size: 3,
		smoothing: 0.67,
		motionBlur: 0.35,
		clickBounce: 2.5,
		volume: 0,
		clipToBounds: false,
	},
	cursorShow: true,
	cursorAutoHide: false,
	cursorTheme: "default",
};

let root: string;
let dir: string;
let service: StylePresetService;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "style-presets-"));
	// Not created up front: the service creates the folder lazily.
	dir = path.join(root, "OpenScreen Presets");
	service = new StylePresetService(dir);
});

afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(root, { recursive: true, force: true });
});

async function expectCode(promise: Promise<unknown>, code: string) {
	const error = await promise.then(
		() => null,
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(StylePresetError);
	expect((error as StylePresetError).code).toBe(code);
}

describe("StylePresetService", () => {
	it("creates the folder lazily and lists nothing", async () => {
		expect(await service.list()).toEqual([]);
		expect((await fs.stat(dir)).isDirectory()).toBe(true);
	});

	it("creates a preset file named after the preset and lists it", async () => {
		const created = await service.create("  Studio  Look ", APPEARANCE);
		expect(created).toMatchObject({
			id: "Studio Look",
			name: "Studio Look",
			appearance: APPEARANCE,
		});
		expect(Number.isNaN(Date.parse(created.updatedAt))).toBe(false);
		const raw = JSON.parse(
			await fs.readFile(path.join(dir, "Studio Look.openscreenpreset"), "utf8"),
		);
		expect(raw).toMatchObject({
			format: "openscreen-style-preset",
			version: 1,
			name: "Studio Look",
		});
		expect(await service.list()).toEqual([created]);
	});

	it("lists a dropped-in file, skips corrupt ones, and sorts by name ignoring case", async () => {
		await service.create("beta", APPEARANCE);
		await fs.writeFile(
			path.join(dir, "shared.openscreenpreset"),
			JSON.stringify({
				format: "openscreen-style-preset",
				version: 1,
				name: "Alpha",
				appearance: APPEARANCE,
			}),
		);
		await fs.writeFile(path.join(dir, "broken.openscreenpreset"), "{ not json");
		await fs.writeFile(
			path.join(dir, "invalid.openscreenpreset"),
			JSON.stringify({
				format: "openscreen-style-preset",
				version: 1,
				name: "Bad",
				appearance: {},
			}),
		);
		await fs.writeFile(path.join(dir, "notes.txt"), "ignored");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		const listed = await service.list();

		expect(listed.map((p) => [p.id, p.name])).toEqual([
			["shared", "Alpha"],
			["beta", "beta"],
		]);
		expect(warn).toHaveBeenCalledTimes(2);
	});

	it("refuses a name already used by a file or by a preset, ignoring case", async () => {
		await service.create("Studio", APPEARANCE);
		await expectCode(service.create("studio", APPEARANCE), "NAME_TAKEN");
		await fs.writeFile(
			path.join(dir, "other-file.openscreenpreset"),
			JSON.stringify({
				format: "openscreen-style-preset",
				version: 1,
				name: "Shared",
				appearance: APPEARANCE,
			}),
		);
		await expectCode(service.create("SHARED", APPEARANCE), "NAME_TAKEN");
		// A corrupt file still occupies its name on disk.
		await fs.writeFile(path.join(dir, "Corrupt.openscreenpreset"), "nope");
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		await expectCode(service.create("corrupt", APPEARANCE), "NAME_TAKEN");
	});

	it("reserves the built-in preset id on create and rename", async () => {
		await expectCode(service.create("openscreen-factory", APPEARANCE), "NAME_TAKEN");
		const created = await service.create("Mine", APPEARANCE);
		await expectCode(service.rename(created.id, "OPENSCREEN-FACTORY"), "NAME_TAKEN");
		expect((await service.list()).map((preset) => preset.id)).toEqual(["Mine"]);
	});

	it("rejects an invalid appearance before writing anything", async () => {
		await expect(
			service.create("Bad", { ...APPEARANCE, wallpaper: "file:///Users/alice/a.jpg" }),
		).rejects.toThrow(TypeError);
		expect(await fs.readdir(dir).catch(() => [])).toEqual([]);
	});

	it("renames the file, and refuses a taken name", async () => {
		const a = await service.create("One", APPEARANCE);
		await service.create("Two", APPEARANCE);
		await expectCode(service.rename(a.id, "two"), "NAME_TAKEN");

		const renamed = await service.rename(a.id, "Three");
		expect(renamed).toMatchObject({ id: "Three", name: "Three" });
		expect((await fs.readdir(dir)).sort()).toEqual([
			"Three.openscreenpreset",
			"Two.openscreenpreset",
		]);
	});

	it("handles a case-only rename without losing the preset", async () => {
		const created = await service.create("studio", APPEARANCE);
		const renamed = await service.rename(created.id, "Studio");
		expect(renamed).toMatchObject({ id: "Studio", name: "Studio", appearance: APPEARANCE });
		expect(await fs.readdir(dir)).toEqual(["Studio.openscreenpreset"]);
	});

	it("removes the destination and preserves the source when rename cleanup fails", async () => {
		const created = await service.create("Source", APPEARANCE);
		const sourcePath = path.join(dir, "Source.openscreenpreset");
		const unlink = fs.unlink.bind(fs);
		vi.spyOn(fs, "unlink").mockImplementation(async (filePath) => {
			if (filePath === sourcePath) {
				throw Object.assign(new Error("busy"), { code: "EBUSY" });
			}
			return unlink(filePath);
		});

		await expect(service.rename(created.id, "Destination")).rejects.toMatchObject({
			code: "EBUSY",
		});
		expect((await fs.readdir(dir)).sort()).toEqual(["Source.openscreenpreset"]);
		expect(await service.list()).toMatchObject([{ id: "Source", name: "Source" }]);
	});

	it("updates the appearance and keeps the name", async () => {
		const created = await service.create("Look", APPEARANCE);
		const updated = await service.update(created.id, { ...APPEARANCE, padding: 10 });
		expect(updated).toMatchObject({ id: "Look", name: "Look" });
		expect(updated.appearance.padding).toBe(10);
		await expectCode(service.update("missing", APPEARANCE), "NOT_FOUND");
	});

	it("deletes, tolerating a file that is already gone", async () => {
		const created = await service.create("Gone", APPEARANCE);
		await service.delete(created.id);
		await service.delete(created.id);
		expect(await service.list()).toEqual([]);
	});

	it("serialises concurrent creates of the same name", async () => {
		const results = await Promise.allSettled([
			service.create("Race", APPEARANCE),
			service.create("race", APPEARANCE),
		]);
		expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
	});

	it("pathFor rejects traversal and separators and stays inside the folder", () => {
		expect(service.pathFor("Look")).toBe(path.join(path.resolve(dir), "Look.openscreenpreset"));
		for (const id of [
			"",
			".",
			"..",
			"../x",
			"a/b",
			"a\\b",
			"C:evil",
			`x${String.fromCharCode(0)}y`,
		]) {
			expect(() => service.pathFor(id)).toThrow(StylePresetError);
		}
	});

	it("reveals the file when it exists and the folder otherwise", async () => {
		const created = await service.create("Shown", APPEARANCE);
		expect(await service.revealTarget(created.id)).toEqual({
			kind: "file",
			path: service.pathFor(created.id),
		});
		expect(await service.revealTarget("missing")).toEqual({
			kind: "folder",
			path: path.resolve(dir),
		});
	});
});
