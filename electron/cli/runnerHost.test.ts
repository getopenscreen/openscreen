import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { CliRequest } from "../../src/lib/cliContracts";
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
