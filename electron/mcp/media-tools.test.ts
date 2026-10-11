// The media tools through the SDK's own client, beside the document tools they
// hand projects to: a real DocumentService on a temp directory, the real tool
// runner, and stand-ins for the runner windows and the video decoder.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CursorTelemetryPoint } from "../../src/components/video-editor/types";
import type { CliDoneResult, CliRequest } from "../../src/lib/cliContracts";
import { DocumentService } from "../ai-edition/document-service";
import type { RunnerHandlers } from "../cli/runnerHost";
import {
	frameTimes,
	MEDIA_PREAMBLE,
	type MediaToolDeps,
	pointerSamples,
	registerMediaTools,
} from "./media-tools";
import {
	createOpenScreenMcpServer,
	createToolRunner,
	type McpToolDeps,
} from "./openscreen-mcp-server";

/** The runner windows: records what was asked, answers like a runner would. */
class FakeRunners {
	readonly started: CliRequest[] = [];
	recordStarts = true;
	results: Partial<Record<CliRequest["kind"], CliDoneResult>> = {};
	/** Set: exports stay running until `releaseExport` is called. */
	holdExport = false;
	releaseExport: () => void = () => undefined;
	open = 0;

	constructor(private readonly videoPath: string) {}

	start(request: CliRequest, handlers: RunnerHandlers = {}) {
		this.started.push(request);
		this.open++;
		let finish: (result: CliDoneResult) => void = () => undefined;
		const done = new Promise<CliDoneResult>((resolve) => {
			finish = resolve;
		});
		let isOpen = true;
		const close = () => {
			if (isOpen) this.open--;
			isOpen = false;
		};
		const window = {
			webContents: {
				send: (channel: string) => {
					if (channel === "cli-stop-recording") {
						finish({ success: true, screenVideoPath: this.videoPath });
					}
				},
			},
		};
		const result = this.results[request.kind] ?? { success: true };
		if (request.kind === "export" && this.holdExport) {
			this.releaseExport = () => finish(result);
		} else if (request.kind !== "record") {
			finish(result);
		} else if (this.recordStarts) {
			queueMicrotask(() => handlers.onLog?.("info", "Recording started"));
		} else {
			finish({ success: false, error: "Recording did not start within 30s" });
		}
		return { window, done, close };
	}
}

/** A recorded take with one click at 4 s, its pointer moving until the end. */
function clickTrack(): CursorTelemetryPoint[] {
	const samples: CursorTelemetryPoint[] = [];
	for (let timeMs = 0; timeMs <= 12_000; timeMs += 100) {
		samples.push({ timeMs, cx: 0.7, cy: 0.3, interactionType: "move" });
	}
	samples.push({ timeMs: 4_000, cx: 0.7, cy: 0.3, interactionType: "click" });
	return samples.sort((a, b) => a.timeMs - b.timeMs);
}

function textOf(result: CallToolResult): string {
	const first = result.content[0];
	return first?.type === "text" ? first.text : "";
}

let dir = "";
let videoPath = "";
let documents: DocumentService;
let runners: FakeRunners;
let closed: number;
let openVideoFails: boolean;
let client: Client;

/** The pointer recorded with the take, as the sidecar beside the video. */
async function readSidecar(video: string): Promise<CursorTelemetryPoint[]> {
	try {
		return JSON.parse(await fs.readFile(`${video}.cursor.json`, "utf8")).samples;
	} catch {
		return [];
	}
}

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "media-tools-"));
	documents = new DocumentService(path.join(dir, "projects"), path.join(dir, "recordings"));
	videoPath = path.join(dir, "recordings", "take.mp4");
	// A take driven with the real mouse: its sidecar holds a click.
	await fs.mkdir(path.dirname(videoPath), { recursive: true });
	await fs.writeFile(`${videoPath}.cursor.json`, JSON.stringify({ samples: clickTrack() }));
	runners = new FakeRunners(videoPath);
	closed = 0;
	openVideoFails = false;

	const toolDeps: McpToolDeps = {
		host: { snapshot: async () => null, apply: async () => "no-editor" },
		projects: documents,
		editsAllowed: () => true,
		version: "test",
	};
	const runTool = createToolRunner(toolDeps);
	const server = createOpenScreenMcpServer(toolDeps, runTool, MEDIA_PREAMBLE);
	const deps: MediaToolDeps = {
		runners,
		documents,
		openVideo: async () => {
			if (openVideoFails) throw new Error("media error 4");
			return {
				durationSec: 12,
				width: 1920,
				height: 1080,
				capture: async (timeSec) => ({
					mimeType: "image/jpeg",
					data: Buffer.from(`frame@${timeSec}`).toString("base64"),
				}),
				close: () => {
					closed++;
				},
			};
		},
		readCursor: readSidecar,
		runTool,
		now: () => 1_000,
	};
	registerMediaTools(server, deps);

	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await server.connect(serverSide);
	client = new Client({ name: "test", version: "1" });
	await client.connect(clientSide);
});

