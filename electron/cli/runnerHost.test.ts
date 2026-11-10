import { EventEmitter } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { audioRenderPath, type CliRequest } from "../../src/lib/cliContracts";
import { createRunnerHost, type RunnerIpc } from "./runnerHost";

type Listener = (event: { sender: { id: number } }, ...args: unknown[]) => unknown;

/** `ipcMain`, reduced to what a runner window can call on it. */
class FakeIpc {
	readonly listeners = new Map<string, Listener>();
	handle(channel: string, listener: Listener) {
		this.listeners.set(channel, listener);
	}
	on(channel: string, listener: Listener) {
		this.listeners.set(channel, listener);
	}
	/** What the renderer of window `id` does when it calls `channel`. */
	call(id: number, channel: string, ...args: unknown[]) {
		return this.listeners.get(channel)?.({ sender: { id } }, ...args);
	}
}

/** Whatever a runner window event passes its listener. */
type WindowListener = (...args: never[]) => void;

class FakeWindow {
	readonly events = new EventEmitter();
	readonly webContents;
	destroyed = false;
	constructor(id: number) {
		const listen = (listener: WindowListener) => listener as (...args: unknown[]) => void;
		this.webContents = {
			id,
			once: (event: string, listener: WindowListener) => this.events.once(event, listen(listener)),
			on: (event: string, listener: WindowListener) => this.events.on(event, listen(listener)),
		};
	}
	isDestroyed() {
		return this.destroyed;
	}
	destroy() {
		this.destroyed = true;
		this.events.emit("destroyed");
	}
}

function setup() {
	const ipc = new FakeIpc();
	const opened: { windowType: string; window: FakeWindow }[] = [];
	let nextId = 1;
	const host = createRunnerHost(ipc as unknown as RunnerIpc, (windowType) => {
		const window = new FakeWindow(nextId++);
		opened.push({ windowType, window });
		return window;
	});
	return { ipc, host, opened };
}

const sources: CliRequest = { kind: "sources" };

function exportOf(dir: string, format: "wav" | "mp4" | null, out: string | null): CliRequest {
	return {
		kind: "export",
		projectPath: path.join(dir, "p.openscreen"),
		outPath: out,
		format,
		quality: null,
		mp4FrameRate: 60,
		gifFrameRate: null,
		gifSizePreset: null,
		gifLoop: null,
		autoZoom: false,
		audioPath: null,
		audioMode: "mix",
		audioOffsetSec: 0,
	};
}

