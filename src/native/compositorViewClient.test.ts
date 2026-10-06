import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeBridgeRequestError } from "./client";
import { cancelExportNative, exportGifNative, exportMultiNative } from "./compositorViewClient";
import type { NativeBridgeRequest } from "./contracts";

afterEach(() => vi.unstubAllGlobals());

describe("export bridge client", () => {
	it("keeps the export ID independent from RPC IDs", async () => {
		const invoke = vi.fn(async (_request: NativeBridgeRequest) => ({
			ok: true,
			data: { accepted: true },
		}));
		vi.stubGlobal("window", { electronAPI: { invokeNativeBridge: invoke } });
		await exportGifNative([], "/tmp/test.gif", undefined, { fps: 15 }, "gif-1");
		await cancelExportNative("gif-1");
		expect(invoke.mock.calls).toHaveLength(2);
		const first = invoke.mock.calls[0]?.[0];
		expect(first?.requestId).not.toBe(invoke.mock.calls[1]?.[0].requestId);
		expect(first).toEqual(
			expect.objectContaining({
				action: "exportGif",
				payload: expect.objectContaining({ exportId: "gif-1" }),
			}),
		);
		expect(invoke.mock.calls[1]?.[0]).toEqual(
			expect.objectContaining({ action: "cancelExport", payload: { exportId: "gif-1" } }),
		);
	});

	it("sends the MP4 export ID that a cancel names", async () => {
		const invoke = vi.fn(async (_request: NativeBridgeRequest) => ({ ok: true, data: {} }));
		vi.stubGlobal("window", { electronAPI: { invokeNativeBridge: invoke } });
		await exportMultiNative([], "/tmp/test.mp4", undefined, { fps: 30 }, "mp4-1");
		expect(invoke.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				action: "exportMulti",
				payload: expect.objectContaining({ exportId: "mp4-1", params: { fps: 30 } }),
			}),
		);
	});

	it("preserves confirmed cancellation as a typed error", async () => {
		vi.stubGlobal("window", {
			electronAPI: {
				invokeNativeBridge: vi.fn(async () => ({
					ok: false,
					error: { code: "CANCELLED", message: "Export cancelled.", retryable: false },
				})),
			},
		});
		for (const run of [
			() => exportGifNative([], "/tmp/test.gif", undefined, undefined, "gif-2"),
			() => exportMultiNative([], "/tmp/test.mp4", undefined, undefined, "mp4-2"),
		]) {
			const error = await run().catch((e: unknown) => e);
			expect(error).toBeInstanceOf(NativeBridgeRequestError);
			expect(error).toMatchObject({ code: "CANCELLED", message: "Export cancelled." });
		}
	});
});
