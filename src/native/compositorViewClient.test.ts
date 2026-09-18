import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeBridgeRequestError } from "./client";
import { cancelGifExportNative, exportGifNative } from "./compositorViewClient";
import type { NativeBridgeRequest } from "./contracts";

afterEach(() => vi.unstubAllGlobals());

describe("GIF export bridge client", () => {
	it("keeps the export ID independent from RPC IDs", async () => {
		const invoke = vi.fn(async (_request: NativeBridgeRequest) => ({
			ok: true,
			data: { accepted: true },
		}));
		vi.stubGlobal("window", { electronAPI: { invokeNativeBridge: invoke } });
		await exportGifNative([], "/tmp/test.gif", undefined, { fps: 15 }, "gif-1");
		await cancelGifExportNative("gif-1");
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
			expect.objectContaining({ action: "cancelGifExport", payload: { exportId: "gif-1" } }),
		);
	});

	it("preserves confirmed cancellation as a typed error", async () => {
		vi.stubGlobal("window", {
			electronAPI: {
				invokeNativeBridge: vi.fn(async () => ({
					ok: false,
					error: { code: "CANCELLED", message: "GIF export cancelled.", retryable: false },
				})),
			},
		});
		const error = await exportGifNative([], "/tmp/test.gif", undefined, undefined, "gif-2").catch(
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(NativeBridgeRequestError);
		expect(error).toMatchObject({ code: "CANCELLED", message: "GIF export cancelled." });
	});
});