afterEach(async () => {
	await client.close();
	await fs.rm(dir, { recursive: true, force: true });
});

const call = (name: string, args: Record<string, unknown> = {}) =>
	client.callTool({ name, arguments: args }) as Promise<CallToolResult>;

async function recordTake(title = "Demo") {
	await call("startRecording", { window: "My App" });
	const stopped = await call("stopRecording", { title });
	return JSON.parse(textOf(stopped)) as {
		projectId: string;
		checkpointId: string;
		videoPath: string;
		durationSec: number;
		autoZooms: number;
		recordingStartedAt: number;
	};
}

describe("frameTimes", () => {
	it("centres `count` frames in equal slices, and clamps asked-for times inside the video", () => {
		expect(frameTimes(12, null, 4)).toEqual([1.5, 4.5, 7.5, 10.5]);
		const [start, end] = frameTimes(10, [0, 99], 6);
		expect(start).toBe(0);
		expect(end).toBeLessThan(10);
	});
});

describe("recording", () => {
	it("records one window, then turns the take into a project the document tools can edit", async () => {
		const started = await call("startRecording", { window: "My App", systemAudio: true });
		expect(started.isError).toBeFalsy();
		expect(runners.started[0]).toMatchObject({
			kind: "record",
			windowTitle: "My App",
			systemAudio: true,
			mic: false,
			cursorMode: "editable-overlay",
		});

		const stopped = await call("stopRecording", { title: "Demo" });
		expect(stopped.isError).toBeFalsy();
		const take = JSON.parse(textOf(stopped));
		expect(take).toMatchObject({ durationSec: 12, recordingStartedAt: 1_000 });
		expect(take.autoZooms).toBeGreaterThan(0);
		expect(closed).toBe(1);

		const document = await documents.getProject(take.projectId);
		expect(document.project.title).toBe("Demo");
		expect(document.assets[0]).toMatchObject({
			originalPath: take.videoPath,
			durationSec: 12,
			video: { width: 1920, height: 1080 },
		});
		expect(document.timeline.clips).toHaveLength(1);
		expect(document.timeline.clips[0]).toMatchObject({ sourceStartSec: 0, sourceEndSec: 12 });
		expect(document.zoomRanges).toHaveLength(take.autoZooms);

		// The checkpoint it returns is the way back for the document tools' edits.
		const read = await call("getCurrentDocument", { projectId: take.projectId });
		expect(read.isError).toBeFalsy();
		const restored = await call("restoreCheckpoint", {
			projectId: take.projectId,
			checkpointId: take.checkpointId,
		});
		expect(restored.isError).toBeFalsy();
	});

	it("says where the take is when it cannot become a project", async () => {
		openVideoFails = true;
		await call("startRecording", { window: "My App" });
		const stopped = await call("stopRecording");
		expect(stopped.isError).toBe(true);
		expect(textOf(stopped)).toContain(videoPath);
		expect(textOf(stopped)).toContain("media error 4");
		expect(runners.open).toBe(0);
	});

	it("says why a recording did not start, and holds no take", async () => {
		runners.recordStarts = false;
		const started = await call("startRecording", { display: 1 });
		expect(started.isError).toBe(true);
		expect(textOf(started)).toContain("did not start within 30s");
		expect((await call("stopRecording")).isError).toBe(true);
	});

	it("saves a take once when two stops arrive together", async () => {
		await call("startRecording", { window: "My App" });
		const [first, second] = await Promise.all([call("stopRecording"), call("stopRecording")]);
		expect([first.isError ?? false, second.isError ?? false].sort()).toEqual([false, true]);
		expect(await documents.listProjects()).toHaveLength(1);
		// Saved and released: the next take may start.
		expect((await call("startRecording", {})).isError).toBeFalsy();
	});

	it("runs one take at a time, and no export during it", async () => {
		await call("startRecording", {});
		expect((await call("startRecording", {})).isError).toBe(true);
		const exported = await call("exportVideo", { projectId: "proj_x", path: "out.mp4" });
		expect(exported.isError).toBe(true);
		expect(textOf(exported)).toContain("recording is running");
	});
});

