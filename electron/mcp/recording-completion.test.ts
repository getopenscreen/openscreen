import { getEventListeners } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceTimeline } from "../../src/lib/ai-edition/document/timeline";
import { createEmptyDocument } from "../../src/lib/ai-edition/schema";
import { RecordingCompletion } from "./recording-completion";

const RESULT = { projectId: "proj_take", videoPath: "/take.mp4", durationSec: 12, autoZooms: 2 };
let completion: RecordingCompletion;
let abort: AbortController;
beforeEach(() => {
	vi.useFakeTimers();
	completion = new RecordingCompletion();
	abort = new AbortController();
});
afterEach(() => {
	expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
	expect(vi.getTimerCount()).toBe(0);
	vi.useRealTimers();
});

describe("waiting on the app's recording", () => {
	it("refuses idle calls and never returns an older take", async () => {
		await expect(completion.wait(100, abort.signal)).rejects.toThrow("No recording");
		completion.started(1, 123);
		completion.saved(1, RESULT.videoPath);
		completion.completed(1, RESULT);
		await expect(completion.wait(100, abort.signal)).rejects.toThrow("No recording");
	});

	it("does not miss completion immediately after subscription, even before the first await", async () => {
		completion.started(1, 123);
		const waiting = completion.wait(100, abort.signal);
		completion.saved(1, RESULT.videoPath);
		completion.completed(1, RESULT);
		expect(await waiting).toEqual({ ...RESULT, recordingStartedAt: 123 });
	});

	it("requires that take's saved media and ignores imported projects and other recordings", async () => {
		completion.started(1, 123);
		completion.saved(99, "/import.mp4");
		const waiting = completion.wait(100, abort.signal);
		completion.completed(1, RESULT); // no saved session yet
		completion.saved(1, RESULT.videoPath);
		completion.completed(99, RESULT);
		completion.completed(1, { ...RESULT, videoPath: "/import.mp4" });
		expect(vi.getTimerCount()).toBe(1);
		completion.completed(1, RESULT);
		expect(await waiting).toMatchObject({ videoPath: RESULT.videoPath });
	});

	it("binds late calls during saving and all concurrent waits to the same result", async () => {
		completion.started(1, 123);
		const first = completion.wait(100, abort.signal);
		completion.saved(1, RESULT.videoPath);
		const second = completion.wait(100, abort.signal);
		completion.completed(1, RESULT);
		expect(await first).toEqual(await second);
	});

	it("times out only the wait; a retry can still get the same take", async () => {
		completion.started(1, 123);
		const waiting = expect(completion.wait(10, abort.signal)).rejects.toThrow("Timed out");
		await vi.advanceTimersByTimeAsync(10);
		await waiting;
		const retry = completion.wait(100, abort.signal);
		completion.saved(1, RESULT.videoPath);
		completion.completed(1, RESULT);
		expect(await retry).toMatchObject({ recordingStartedAt: 123 });
	});

	it("cancels one request without affecting other waiters or the take", async () => {
		completion.started(1);
		const first = expect(completion.wait(100, abort.signal)).rejects.toThrow("cancelled");
		const other = new AbortController();
		const second = completion.wait(100, other.signal);
		abort.abort();
		await first;
		expect(getEventListeners(other.signal, "abort")).toHaveLength(1);
		completion.saved(1, RESULT.videoPath);
		completion.completed(1, RESULT);
		await second;
		expect(getEventListeners(other.signal, "abort")).toHaveLength(0);
	});

	it("cleans up a signal already cancelled when the call arrives", async () => {
		completion.started(1);
		abort.abort();
		await expect(completion.wait(100, abort.signal)).rejects.toThrow("cancelled");
	});

	it.each([
		"Recording failed: disk full",
		"The recording was cancelled or discarded.",
	])("ends all waits on %s", async (message) => {
		completion.started(1);
		const first = expect(completion.wait(100, abort.signal)).rejects.toThrow(message);
		const second = expect(completion.wait(100, abort.signal)).rejects.toThrow(message);
		completion.failed(99, "unrelated failure");
		completion.failed(1, message);
		await Promise.all([first, second]);
		await expect(completion.wait(100, abort.signal)).rejects.toThrow("No recording");
	});

	it("fails a superseded target instead of waiting for the next take", async () => {
		completion.started(1);
		const first = expect(completion.wait(100, abort.signal)).rejects.toThrow("replaced");
		completion.started(2, 456);
		await first;
		const second = completion.wait(100, abort.signal);
		completion.saved(1, "/old.mp4");
		completion.failed(1, "late error");
		completion.completed(1, { ...RESULT, videoPath: "/old.mp4" });
		completion.saved(2, RESULT.videoPath);
		completion.completed(2, RESULT);
		expect(await second).toMatchObject({ recordingStartedAt: 456 });
	});
});

