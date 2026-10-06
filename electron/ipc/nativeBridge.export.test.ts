// An MP4 export started with an ID runs as a job of its window, so a cancel naming that ID
// reaches the native control, and the native cancellation comes back as CANCELLED.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeBridgeResponse } from "../../src/native/contracts";
import { type NativeBridgeContext, registerNativeBridgeHandlers } from "./nativeBridge";

const electron = vi.hoisted(() => ({ handle: vi.fn() }));
vi.mock("electron", () => ({
	app: { getAppPath: () => "", isPackaged: false },
	ipcMain: { handle: electron.handle, removeHandler: vi.fn() },
	shell: {},
}));
const compositor = vi.hoisted(() => ({ startExportMulti: vi.fn(), exportMulti: vi.fn() }));
vi.mock("../native-bridge/services/compositorViewService", () => ({
	CompositorViewService: class {
		startExportMulti = compositor.startExportMulti;
		exportMulti = compositor.exportMulti;
	},
}));
vi.mock("../native-bridge/services/aiEditionService", () => ({
	AiEditionService: class {},
}));

const sender = {
	id: 1,
	isDestroyed: () => false,
	send: vi.fn(),
	once: vi.fn(),
	removeListener: vi.fn(),
};
let invoke: (action: string, payload: unknown) => Promise<NativeBridgeResponse>;

beforeEach(() => {
	electron.handle.mockClear();
	sender.send.mockClear();
	for (const fn of Object.values(compositor)) fn.mockReset();
	registerNativeBridgeHandlers({
		getPlatform: () => "linux",
		getAiEditionDocuments: () => ({}),
		getAiEditionLlmConfig: () => ({}),
	} as unknown as NativeBridgeContext);
	const handler = electron.handle.mock.calls[0]?.[1] as (
		event: unknown,
		request: unknown,
	) => Promise<NativeBridgeResponse>;
	invoke = (action, payload) => handler({ sender }, { domain: "compositor", action, payload });
});

describe("native bridge MP4 export", () => {
	it("cancels a running export by its ID and reports CANCELLED", async () => {
		let fail!: (error: Error) => void;
		const cancel = vi.fn(() => true);
		compositor.startExportMulti.mockImplementation((...args: unknown[]) => {
			(args[4] as (frames: number) => void)(3);
			const result = new Promise((_, reject) => {
				fail = reject;
			});
			return { result, cancel };
		});
		const running = invoke("exportMulti", { clips: [], outPath: "/tmp/a.mp4", exportId: "mp4-1" });
		await vi.waitFor(() => expect(compositor.startExportMulti).toHaveBeenCalledOnce());
		expect(sender.send).toHaveBeenCalledWith("export:native-progress", 3, "mp4-1");

		expect(await invoke("cancelExport", { exportId: "other" })).toMatchObject({
			ok: true,
			data: { accepted: false },
		});
		expect(await invoke("cancelExport", { exportId: "mp4-1" })).toMatchObject({
			ok: true,
			data: { accepted: true },
		});
		expect(cancel).toHaveBeenCalledOnce();

		fail(new Error("MP4_EXPORT_CANCELLED"));
		expect(await running).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
	});

	it("runs an export without an ID outside the job registry, as the CLI does", async () => {
		const stats = { frames: 1, wallS: 1, fps: 1, videoDurationS: 1 };
		compositor.exportMulti.mockResolvedValue(stats);
		expect(await invoke("exportMulti", { clips: [], outPath: "/tmp/a.mp4" })).toMatchObject({
			ok: true,
			data: stats,
		});
		expect(compositor.startExportMulti).not.toHaveBeenCalled();
	});
});
