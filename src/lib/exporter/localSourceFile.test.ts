import { afterEach, describe, expect, it, vi } from "vitest";
import { materializeLocalSourceFile } from "./localSourceFile";

/**
 * The large-file (OPFS streaming) path is verified end-to-end against a real
 * multi-GB recording; these unit tests cover the small-file branch and the
 * error handling that does not depend on OPFS.
 */

function stubElectronAPI(api: Record<string, unknown>) {
	vi.stubGlobal("window", { ...globalThis.window, electronAPI: api } as unknown);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("materializeLocalSourceFile", () => {
	it("reads a small file in one shot and returns a File with its bytes", async () => {
		const bytes = new Uint8Array([1, 2, 3, 4, 5]);
		stubElectronAPI({
			getReadableFileInfo: vi.fn().mockResolvedValue({
				success: true,
				size: bytes.byteLength,
				mtimeMs: 1,
				path: "/tmp/small.mp4",
			}),
			readBinaryFile: vi.fn().mockResolvedValue({
				success: true,
				data: bytes.buffer,
				path: "/tmp/small.mp4",
			}),
		});

		const file = await materializeLocalSourceFile("/tmp/small.mp4", "small.mp4");

		expect(file).toBeInstanceOf(File);
		expect(file.size).toBe(bytes.byteLength);
		expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
	});

	it("does not stream a small file through readFileChunk", async () => {
		const readFileChunk = vi.fn();
		stubElectronAPI({
			getReadableFileInfo: vi
				.fn()
				.mockResolvedValue({ success: true, size: 10, mtimeMs: 1, path: "/tmp/s.mp4" }),
			readBinaryFile: vi
				.fn()
				.mockResolvedValue({ success: true, data: new Uint8Array(10).buffer, path: "/tmp/s.mp4" }),
			readFileChunk,
		});

		await materializeLocalSourceFile("/tmp/s.mp4", "s.mp4");

		expect(readFileChunk).not.toHaveBeenCalled();
	});

	it("throws when the file cannot be stat-ed", async () => {
		stubElectronAPI({
			getReadableFileInfo: vi
				.fn()
				.mockResolvedValue({ success: false, message: "File path is not approved" }),
			readBinaryFile: vi.fn(),
		});

		await expect(materializeLocalSourceFile("/tmp/missing.mp4", "x.mp4")).rejects.toThrow(
			/not approved/,
		);
	});

	it("throws when the single-shot read fails", async () => {
		stubElectronAPI({
			getReadableFileInfo: vi
				.fn()
				.mockResolvedValue({ success: true, size: 10, mtimeMs: 1, path: "/tmp/s.mp4" }),
			readBinaryFile: vi
				.fn()
				.mockResolvedValue({ success: false, message: "Failed to read binary file" }),
		});

		await expect(materializeLocalSourceFile("/tmp/s.mp4", "s.mp4")).rejects.toThrow(
			/Failed to read binary file/,
		);
	});
});
