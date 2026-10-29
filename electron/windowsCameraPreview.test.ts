import fs from "node:fs/promises";
import os from "node:os";
import { nativeImage } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createWindowsCameraPreviewMailbox,
	watchWindowsCameraPreview,
} from "./windowsCameraPreview";

vi.mock("electron", () => ({
	nativeImage: {
		createFromBitmap: vi.fn(() => ({ isEmpty: () => false, toJPEG: () => Buffer.from("jpeg") })),
	},
}));

function frame() {
	const data = Buffer.alloc(54 + 2 * 2 * 4);
	data.write("BM");
	data.writeInt32LE(2, 18);
	data.writeInt32LE(-2, 22);
	return data;
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

describe("Windows native camera preview", () => {
	it("delivers bounded top-down pixels without opening a camera", async () => {
		vi.useFakeTimers();
		vi.spyOn(fs, "readFile").mockResolvedValue(frame());
		const onFrame = vi.fn();
		const stop = watchWindowsCameraPreview("latest.bmp", onFrame);
		await vi.advanceTimersByTimeAsync(0);
		expect(nativeImage.createFromBitmap).toHaveBeenCalledWith(frame().subarray(54), {
			width: 2,
			height: 2,
		});
		expect(onFrame).toHaveBeenCalledWith("data:image/jpeg;base64,anBlZw==", 1);
		stop();
		await vi.advanceTimersByTimeAsync(1000);
		expect(onFrame).toHaveBeenCalledOnce();
	});

	it("does not queue reads or deliver an in-flight frame after cleanup", async () => {
		vi.useFakeTimers();
		let resolve: ((value: Buffer<ArrayBuffer>) => void) | undefined;
		const read = vi.spyOn(fs, "readFile").mockImplementationOnce(
			() =>
				new Promise<Buffer<ArrayBuffer>>((done) => {
					resolve = done;
				}),
		);
		const onFrame = vi.fn();
		const stop = watchWindowsCameraPreview("latest.bmp", onFrame);
		await vi.advanceTimersByTimeAsync(1000);
		expect(read).toHaveBeenCalledOnce();
		stop();
		resolve?.(frame());
		await vi.advanceTimersByTimeAsync(1000);
		expect(onFrame).not.toHaveBeenCalled();
		expect(read).toHaveBeenCalledOnce();
	});

	it("retries a missing frame and rejects oversized dimensions and truncated pixels", async () => {
		vi.useFakeTimers();
		const huge = frame();
		huge.writeInt32LE(10000, 18);
		vi.spyOn(fs, "readFile")
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockResolvedValueOnce(huge)
			.mockResolvedValueOnce(frame().subarray(0, 54))
			.mockResolvedValue(frame());
		const onFrame = vi.fn();
		const stop = watchWindowsCameraPreview("latest.bmp", onFrame);
		await vi.advanceTimersByTimeAsync(500);
		expect(onFrame).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(100);
		expect(onFrame).toHaveBeenCalledOnce();
		stop();
	});

	it("removes the private directory and any half-written camera frame", async () => {
		const mailbox = await createWindowsCameraPreviewMailbox(os.tmpdir());
		try {
			await fs.writeFile(mailbox.file, frame());
			await fs.writeFile(`${mailbox.file}.tmp`, frame());
			await mailbox.remove();
			await expect(fs.stat(mailbox.file)).rejects.toThrow();
			await expect(fs.stat(`${mailbox.file}.tmp`)).rejects.toThrow();
		} finally {
			await mailbox.remove();
		}
	});
});
