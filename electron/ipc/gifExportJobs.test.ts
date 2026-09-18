import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { GifExportJobs, isGifExportId } from "./gifExportJobs";

function owner(id = 1) {
	return Object.assign(new EventEmitter(), {
		id,
		isDestroyed: () => false,
	}) as unknown as WebContents;
}

function pending() {
	let resolve!: (result: number) => void;
	let reject!: (error: Error) => void;
	const result = new Promise<number>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { result, resolve, reject, cancel: vi.fn(() => true) };
}

describe("GIF export jobs", () => {
	it("binds cancel to the sender and ID, including before native compute starts", async () => {
		const jobs = new GifExportJobs();
		const sender = owner();
		const job = pending();
		const run = jobs.run(sender, "job_1", () => job, vi.fn());
		expect(jobs.cancel(owner(2), "job_1")).toBe(false);
		expect(jobs.cancel(sender, "unknown")).toBe(false);
		expect(jobs.cancel(sender, "job_1")).toBe(true);
		expect(jobs.cancel(sender, "job_1")).toBe(true);
		expect(job.cancel).toHaveBeenCalledTimes(2);
		job.resolve(1);
		await run;
		expect(jobs.cancel(sender, "job_1")).toBe(false);
		expect(sender.listenerCount("destroyed")).toBe(0);
	});

	it("rejects a duplicate job without starting it and allows a retry after failure", async () => {
		const jobs = new GifExportJobs();
		const sender = owner();
		const job = pending();
		const run = jobs.run(sender, "first", () => job, vi.fn());
		const duplicate = vi.fn(() => pending());
		await expect(jobs.run(sender, "second", duplicate, vi.fn())).rejects.toThrow("already running");
		expect(duplicate).not.toHaveBeenCalled();
		const failed = expect(run).rejects.toThrow("encoder failed");
		job.reject(new Error("encoder failed"));
		await failed;
		await expect(
			jobs.run(sender, "retry", () => ({ result: Promise.resolve(2), cancel: vi.fn() }), vi.fn()),
		).resolves.toBe(2);
		expect(sender.listenerCount("destroyed")).toBe(0);
	});

	it("cancels on sender destruction and suppresses late progress after a retry", async () => {
		const jobs = new GifExportJobs();
		const sender = owner();
		const job = pending();
		const progress = vi.fn();
		let oldProgress!: (frames: number) => void;
		const run = jobs.run(
			sender,
			"old",
			(cb) => {
				oldProgress = cb;
				return job;
			},
			progress,
		);
		oldProgress(1);
		expect(progress).toHaveBeenCalledWith(1);
		sender.emit("destroyed");
		expect(job.cancel).toHaveBeenCalledOnce();
		job.resolve(1);
		await run;
		const next = pending();
		const retry = jobs.run(sender, "new", () => next, progress);
		oldProgress(99);
		expect(progress).toHaveBeenCalledTimes(1);
		next.resolve(2);
		await retry;
	});

	it("does not reinterpret a completion that wins the cancellation race", async () => {
		const jobs = new GifExportJobs();
		const sender = owner();
		const job = pending();
		job.cancel.mockReturnValue(false);
		const run = jobs.run(sender, "done", () => job, vi.fn());
		expect(jobs.cancel(sender, "done")).toBe(false);
		job.resolve(5);
		await expect(run).resolves.toBe(5);
	});

	it.each([
		undefined,
		null,
		1,
		{},
		"",
		"a/b",
		"a".repeat(129),
	])("rejects malformed IDs: %j", (id) => {
		expect(isGifExportId(id)).toBe(false);
	});

	it("rejects an invalid start before invoking native code", async () => {
		const start = vi.fn(() => pending());
		await expect(new GifExportJobs().run(owner(), "../bad", start, vi.fn())).rejects.toThrow(
			"Invalid GIF export ID",
		);
		expect(start).not.toHaveBeenCalled();
	});
});