describe("pointerSamples", () => {
	const startedAt = 10_000;
	const samples = pointerSamples(
		[
			{ at: startedAt + 3_000, x: 0.8, y: 0.6, click: true },
			{ at: startedAt + 1_000, x: 0.2, y: 0.2 },
		],
		startedAt,
		5_000,
	);
	const at = (timeMs: number) => samples.find((s) => s.timeMs === timeMs);

	it("rests, then glides onto each action when it happened", () => {
		expect(at(1_000)).toMatchObject({ cx: 0.2, cy: 0.2, interactionType: "move" });
		expect(at(3_000)).toMatchObject({ cx: 0.8, cy: 0.6, interactionType: "click" });
		expect(at(3_080)).toMatchObject({ interactionType: "mouseup" });
		const midGlide = samples.find((s) => s.timeMs > 2_600 && s.timeMs < 2_900);
		expect(midGlide?.cx).toBeGreaterThan(0.2);
		expect(midGlide?.cx).toBeLessThan(0.8);
		// Still at the first point well before the glide to the second starts.
		expect(samples.find((s) => s.timeMs > 1_100 && s.timeMs < 2_300)?.cx).toBe(0.2);
	});

	it("is in time order, and keeps sampling to the end of the take", () => {
		const times = samples.map((s) => s.timeMs);
		expect(times).toEqual([...times].sort((a, b) => a - b));
		expect(times.at(-1)).toBeGreaterThan(4_900);
		expect(times.at(-1)).toBeLessThanOrEqual(5_000);
	});
});

describe("setPointerTrack", () => {
	it("gives a script-driven take a pointer, and a zoom on each click", async () => {
		// Driven through the DOM: the real pointer never moved, so nothing to zoom on.
		await fs.rm(`${videoPath}.cursor.json`);
		const take = await recordTake();
		expect(take.autoZooms).toBe(0);

		const events = [
			{ at: take.recordingStartedAt + 2_000, x: 0.3, y: 0.4 },
			{ at: take.recordingStartedAt + 5_000, x: 0.6, y: 0.5, click: true },
		];
		const set = await call("setPointerTrack", { projectId: take.projectId, events });
		expect(set.isError).toBeFalsy();
		const { autoZoomsAdded } = JSON.parse(textOf(set));
		expect(autoZoomsAdded).toBeGreaterThan(0);

		const written = await readSidecar(take.videoPath);
		expect(written.find((s) => s.interactionType === "click")).toMatchObject({
			timeMs: 5_000,
			cx: 0.6,
		});
		const document = await documents.getProject(take.projectId);
		expect(document.zoomRanges).toHaveLength(autoZoomsAdded);

		// Again: the zooms already there are kept clear of, not stacked.
		const again = await call("setPointerTrack", { projectId: take.projectId, events });
		expect(JSON.parse(textOf(again)).autoZoomsAdded).toBe(0);
	});

	it("applies two tracks sent together one after the other, neither one lost", async () => {
		await fs.rm(`${videoPath}.cursor.json`);
		const take = await recordTake();
		const track = (x: number) => ({
			projectId: take.projectId,
			events: [{ at: take.recordingStartedAt + 5_000, x, y: 0.5, click: true }],
		});
		const results = await Promise.all([
			call("setPointerTrack", track(0.4)),
			call("setPointerTrack", track(0.6)),
		]);
		expect(results.map((r) => r.isError ?? false)).toEqual([false, false]);
		// The later call wins the sidecar, and its zoom keeps clear of the earlier one's.
		const click = (await readSidecar(take.videoPath)).find((s) => s.interactionType === "click");
		expect(click?.cx).toBe(0.6);
	});

	it("refuses a project whose take this server did not record", async () => {
		const other = await documents.createProject("Imported");
		const refused = await call("setPointerTrack", {
			projectId: other.project.id,
			events: [{ at: 1, x: 0.5, y: 0.5 }],
		});
		expect(refused.isError).toBe(true);
		expect(textOf(refused)).toContain("not recorded by this server");
	});
});

