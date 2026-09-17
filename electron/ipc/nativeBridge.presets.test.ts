import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StylePresetAppearance } from "../../src/lib/ai-edition/stylePresets";
import type { NativeBridgeResponse } from "../../src/native/contracts";
import { StylePresetService } from "../ai-edition/style-preset-service";
import { type NativeBridgeContext, registerNativeBridgeHandlers } from "./nativeBridge";

const electron = vi.hoisted(() => ({
	handle: vi.fn(),
	showItemInFolder: vi.fn(),
	openPath: vi.fn(async () => ""),
}));
vi.mock("electron", () => ({
	app: { getAppPath: () => "", isPackaged: false },
	ipcMain: { handle: electron.handle, removeHandler: vi.fn() },
	shell: { showItemInFolder: electron.showItemInFolder, openPath: electron.openPath },
}));
// The bridge builds these at registration; none of them is under test here.
vi.mock("../native-bridge/services/compositorViewService", () => ({
	CompositorViewService: class {},
}));
vi.mock("../native-bridge/services/aiEditionService", () => ({
	AiEditionService: class {},
}));

const APPEARANCE: StylePresetAppearance = {
	wallpaper: "#000000",
	wallpaperMotion: "none",
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
	webcamWallpaper: "#ffffff",
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
let invoke: (request: unknown) => Promise<NativeBridgeResponse>;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-presets-"));
	const service = new StylePresetService(root);
	electron.handle.mockClear();
	electron.showItemInFolder.mockClear();
	electron.openPath.mockClear();
	registerNativeBridgeHandlers({
		getPlatform: () => "darwin",
		getAiEditionDocuments: () => ({}),
		getAiEditionLlmConfig: () => ({}),
		getStylePresets: () => service,
	} as unknown as NativeBridgeContext);
	const handler = electron.handle.mock.calls[0]?.[1] as (
		event: unknown,
		request: unknown,
	) => Promise<NativeBridgeResponse>;
	invoke = (request) => handler({ sender: {} }, request);
});

afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(root, { recursive: true, force: true });
});

describe("native bridge presets domain", () => {
	it("creates and lists presets", async () => {
		const created = await invoke({
			domain: "presets",
			action: "create",
			payload: { name: "Studio", appearance: APPEARANCE },
		});
		expect(created).toMatchObject({ ok: true, data: { id: "Studio", name: "Studio" } });

		const listed = await invoke({ domain: "presets", action: "list" });
		expect(listed.ok && listed.data).toEqual([(created as { data: unknown }).data]);
	});

	it("reports a taken name as NAME_TAKEN", async () => {
		const create = {
			domain: "presets",
			action: "create",
			payload: { name: "Studio", appearance: APPEARANCE },
		};
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		await invoke(create);
		const again = await invoke({ ...create, payload: { name: "STUDIO", appearance: APPEARANCE } });
		expect(again).toMatchObject({ ok: false, error: { code: "NAME_TAKEN", retryable: false } });
	});

	it("reports an invalid preset or id as INVALID_REQUEST and a missing one as NOT_FOUND", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const bad = await invoke({
			domain: "presets",
			action: "create",
			payload: { name: "Bad", appearance: { ...APPEARANCE, wallpaper: "https://x.test/a.png" } },
		});
		expect(bad).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });

		const traversal = await invoke({
			domain: "presets",
			action: "delete",
			payload: { id: "../x" },
		});
		expect(traversal).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });

		const missing = await invoke({
			domain: "presets",
			action: "update",
			payload: { id: "nope", appearance: APPEARANCE },
		});
		expect(missing).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
	});

	it("reveals the preset file, or opens the folder when the file is gone", async () => {
		await invoke({
			domain: "presets",
			action: "create",
			payload: { name: "Shown", appearance: APPEARANCE },
		});
		expect(
			await invoke({ domain: "presets", action: "reveal", payload: { id: "Shown" } }),
		).toMatchObject({
			ok: true,
		});
		expect(electron.showItemInFolder).toHaveBeenCalledWith(
			path.join(root, "Shown.openscreenpreset"),
		);

		await invoke({ domain: "presets", action: "reveal", payload: { id: "Gone" } });
		expect(electron.openPath).toHaveBeenCalledWith(path.resolve(root));
	});
});
