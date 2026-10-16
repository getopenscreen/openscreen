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
	createMediaTools,
	frameTimes,
	type MediaToolDeps,
	mediaPreamble,
	pointerSamples,
	type TakeRecorder,
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
	/** The webcam the next take records beside the screen, if any. */
	webcam: { path: string; offsetMs: number } | null = null;
	results: Partial<Record<CliRequest["kind"], CliDoneResult>> = {};
	/** Set: exports stay running until `releaseExport` is called. */
	holdExport = false;
	releaseExport: () => void = () => undefined;
	private exportHeld: () => void = () => undefined;
	open = 0;

	constructor(private readonly videoPath: string) {}

	/**
	 * Holds exports until `releaseExport`. Resolves once one has started: by then the server
	 * counts it as running and has read the project it renders. A fixed sleep guessed at that
	 * moment, and lost the race whenever the full suite loaded the machine.
	 */
	holdExports(): Promise<void> {
		this.holdExport = true;
		return new Promise((resolve) => {
			this.exportHeld = resolve;
		});
	}

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
						finish({
							success: true,
							screenVideoPath: this.videoPath,
							...(this.webcam
								? { webcamVideoPath: this.webcam.path, webcamOffsetMs: this.webcam.offsetMs }
								: {}),
						});
					}
				},
			},
		};
		const result = this.results[request.kind] ?? { success: true };
		if (request.kind === "export" && this.holdExport) {
			this.releaseExport = () => finish(result);
			this.exportHeld();
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
/** The stdio server's media deps: the in-app tests reuse its stand-ins. */
let stdioDeps: MediaToolDeps;
/** The addon's frame renderer, when a test gives it one: none by default, as an older addon. */
let renderFrames: MediaToolDeps["renderFrames"];

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
	renderFrames = undefined;

	const toolDeps: McpToolDeps = {
		transport: "stdio",
		host: { snapshot: async () => null, apply: async () => "no-editor" },
		projects: documents,
		editsAllowed: () => true,
		version: "test",
	};
	const runTool = createToolRunner(toolDeps);
	stdioDeps = {
		transport: "stdio",
		editsAllowed: () => true,
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
		renderFrames: async (...args) => (renderFrames ? renderFrames(...args) : null),
		runTool,
		now: () => 1_000,
	};
	const server = createOpenScreenMcpServer(toolDeps, runTool, createMediaTools(stdioDeps));

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

describe("what `openscreen mcp` tells its client", () => {
	it("composes the media block with the checkpoint rule, and nothing true only in the app", () => {
		const instructions = client.getInstructions() ?? "";
		expect(instructions.startsWith(mediaPreamble("stdio"))).toBe(true);
		expect(instructions).toContain("Before a series of edits, call createCheckpoint");
		expect(instructions).toContain("in OpenScreen's memory while the app runs");
		expect(instructions).not.toMatch(
			/project open in the editor|Project edits|Agent edits|Nothing here records|undo step|exporting\)/,
		);
	});

	it("describes projectId and restoreCheckpoint as they work here", async () => {
		const { tools } = await client.listTools();
		const byName = new Map(tools.map((tool) => [tool.name, tool]));
		const projectId = byName.get("addTrim")?.inputSchema.properties?.projectId as {
			description?: string;
		};
		expect(projectId.description).toContain("only while the app runs");
		const restore = byName.get("restoreCheckpoint")?.description ?? "";
		expect(restore).toContain("pointer track");
		// Through the app's editor while it runs (app-channel.ts).
		expect(restore).toContain("one undo step");
	});

	it("answers in its own terms when no app answers: no editor, no Ctrl/Cmd+Z, its own lifetime", async () => {
		const noProject = await call("getCurrentDocument");
		expect(textOf(noProject)).toContain("OpenScreen is not running");
		expect(textOf(noProject)).not.toContain("No project is open");

		const other = await documents.createProject("Other");
		const unguarded = await call("setAspectRatio", {
			projectId: other.project.id,
			aspectRatio: "1:1",
		});
		expect(textOf(unguarded)).toContain("straight to the project's file");

		const unknown = await call("restoreCheckpoint", {
			projectId: other.project.id,
			checkpointId: "cp_nope",
		});
		expect(textOf(unknown)).toContain("this server when the client disconnects");
	});
});

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

	it("records the webcam asked for beside the screen, linked to the take as the editor links it", async () => {
		const webcamPath = path.join(dir, "recordings", "take-webcam.mp4");
		runners.webcam = { path: webcamPath, offsetMs: -192.8 };
		await call("startRecording", { display: 1, camera: "BRIO", cursor: "system" });
		expect(runners.started[0]).toMatchObject({
			kind: "record",
			displayIndex: 1,
			camera: true,
			cameraDevice: "BRIO",
			cursorMode: "system",
		});
		const take = JSON.parse(textOf(await call("stopRecording")));
		const document = await documents.getProject(take.projectId);
		expect(document.assets[0].cameraTrack).toEqual({
			sourcePath: webcamPath,
			startMs: 0,
			offsetMs: -193,
			visible: true,
			width: 1920,
			height: 1080,
		});
	});

	it("records no webcam unless asked, and the default camera for true", async () => {
		await call("startRecording", {});
		await call("stopRecording");
		await call("startRecording", { camera: true });
		expect(runners.started.filter((request) => request.kind === "record")).toMatchObject([
			{ camera: false, cameraDevice: null, cursorMode: "editable-overlay" },
			{ camera: true, cameraDevice: null },
		]);
	});

	it("lists the cameras beside the microphones", async () => {
		runners.results.sources = {
			success: true,
			sources: {
				displays: [{ index: 0, id: "screen:1", name: "Display 1" }],
				windows: [],
				microphones: [{ label: "USB Mic" }],
				microphoneLabelsUnavailable: false,
				cameras: [{ label: "Logitech BRIO", deviceId: "cam-1" }],
				cameraLabelsUnavailable: false,
			},
		};
		const listed = JSON.parse(textOf(await call("listSources")));
		expect(listed).toMatchObject({
			microphones: ["USB Mic"],
			cameras: ["Logitech BRIO"],
			cameraLabelsUnavailable: false,
		});
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

describe("createProject", () => {
	it("creates an empty project the document tools can edit at once", async () => {
		const created = await call("createProject", { title: "  Blank  " });
		expect(created.isError).toBeFalsy();
		const { projectId, checkpointId } = JSON.parse(textOf(created));
		expect(checkpointId).toEqual(expect.any(String));
		const document = await documents.getProject(projectId);
		expect(document.project.title).toBe("Blank");
		expect(document.assets).toEqual([]);
		// Its checkpoint lets an edit land on the file straight away.
		const renamed = await call("setProjectInfo", { projectId, title: "Named" });
		expect(renamed.isError).toBeFalsy();
		expect((await documents.getProject(projectId)).project.title).toBe("Named");
	});

	it("lays a video out as one clip, titled after the file, with the zooms of its clicks", async () => {
		await fs.writeFile(videoPath, "video");
		const created = await call("createProject", { videoPath });
		expect(created.isError).toBeFalsy();
		const result = JSON.parse(textOf(created));
		expect(result).toMatchObject({ durationSec: 12 });
		expect(result.autoZooms).toBeGreaterThan(0);
		const document = await documents.getProject(result.projectId);
		expect(document.project.title).toBe("take");
		expect(document.timeline.clips).toHaveLength(1);
		expect(document.assets[0]).toMatchObject({ originalPath: videoPath, durationSec: 12 });
	});

	it("creates nothing from a path it cannot use", async () => {
		const missing = await call("createProject", { videoPath: path.join(dir, "gone.mp4") });
		expect(missing.isError).toBe(true);
		expect(textOf(missing)).toContain("No file");
		const relative = await call("createProject", { videoPath: "take.mp4" });
		expect(textOf(relative)).toContain("must be absolute");
		await fs.writeFile(videoPath, "video");
		openVideoFails = true;
		const unreadable = await call("createProject", { videoPath });
		expect(textOf(unreadable)).toContain("media error 4");
		expect(await documents.listProjects()).toEqual([]);
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
	it("gives a script-driven take a pointer, and zooms on its clicks", async () => {
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

	/** The sidecar beside the take, byte for byte; `null` when there is none. */
	const sidecarFile = (video: string) =>
		fs.readFile(`${video}.cursor.json`, "utf8").catch(() => null);
	const clickAt = (take: { recordingStartedAt: number }, x: number) => [
		{ at: take.recordingStartedAt + 5_000, x, y: 0.5, click: true },
	];

	it("refuses a project open in the app's editor before writing anything", async () => {
		const take = await recordTake();
		const before = await sidecarFile(take.videoPath);
		documents.markOpenInEditor(take.projectId);
		const refused = await call("setPointerTrack", {
			projectId: take.projectId,
			events: clickAt(take, 0.2),
		});
		expect(refused.isError).toBe(true);
		expect(textOf(refused)).toContain("open in the OpenScreen editor");
		expect(await sidecarFile(take.videoPath)).toBe(before);
		expect((await documents.getProject(take.projectId)).zoomRanges).toHaveLength(take.autoZooms);
	});

	it("refuses a project with no checkpoint before writing anything", async () => {
		const take = await recordTake();
		const before = await sidecarFile(take.videoPath);
		// Twenty newer checkpoints push out the one stopRecording made.
		const other = await documents.createProject("Other");
		for (let i = 0; i < 20; i++) {
			await call("createCheckpoint", { projectId: other.project.id });
		}
		const refused = await call("setPointerTrack", {
			projectId: take.projectId,
			events: clickAt(take, 0.2),
		});
		expect(refused.isError).toBe(true);
		expect(textOf(refused)).toContain("createCheckpoint");
		expect(await sidecarFile(take.videoPath)).toBe(before);
	});

	it("is undone by restoreCheckpoint, the take's own pointer track included", async () => {
		const take = await recordTake();
		const before = await sidecarFile(take.videoPath);
		const set = await call("setPointerTrack", {
			projectId: take.projectId,
			events: clickAt(take, 0.2),
		});
		expect(set.isError).toBeFalsy();
		expect(await sidecarFile(take.videoPath)).not.toBe(before);

		const restored = await call("restoreCheckpoint", {
			projectId: take.projectId,
			checkpointId: take.checkpointId,
		});
		expect(restored.isError).toBeFalsy();
		expect(await sidecarFile(take.videoPath)).toBe(before);
		expect((await documents.getProject(take.projectId)).zoomRanges).toHaveLength(take.autoZooms);
	});

	it("takes away a track the take never had, and each checkpoint gets back its own", async () => {
		await fs.rm(`${videoPath}.cursor.json`);
		const take = await recordTake();
		await call("setPointerTrack", { projectId: take.projectId, events: clickAt(take, 0.2) });
		const first = await sidecarFile(take.videoPath);
		const second = JSON.parse(
			textOf(await call("createCheckpoint", { projectId: take.projectId })),
		).checkpointId;
		await call("setPointerTrack", { projectId: take.projectId, events: clickAt(take, 0.8) });

		await call("restoreCheckpoint", { projectId: take.projectId, checkpointId: take.checkpointId });
		expect(await sidecarFile(take.videoPath)).toBeNull();
		await call("restoreCheckpoint", { projectId: take.projectId, checkpointId: second });
		expect(await sidecarFile(take.videoPath)).toBe(first);
	});

	it("says the edit is partial when the project saved but the track could not be written", async () => {
		await fs.rm(`${videoPath}.cursor.json`);
		const take = await recordTake();
		// A directory where the sidecar goes: the save succeeds, the sidecar write cannot.
		await fs.mkdir(`${take.videoPath}.cursor.json`);
		const set = await call("setPointerTrack", {
			projectId: take.projectId,
			events: clickAt(take, 0.2),
		});
		expect(set.isError).toBe(true);
		expect(textOf(set)).toContain("The project was saved, but the pointer track");
		expect(textOf(set)).not.toContain("Tool failed");
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
			// Read by id: the app's current project and recording session stay as they are.
			projectId,
			outPath,
			format: "mp4",
			quality: "good",
			mp4FrameRate: 60,
		});
	});

	it("passes the Export dialog's options, and its defaults for those left out", async () => {
		const { projectId } = await recordTake();
		await call("exportVideo", { projectId, path: path.join(dir, "a.mp4"), fps: 30 });
		expect(runners.started.at(-1)).toMatchObject({ format: "mp4", mp4FrameRate: 30 });
		await call("exportVideo", {
			projectId,
			path: path.join(dir, "a.gif"),
			gifFrameRate: 25,
			gifSize: "small",
			gifLoop: false,
		});
		expect(runners.started.at(-1)).toMatchObject({
			format: "gif",
			quality: null,
			gifFrameRate: 25,
			gifSizePreset: "small",
			gifLoop: false,
		});
		await call("exportVideo", { projectId, path: path.join(dir, "b.gif") });
		expect(runners.started.at(-1)).toMatchObject({
			gifFrameRate: 15,
			gifSizePreset: "medium",
			gifLoop: true,
		});
	});

	it("refuses a choice the dialog does not offer, or an option of the other format", async () => {
		const { projectId } = await recordTake();
		const exports = () => runners.started.filter((request) => request.kind === "export").length;
		const before = exports();
		expect((await call("exportVideo", { projectId, path: "a.mp4", fps: 50 })).isError).toBe(true);
		expect((await call("exportVideo", { projectId, path: "a.gif", gifSize: "huge" })).isError).toBe(
			true,
		);
		const gifOnMp4 = await call("exportVideo", { projectId, path: "a.mp4", gifLoop: false });
		expect(textOf(gifOnMp4)).toContain("gifLoop: not for an MP4");
		const mp4OnGif = await call("exportVideo", {
			projectId,
			path: "a.gif",
			quality: "source",
			fps: 24,
		});
		expect(textOf(mp4OnGif)).toContain("quality, fps: not for a GIF");
		expect(exports()).toBe(before);
	});

	it("runs one export at a time, and closes each runner once it is done", async () => {
		const { projectId } = await recordTake();
		const held = runners.holdExports();
		const first = call("exportVideo", { projectId, path: path.join(dir, "a.mp4") });
		await held;
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

	it("keeps no record of an export the project changed during, or whose file was overwritten", async () => {
		const first = await recordTake("First");
		const out = path.join(dir, "demo.mp4");
		runners.results.export = { success: true, outputPath: out };

		const held = runners.holdExports();
		const exporting = call("exportVideo", { projectId: first.projectId, path: out });
		await held;
		await call("addTrim", { projectId: first.projectId, startSec: 2, endSec: 4 });
		runners.releaseExport();
		expect(textOf(await exporting)).toContain("changed while it exported");
		expect(textOf(await call("getFrames", { projectId: first.projectId }))).toContain(
			"no export yet",
		);

		runners.holdExport = false;
		await call("exportVideo", { projectId: first.projectId, path: out });
		expect(
			(await call("getFrames", { projectId: first.projectId, atSec: [1] })).isError,
		).toBeFalsy();
		// Another project's export to the same file replaces that video.
		const second = await documents.createProject("Second");
		await documents.addAsset(second.project.id, { path: videoPath });
		await call("exportVideo", { projectId: second.project.id, path: out });
		expect(textOf(await call("getFrames", { projectId: first.projectId }))).toContain(
			"no export yet",
		);
	});

	it("still shows the last export of a project deleted since", async () => {
		const { projectId } = await recordTake();
		runners.results.export = { success: true, outputPath: path.join(dir, "demo.mp4") };
		await call("exportVideo", { projectId, path: path.join(dir, "demo.mp4") });
		await documents.deleteProject(projectId);
		const frames = await call("getFrames", { projectId, atSec: [1] });
		expect(frames.isError).toBeFalsy();
		expect(frames.content.filter((part) => part.type === "image")).toHaveLength(1);
	});

	it("takes a project or a file, not both", async () => {
		expect((await call("getFrames", {})).isError).toBe(true);
		expect((await call("getFrames", { projectId: "p", path: "x.mp4" })).isError).toBe(true);
	});
});

describe("getFrames without an export that shows the project", () => {
	let asked: Array<{ clips: number; fps: number; frames: number[]; maxWidth: number }>;
	beforeEach(() => {
		asked = [];
		renderFrames = async (clips, _scene, fps, frames, maxWidth) => {
			asked.push({ clips: clips.length, fps, frames, maxWidth });
			return frames.map((index) => ({
				index,
				width: 1280,
				height: 720,
				jpeg: Buffer.from(`render@${index}`),
			}));
		};
	});
	const images = (result: CallToolResult) =>
		result.content.flatMap((part) =>
			part.type === "image" ? [Buffer.from(part.data, "base64").toString()] : [],
		);

	it("renders them from the project, on the export's frame grid, when it has no export", async () => {
		const { projectId } = await recordTake();
		// A cut of 2 s early in the take: ruler 6 s is 4 s into what the export would play.
		await call("addTrim", { projectId, startSec: 2, endSec: 4 });
		const frames = await call("getFrames", { projectId, atSec: [1, 6] });
		expect(frames.isError).toBeFalsy();
		expect(textOf(frames)).toContain("as its export would show them: it has no export yet");
		expect(asked).toEqual([{ clips: 2, fps: 60, frames: [60, 240], maxWidth: 1280 }]);
		expect(images(frames)).toEqual(["render@60", "render@240"]);
	});

	it("reads a current export, and renders again once the project changed after it", async () => {
		const { projectId } = await recordTake();
		runners.results.export = { success: true, outputPath: path.join(dir, "demo.mp4") };
		await call("exportVideo", { projectId, path: path.join(dir, "demo.mp4") });
		const fresh = await call("getFrames", { projectId, atSec: [1] });
		expect(fresh.content).toContainEqual({
			type: "text",
			text: "1.00s on the ruler, 1.00s into the video",
		});
		expect(asked).toEqual([]);

		await call("addTrim", { projectId, startSec: 2, endSec: 4 });
		const stale = await call("getFrames", { projectId, atSec: [6] });
		expect(textOf(stale)).toContain("it changed after its last export");
		expect(images(stale)).toEqual(["render@240"]);
	});

	it("says why it could not render, and asks for an export when the addon cannot", async () => {
		const { projectId } = await recordTake();
		renderFrames = async () => {
			throw new Error("no GPU");
		};
		const failed = await call("getFrames", { projectId, atSec: [1] });
		expect(failed.isError).toBe(true);
		expect(textOf(failed)).toContain("could not be rendered: no GPU");
		renderFrames = async () => null;
		expect(textOf(await call("getFrames", { projectId, atSec: [1] }))).toContain("no export yet");
	});

	it("names a frame the render did not return, and refuses a clip without media", async () => {
		const { projectId } = await recordTake();
		renderFrames = async () => [];
		const short = await call("getFrames", { projectId, atSec: [1] });
		expect(short.content).toContainEqual({
			type: "text",
			text: "No frame here: the rendered video ends before it.",
		});

		const document = await documents.getProject(projectId);
		// The schema requires a path on every asset: a clip has no media when its asset is gone.
		await documents.saveProject({
			...document,
			timeline: {
				...document.timeline,
				clips: document.timeline.clips.map((clip) => ({ ...clip, assetId: "gone" })),
			},
		});
		const missing = await call("getFrames", { projectId, atSec: [1] });
		expect(missing.isError).toBe(true);
		expect(textOf(missing)).toContain("no media file");
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

describe("the media tools in the app", () => {
	let allowed: boolean;
	let asked: Parameters<TakeRecorder["start"]>[0][];
	const appClients: Client[] = [];

	/** The in-app server, its takes made by the app's recorder (a stand-in here). */
	async function connectApp(): Promise<Client> {
		const toolDeps: McpToolDeps = {
			transport: "http",
			host: { snapshot: async () => null, apply: async () => "no-editor" },
			projects: documents,
			editsAllowed: () => allowed,
			version: "test",
		};
		const runTool = createToolRunner(toolDeps);
		const recorder: TakeRecorder = {
			async start(request) {
				asked.push(request);
				return {
					startedAt: 5_000,
					async stop(title) {
						const created = await documents.createProject(title ?? "Recording");
						const added = await documents.addAsset(created.project.id, { path: videoPath });
						// The editor has measured the take by the time the recorder hands it back.
						await documents.saveProject({
							...added,
							assets: added.assets.map((asset) => ({ ...asset, durationSec: 12 })),
						});
						return { projectId: created.project.id, videoPath, durationSec: 12, autoZooms: 1 };
					},
				};
			},
		};
		const media = createMediaTools({
			...stdioDeps,
			transport: "http",
			editsAllowed: () => allowed,
			recorder,
			runTool,
		});
		const server = createOpenScreenMcpServer(toolDeps, runTool, media);
		const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
		await server.connect(serverSide);
		const appClient = new Client({ name: "test", version: "1" });
		await appClient.connect(clientSide);
		appClients.push(appClient);
		return appClient;
	}

	beforeEach(() => {
		allowed = true;
		asked = [];
	});
	afterEach(async () => {
		for (const appClient of appClients.splice(0)) await appClient.close();
	});

	const callOn = (on: Client, name: string, args: Record<string, unknown> = {}) =>
		on.callTool({ name, arguments: args }) as Promise<CallToolResult>;

	it("records through the app's recorder, never a runner, and hands back the project with its checkpoint", async () => {
		const app = await connectApp();
		const started = await callOn(app, "startRecording", { window: "My App", microphone: "USB" });
		expect(started.isError).toBeFalsy();
		expect(asked).toEqual([
			{
				displayIndex: 0,
				windowTitle: "My App",
				mic: true,
				micDevice: "USB",
				systemAudio: false,
				camera: false,
				cameraDevice: null,
				cursorMode: "editable-overlay",
			},
		]);
		const take = JSON.parse(textOf(await callOn(app, "stopRecording", { title: "Demo" })));
		expect(take).toMatchObject({
			videoPath,
			durationSec: 12,
			autoZooms: 1,
			recordingStartedAt: 5_000,
		});
		expect(take.checkpointId).toMatch(/^cp_/);
		expect(runners.started.filter((request) => request.kind === "record")).toEqual([]);
		expect((await documents.getProject(take.projectId)).project.title).toBe("Demo");
		// setPointerTrack knows the take's clock, as for a take of `openscreen mcp`.
		const set = await callOn(app, "setPointerTrack", {
			projectId: take.projectId,
			events: [{ at: 5_000 + 4_000, x: 0.5, y: 0.5, click: true }],
		});
		expect(set.isError).toBeFalsy();
	});

	it("records and exports only while MCP edits is on, and says so in its instructions", async () => {
		allowed = false;
		const app = await connectApp();
		expect(app.getInstructions()).toContain(
			"startRecording, exportVideo and createProject are refused too while 'MCP edits'",
		);
		const started = await callOn(app, "startRecording", {});
		expect(started.isError).toBe(true);
		expect(textOf(started)).toContain("'MCP edits'");
		expect(asked).toEqual([]);
		const exported = await callOn(app, "exportVideo", {
			projectId: "proj_x",
			path: path.join(dir, "out.mp4"),
		});
		expect(textOf(exported)).toContain("'MCP edits'");
		expect(runners.started).toEqual([]);
		const created = await callOn(app, "createProject", {});
		expect(textOf(created)).toContain("'MCP edits'");
		expect(await documents.listProjects()).toEqual([]);
		// Reading stays open: listing what could be recorded changes nothing.
		runners.results.sources = {
			success: true,
			sources: {
				displays: [],
				windows: [],
				microphones: [],
				microphoneLabelsUnavailable: false,
				cameras: [],
				cameraLabelsUnavailable: false,
			},
		};
		expect((await callOn(app, "listSources")).isError).toBeFalsy();
	});

	it("takes only absolute paths: it has no working directory of the client's", async () => {
		const app = await connectApp();
		const exported = await callOn(app, "exportVideo", { projectId: "proj_x", path: "out.mp4" });
		expect(textOf(exported)).toContain("must be absolute");
		const frames = await callOn(app, "getFrames", { path: "take.mp4" });
		expect(textOf(frames)).toContain("must be absolute");
	});

	it("tells its client what is true in the app, and nothing true only of `openscreen mcp`", async () => {
		const app = await connectApp();
		const instructions = app.getInstructions() ?? "";
		expect(instructions.startsWith(mediaPreamble("http"))).toBe(true);
		expect(instructions).toContain("recording bar");
		expect(instructions).not.toContain("refused too");
		const { tools } = await app.listTools();
		const describeTool = (name: string) =>
			tools.find((tool) => tool.name === name)?.description ?? "";
		expect(describeTool("startRecording")).toContain("recording bar");
		expect(describeTool("startRecording")).not.toContain("On Linux the desktop's own picker");
		expect(describeTool("stopRecording")).toContain("editor opens the take");
		expect(describeTool("restoreCheckpoint")).toContain("pointer track");
		const exportPath = tools.find((tool) => tool.name === "exportVideo")?.inputSchema.properties
			?.path as { description?: string };
		expect(exportPath.description).toContain("absolute path ending in");
		expect(exportPath.description).not.toContain("working directory, ending");
	});
});