describe("createRunnerHost", () => {
	it("hands each runner its own request and result, several at once", async () => {
		const { ipc, host, opened } = setup();
		const first = host.start(sources);
		const second = host.start({
			kind: "captions",
			projectPath: "/p.openscreen",
			minWordsPerCaption: 2,
			maxWordsPerCaption: 7,
		});
		expect(opened.map((o) => o.windowType)).toEqual(["cli-sources", "cli-captions"]);

		expect(ipc.call(2, "cli-get-request")).toMatchObject({ kind: "captions" });
		expect(ipc.call(1, "cli-get-request")).toEqual(sources);

		ipc.call(2, "cli-done", { success: true, captionCount: 3 });
		ipc.call(1, "cli-done", { success: false, error: "no display" });
		await expect(second.done).resolves.toEqual({ success: true, captionCount: 3 });
		await expect(first.done).resolves.toEqual({ success: false, error: "no display" });
	});

	it("removes the video an audio export rendered its audio from, and keeps a video export's", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "runner-host-"));
		const outPath = path.join(dir, "voice.wav");
		await writeFile(audioRenderPath(outPath), "mp4");
		await writeFile(path.join(dir, "demo.mp4"), "mp4");
		const { ipc, host } = setup();
		const audio = host.start(exportOf(dir, "wav", outPath));
		const video = host.start(exportOf(dir, "mp4", path.join(dir, "demo.mp4.render.mp4")));
		await writeFile(path.join(dir, "demo.mp4.render.mp4.render.mp4"), "mp4");
		// Without --out, a failed run reports no outputPath: the render beside p.wav still goes.
		const failed = host.start(exportOf(dir, "wav", null));
		await writeFile(audioRenderPath(path.join(dir, "p.wav")), "mp4");
		ipc.call(1, "cli-done", { success: true, outputPath: outPath });
		ipc.call(2, "cli-done", { success: true });
		ipc.call(3, "cli-done", { success: false, error: "render failed" });
		await audio.done;
		await video.done;
		await failed.done;
		expect((await readdir(dir)).sort()).toEqual(["demo.mp4", "demo.mp4.render.mp4.render.mp4"]);
		await rm(dir, { recursive: true, force: true });
	});

	it("reads an export's files in chunks and writes its output in place once committed", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "runner-host-"));
		const outPath = path.join(dir, "voice.wav");
		await writeFile(audioRenderPath(outPath), "0123456789");
		const { ipc, host } = setup();
		const run = host.start(exportOf(dir, "wav", outPath));

		expect(await ipc.call(1, "cli-export-file-size", "render")).toBe(10);
		const read = (await ipc.call(1, "cli-export-file-read", "render", 6, 100)) as ArrayBuffer;
		expect(Buffer.from(read).toString()).toBe("6789");

		// Out of order, as a muxer patches its header last.
		await ipc.call(1, "cli-export-file-write", Buffer.from("data"), 4);
		await ipc.call(1, "cli-export-file-write", Buffer.from("RIFF"), 0);
		expect(await readdir(dir)).not.toContain("voice.wav");
		await ipc.call(1, "cli-export-file-commit");
		expect(await readFile(outPath, "utf8")).toBe("RIFFdata");

		// Written again but not committed: the finished file stays as it is.
		await ipc.call(1, "cli-export-file-write", Buffer.from("XXXX"), 0);
		ipc.call(1, "cli-done", { success: false, error: "mix failed" });
		await run.done;
		expect(await readdir(dir)).toEqual(["voice.wav"]);
		expect(await readFile(outPath, "utf8")).toBe("RIFFdata");
		await rm(dir, { recursive: true, force: true });
	});

	it("refuses a file that is not the calling window's own export, and a chunk out of bounds", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "runner-host-"));
		await writeFile(path.join(dir, "p.mp4"), "mp4");
		const { ipc, host } = setup();
		host.start(exportOf(dir, null, null));
		host.start(sources);

		// A path is not a role, and a video export has no render.
		for (const file of [path.join(dir, "p.mp4"), "render", "../p.mp4"]) {
			await expect(ipc.call(1, "cli-export-file-size", file)).rejects.toThrow("Not a file");
		}
		// Without --out or --format, the output is the MP4 beside the project.
		expect(await ipc.call(1, "cli-export-file-size", "output")).toBe(3);
		for (const [offset, length] of [
			[-1, 1],
			[0, 0],
			[0.5, 1],
			[0, 64 * 1024 * 1024 + 1],
		]) {
			await expect(ipc.call(1, "cli-export-file-read", "output", offset, length)).rejects.toThrow(
				"Invalid chunk range",
			);
		}
		await expect(ipc.call(1, "cli-export-file-write", "text", 0)).rejects.toThrow("Invalid chunk");
		await expect(ipc.call(1, "cli-export-file-write", Buffer.from("x"), -1)).rejects.toThrow(
			"Invalid chunk position",
		);
		await expect(ipc.call(1, "cli-export-file-commit")).rejects.toThrow("wrote no output");
		// Another kind of runner, and a window that runs nothing.
		for (const id of [2, 9]) {
			await expect(ipc.call(id, "cli-export-file-size", "output")).rejects.toThrow("no export");
			await expect(ipc.call(id, "cli-export-file-write", Buffer.from("x"), 0)).rejects.toThrow(
				"no export",
			);
		}
		expect(await readdir(dir)).toEqual(["p.mp4"]);
		await rm(dir, { recursive: true, force: true });
	});

	it("routes logs and progress to the run they came from", () => {
		const { ipc, host } = setup();
		const logs: string[] = [];
		const progress: number[] = [];
		let asked = 0;
		host.start(sources, {
			onRequest: () => asked++,
			onLog: (level, message) => logs.push(`${level}:${message}`),
			onProgress: (p) => progress.push(p.percentage),
		});
		host.start(sources, { onLog: () => logs.push("wrong run") });

		ipc.call(1, "cli-get-request");
		ipc.call(1, "cli-log", "info", "Recording started");
		ipc.call(1, "cli-progress", { percentage: 40 });
		expect({ asked, logs, progress }).toEqual({
			asked: 1,
			logs: ["info:Recording started"],
			progress: [40],
		});
	});

	it("fails a run whose renderer crashes or whose page does not load, instead of hanging", async () => {
		const { host, opened } = setup();
		const crashed = host.start(sources);
		opened[0].window.events.emit("render-process-gone", {}, { reason: "oom" });
		await expect(crashed.done).resolves.toEqual({
			success: false,
			error: "Renderer crashed: oom",
		});

		const unloaded = host.start(sources);
		// A subframe failing is not the runner failing.
		opened[1].window.events.emit("did-fail-load", {}, -3, "ABORTED", "x", false);
		opened[1].window.events.emit("did-fail-load", {}, -6, "FILE_NOT_FOUND", "x", true);
		await expect(unloaded.done).resolves.toMatchObject({
			success: false,
			error: expect.stringContaining("FILE_NOT_FOUND (-6)"),
		});
	});

	it("closes a finished runner's window once, when asked", () => {
		const { host, opened } = setup();
		const run = host.start(sources);
		run.close();
		run.close();
		expect(opened[0].window.isDestroyed()).toBe(true);
	});

	it("fails a run whose window goes away, and ignores a second result", async () => {
		const { ipc, host, opened } = setup();
		const run = host.start(sources);
		opened[0].window.events.emit("destroyed");
		await expect(run.done).resolves.toMatchObject({ success: false });
		// Too late: the run is over, and nothing answers for an unknown window.
		expect(ipc.call(1, "cli-done", { success: true })).toBeUndefined();
		expect(ipc.call(1, "cli-get-request")).toBeNull();
	});
});