describe("exportVideo", () => {
	it("renders the project's own file to the path asked for", async () => {
		const { projectId } = await recordTake();
		const outPath = path.join(dir, "demo.mp4");
		runners.results.export = {
			success: true,
			outputPath: outPath,
			format: "mp4",
			width: 1920,
			height: 1080,
		};
		const exported = await call("exportVideo", { projectId, path: outPath });
		expect(exported.isError).toBeFalsy();
		expect(JSON.parse(textOf(exported))).toMatchObject({ path: outPath, width: 1920 });
		expect(runners.started.at(-1)).toMatchObject({
			kind: "export",
			projectPath: documents.filePathFor(projectId),
			outPath,
			format: "mp4",
			quality: "good",
		});
	});

	it("runs one export at a time, and closes each runner once it is done", async () => {
		const { projectId } = await recordTake();
		runners.holdExport = true;
		const first = call("exportVideo", { projectId, path: path.join(dir, "a.mp4") });
		await new Promise((resolve) => setTimeout(resolve, 20));
		const second = await call("exportVideo", { projectId, path: path.join(dir, "b.mp4") });
		expect(second.isError).toBe(true);
		expect(textOf(second)).toContain("already running");
		// Nor may a take start while it renders.
		expect((await call("startRecording", {})).isError).toBe(true);

		runners.releaseExport();
		expect((await first).isError).toBeFalsy();
		expect(runners.open).toBe(0);
	});

	it("refuses a path that is not a video or an unknown project, and reports a failed render", async () => {
		const { projectId } = await recordTake();
		expect((await call("exportVideo", { projectId, path: "out.mov" })).isError).toBe(true);
		const unknown = await call("exportVideo", { projectId: "proj_x", path: "out.mp4" });
		expect(textOf(unknown)).toContain('No project has the id "proj_x"');
		runners.results.export = { success: false, error: "compositor exploded" };
		const failed = await call("exportVideo", { projectId, path: "out.gif" });
		expect(failed.isError).toBe(true);
		expect(textOf(failed)).toContain("compositor exploded");
		expect(runners.started.at(-1)).toMatchObject({ format: "gif" });
	});
});

describe("getFrames on a project", () => {
	it("reads the last export at the ruler seconds the document tools use", async () => {
		const { projectId } = await recordTake();
		expect(textOf(await call("getFrames", { projectId, atSec: [1] }))).toContain("no export yet");

		// A cut of 2 s early in the take: the ruler keeps a hole there, the export does not.
		expect((await call("addTrim", { projectId, startSec: 2, endSec: 4 })).isError).toBeFalsy();
		runners.results.export = { success: true, outputPath: path.join(dir, "demo.mp4") };
		await call("exportVideo", { projectId, path: path.join(dir, "demo.mp4") });

		const frames = await call("getFrames", { projectId, atSec: [1, 6] });
		const labels = frames.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
		expect(labels.slice(1)).toEqual([
			"1.00s on the ruler, 1.00s into the video",
			"6.00s on the ruler, 4.00s into the video",
		]);
		expect(labels[0]).not.toContain("changed after this export");

		// A cut made after the export is flagged, and does not move which frame of THAT video
		// a ruler second shows: the mapping is the exported document's.
		await call("addTrim", { projectId, startSec: 4.5, endSec: 5.5 });
		const stale = await call("getFrames", { projectId, atSec: [6] });
		expect(textOf(stale)).toContain("changed after this export");
		const staleLabels = stale.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
		expect(staleLabels[1]).toBe("6.00s on the ruler, 4.00s into the video");
	});

	it("takes a project or a file, not both", async () => {
		expect((await call("getFrames", {})).isError).toBe(true);
		expect((await call("getFrames", { projectId: "p", path: "x.mp4" })).isError).toBe(true);
	});
});

describe("getFrames", () => {
	it("returns each frame as an image, labelled with its time", async () => {
		const result = await call("getFrames", { path: "take.mp4", atSec: [1, 5] });
		const images = result.content.filter((part) => part.type === "image");
		expect(images).toHaveLength(2);
		expect(images[1]).toMatchObject({ mimeType: "image/jpeg" });
		expect(result.content.map((part) => (part.type === "text" ? part.text : "img"))).toEqual([
			expect.stringContaining("1920x1080"),
			"1.00s",
			"img",
			"5.00s",
			"img",
		]);
		expect(closed).toBe(1);
	});
});