describe("the saved recording result", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "recording-ready-"));
	});
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	async function savedProject(videoPath = path.join(dir, "take.mp4"), durationSec = 12) {
		const base = createEmptyDocument({ projectId: "proj_saved", title: "Take" });
		const doc = replaceTimeline(
			{
				...base,
				project: { ...base.project, primaryAssetId: "asset_screen" },
				assets: [
					{
						id: "asset_screen",
						kind: "video",
						label: "Take",
						originalPath: videoPath,
						durationSec,
						cameraTrack: null,
					},
				],
			},
			[{ startSec: 0, endSec: durationSec }],
			"Recorded",
		);
		const projectFile = path.join(dir, "project.openscreen");
		await fs.writeFile(projectFile, JSON.stringify(doc));
		return {
			doc,
			read: async () => JSON.parse(await fs.readFile(projectFile, "utf8")) as typeof doc,
			videoPath,
		};
	}

	it("reads the persisted project and verifies its actual media before resolving", async () => {
		const { read, videoPath } = await savedProject();
		await fs.writeFile(videoPath, "test media");
		completion.started(1, 123);
		completion.saved(1, videoPath);
		const waiting = completion.wait(100, abort.signal);
		await completion.projectReady(1, "proj_saved", read);
		expect(await waiting).toEqual({
			projectId: "proj_saved",
			videoPath,
			durationSec: 12,
			autoZooms: 0,
			recordingStartedAt: 123,
		});
	});

	it.each([
		"missing media",
		"empty media",
		"unmeasured duration",
		"different asset",
		"unreadable project",
	])("refuses success for %s", async (condition) => {
		const { read, videoPath } = await savedProject(
			condition === "different asset" ? path.join(dir, "import.mp4") : undefined,
			condition === "unmeasured duration" ? 60 : 12,
		);
		const target = path.join(dir, "take.mp4");
		if (condition !== "missing media")
			await fs.writeFile(videoPath, condition === "empty media" ? "" : "media");
		completion.started(1);
		completion.saved(1, target);
		const waiting = expect(completion.wait(100, abort.signal)).rejects.toThrow(
			"could not be prepared",
		);
		await completion.projectReady(
			1,
			"proj_saved",
			condition === "unreadable project"
				? async () => {
						throw new Error("disk failure");
					}
				: read,
		);
		await waiting;
	});

	it("does not deliver an old result if a new take starts while the project is being read", async () => {
		const { read, videoPath } = await savedProject();
		await fs.writeFile(videoPath, "media");
		completion.started(1);
		completion.saved(1, videoPath);
		const waiting = expect(completion.wait(100, abort.signal)).rejects.toThrow("replaced");
		let release: () => void = () => undefined;
		const opening = completion.projectReady(1, "proj_saved", async () => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return read();
		});
		completion.started(2);
		await waiting;
		release();
		await opening;
		const next = expect(completion.wait(1, abort.signal)).rejects.toThrow("Timed out");
		await vi.advanceTimersByTimeAsync(1);
		await next;
	});
});
