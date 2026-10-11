import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("./audioPeaks", () => ({ resolveFfmpeg: () => "/bundled/ffmpeg" }));

import { runExportFfmpeg } from "./sourceExport";

function fakeChild() {
	return Object.assign(new EventEmitter(), { stderr: new PassThrough(), kill: vi.fn() });
}
beforeEach(() => {
	vi.clearAllMocks();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("audio export process lifetime", () => {
	it("kills a canceled encoder and waits for close before allowing temporary-file cleanup", async () => {
		const child = fakeChild();
		mocks.spawn.mockReturnValue(child);
		const controller = new AbortController();
		let settled = false;
		const work = runExportFfmpeg([], { signal: controller.signal });
		const result = work.catch((error: Error) => {
			settled = true;
			return error;
		});
		controller.abort();
		expect(child.kill).toHaveBeenCalledWith("SIGKILL");
		await Promise.resolve();
		expect(settled).toBe(false);
		child.emit("close", null);
		expect(await result).toMatchObject({ name: "AbortError" });
	});
	it("does not spawn when already canceled", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(runExportFfmpeg([], { signal: controller.signal })).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(mocks.spawn).not.toHaveBeenCalled();
	});
	it("bounds a stuck encoder and reports its timeout only once it is stopped", async () => {
		vi.useFakeTimers();
		const child = fakeChild();
		mocks.spawn.mockReturnValue(child);
		const work = runExportFfmpeg([], { timeoutMs: 100 }).catch((error: Error) => error);
		await vi.advanceTimersByTimeAsync(100);
		expect(child.kill).toHaveBeenCalledWith("SIGKILL");
		child.emit("close", null);
		expect(await work).toMatchObject({ message: expect.stringContaining("timed out") });
		expect(vi.getTimerCount()).toBe(0);
	});
	it("removes abort hooks after success and returns bounded diagnostic output", async () => {
		const child = fakeChild();
		mocks.spawn.mockReturnValue(child);
		const controller = new AbortController();
		const work = runExportFfmpeg([], { signal: controller.signal });
		child.stderr.write("x".repeat(50_000));
		child.emit("close", 0);
		expect((await work).length).toBe(32_768);
		controller.abort();
		expect(child.kill).not.toHaveBeenCalled();
	});
});
