// The media tools through the SDK's own client, beside the document tools they
// hand projects to: a real DocumentService on a temp directory, the real tool
// runner, and stand-ins for the runner windows and the video decoder.

import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CursorTelemetryPoint } from "../../src/components/video-editor/types";
import type { CliDoneResult, CliRequest } from "../../src/lib/cliContracts";
import { DocumentService } from "../ai-edition/document-service";
import type { RunnerHandlers } from "../cli/runnerHost";
import {
	createMediaTools,
	frameTimes,
	type MediaToolDeps,
	mediaPreamble,
	NO_WEBCAM_PICTURE,
	pointerSamples,
	type TakeRecorder,
} from "./media-tools";
import {
	createOpenScreenMcpServer,
	createToolRunner,
	type McpToolDeps,
} from "./openscreen-mcp-server";
import { RecordingCompletion } from "./recording-completion";

/** The runner windows: records what was asked, answers like a runner would. */
class FakeRunners {
	readonly started: CliRequest[] = [];
	recordStarts = true;
	/** The `run.done` error a failed record start reports, when `recordStarts` is false. */
	recordStartError: string | undefined;
	/** The webcam the next take records beside the screen, if any. */
	webcam: { path: string; offsetMs: number } | null = null;
	results: Partial<Record<CliRequest["kind"], CliDoneResult>> = {};
	/** Set: exports stay running until `releaseExport` is called. */
	holdExport = false;
	releaseExport: () => void = () => undefined;
	private exportHeld: () => void = () => undefined;
	/** What an audio render to a WAV writes, as the export runner would. */
	wav: Buffer | null = null;
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
		const rendersWav = request.kind === "export" && request.format === "wav";
		if (rendersWav && request.outPath && this.wav && result.success) {
			writeFileSync(request.outPath, this.wav);
		}
		if (request.kind === "export" && this.holdExport) {
			this.releaseExport = () => finish(result);
			this.exportHeld();
		} else if (request.kind !== "record") {
			finish(result);
		} else if (this.recordStarts) {
			queueMicrotask(() => handlers.onLog?.("info", "Recording started"));
		} else {
			finish({
				success: false,
				error: this.recordStartError ?? "Recording did not start within 30s",
			});
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
/** The widths the video decoder was asked for its frames at, in order. */
let capturedWidths: number[];
let openVideoFails: boolean;
let client: Client;
let media: ReturnType<typeof createMediaTools>;
/** The stdio server's media deps: the in-app tests reuse its stand-ins. */
let stdioDeps: MediaToolDeps;
/** The addon's frame renderer, when a test gives it one: none by default, as an older addon. */
let renderFrames: MediaToolDeps["renderFrames"];
/** The tool calls the server reported for the usage count: names, in order. */
let countedCalls: string[];

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
	capturedWidths = [];
	openVideoFails = false;
	renderFrames = undefined;
	countedCalls = [];

	const toolDeps: McpToolDeps = {
		transport: "stdio",
		host: { snapshot: async () => null, apply: async () => "no-editor" },
		projects: documents,
		editsAllowed: () => true,
		version: "test",
		onToolCall: (name) => countedCalls.push(name),
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
				capture: async (timeSec, maxWidth) => {
					capturedWidths.push(maxWidth);
					return {
						mimeType: "image/jpeg",
						data: Buffer.from(`frame@${timeSec}`).toString("base64"),
					};
				},
				close: () => {
					closed++;
				},
			};
		},
		readCursor: readSidecar,
		renderFrames: async (...args) => (renderFrames ? renderFrames(...args) : null),
		// The host's image codec: a frame decodes to a flat 16:9 picture as wide as asked, and
		// a crop or a sheet says what it was made from.
		images: {
			decode: (jpeg, maxWidth) => {
				// A frame marked tall decodes square: a file whose size changes midway.
				const height = jpeg.includes("tall") ? maxWidth : Math.round((maxWidth * 9) / 16);
				const pixels = Buffer.alloc(maxWidth * height * 4, 7);
				// A frame that names a box holds one: two frames can then differ somewhere known.
				const box = /box (\d+),(\d+) (\d+)x(\d+)/.exec(jpeg.toString());
				if (box) {
					const [left, top, boxWidth, boxHeight] = box.slice(1).map(Number);
					for (let y = top; y < top + boxHeight; y++) {
						const row = (y * maxWidth + left) * 4;
						pixels.fill(200, row, row + boxWidth * 4);
					}
				}
				return { width: maxWidth, height, pixels };
			},
			encode: (bitmap) => Buffer.from(`sheet ${bitmap.width}x${bitmap.height}`),
			crop: (jpeg, region, maxWidth) =>
				Buffer.from(
					`${jpeg} cropped to ${region.x},${region.y} ${region.width}x${region.height} within ${maxWidth}`,
				),
		},
		runTool,
		now: () => 1_000,
	};
	media = createMediaTools(stdioDeps);
	const server = createOpenScreenMcpServer(toolDeps, runTool, media);

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

describe("the usage count", () => {
	it("is told the name of each tool a client calls, and nothing of the call", async () => {
		const { projectId } = await recordTake();
		// A media tool, a document tool, and a call that is refused: all three were calls.
		await call("getFrames", { path: "take.mp4", atSec: [1] });
		await call("addTrim", { projectId, startSec: 2, endSec: 4 });
		await call("getFrames", {});
		expect(countedCalls).toEqual([
			"startRecording",
			"stopRecording",
			"getFrames",
			"addTrim",
			"getFrames",
		]);
	});
});

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
	it("stays busy until a stopped take has finished saving its project", async () => {
		expect(media.isBusy()).toBe(false);
		await call("startRecording", { window: "My App" });
		expect(media.isBusy()).toBe(true);
		let releaseSave: () => void = () => undefined;
		const saveGate = new Promise<void>((resolve) => {
			releaseSave = resolve;
		});
		let savingStarted: () => void = () => undefined;
		const saving = new Promise<void>((resolve) => {
			savingStarted = resolve;
		});
		const createProject = documents.createProject.bind(documents);
		vi.spyOn(documents, "createProject").mockImplementation(async (...args) => {
			savingStarted();
			await saveGate;
			return createProject(...args);
		});
		const stopped = call("stopRecording", { title: "Update waits for this save" });
		await saving;
		expect(runners.open).toBe(0);
		expect(media.isBusy()).toBe(true);
		releaseSave();
		expect((await stopped).isError).toBeFalsy();
		expect(media.isBusy()).toBe(false);
	});
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

	it("says so when the webcam asked for recorded no picture", async () => {
		await call("startRecording", { camera: true });
		expect(JSON.parse(textOf(await call("stopRecording"))).warnings).toEqual([NO_WEBCAM_PICTURE]);
		await call("startRecording", {});
		expect(JSON.parse(textOf(await call("stopRecording"))).warnings).toBeUndefined();
	});

	it("records no webcam unless asked, and the user's camera for true", async () => {
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

	it("carries the recorder's own failure reason to the client", async () => {
		runners.recordStarts = false;
		const reason =
			'The ScreenCast portal does not advertise METADATA cursor mode, so real cursor positions cannot be obtained on this session. Retry with "cursor": "system" to record with the system cursor baked in.';
		runners.recordStartError = reason;
		const started = await call("startRecording", { display: 1 });
		expect(started.isError).toBe(true);
		expect(textOf(started)).toContain(reason);
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
	it.each([
		false,
		true,
	])("keeps project creation busy through its checkpoint (video=%s)", async (video) => {
		await fs.writeFile(videoPath, "video");
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reachedCheckpoint: () => void = () => undefined;
		const checkpoint = new Promise<void>((resolve) => {
			reachedCheckpoint = resolve;
		});
		const runTool = stdioDeps.runTool;
		vi.spyOn(stdioDeps, "runTool").mockImplementation(async (...args) => {
			if (args[0] === "createCheckpoint") {
				reachedCheckpoint();
				await gate;
			}
			return runTool(...args);
		});
		const creating = call("createProject", video ? { videoPath } : { title: "Blank" });
		await checkpoint;
		const busyWhileSaving = media.isBusy();
		release();
		const created = await creating;
		expect(created.isError).toBeFalsy();
		expect(busyWhileSaving).toBe(true);
		expect(media.isBusy()).toBe(false);
	});

	it("clears project-creation activity after a failed save", async () => {
		vi.spyOn(documents, "createProject").mockRejectedValueOnce(new Error("disk unavailable"));
		expect((await call("createProject", { title: "Fails" })).isError).toBe(true);
		expect(media.isBusy()).toBe(false);
	});
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

	it("refuses a project with no video", async () => {
		const other = await documents.createProject("Empty");
		const refused = await call("setPointerTrack", {
			projectId: other.project.id,
			events: [{ at: 1, x: 0.5, y: 0.5 }],
			recordingStartedAt: 0,
		});
		expect(refused.isError).toBe(true);
		expect(textOf(refused)).toContain("no video");
	});

	it("asks for recordingStartedAt for a video it did not record, before writing anything", async () => {
		await fs.rm(`${videoPath}.cursor.json`);
		await fs.writeFile(videoPath, "video");
		const { projectId } = JSON.parse(textOf(await call("createProject", { videoPath })));
		const refused = await call("setPointerTrack", {
			projectId,
			events: [{ at: 5_000, x: 0.5, y: 0.5, click: true }],
		});
		expect(refused.isError).toBe(true);
		expect(textOf(refused)).toContain("not recorded by this server");
		expect(textOf(refused)).toContain("recordingStartedAt");
		expect(await sidecarFile(videoPath)).toBeNull();
	});

	it("gives a video from createProject a pointer on the client's clock, undone by its checkpoint", async () => {
		// A capture made frame by frame: its actions are logged in milliseconds into the video.
		await fs.rm(`${videoPath}.cursor.json`);
		await fs.writeFile(videoPath, "video");
		const created = JSON.parse(textOf(await call("createProject", { videoPath })));
		expect(created.autoZooms).toBe(0);

		const set = await call("setPointerTrack", {
			projectId: created.projectId,
			events: [
				{ at: 2_000, x: 0.3, y: 0.4 },
				{ at: 5_000, x: 0.6, y: 0.5, click: true },
			],
			recordingStartedAt: 0,
		});
		expect(set.isError).toBeFalsy();
		const { autoZoomsAdded } = JSON.parse(textOf(set));
		expect(autoZoomsAdded).toBeGreaterThan(0);
		const click = (await readSidecar(videoPath)).find((s) => s.interactionType === "click");
		expect(click).toMatchObject({ timeMs: 5_000, cx: 0.6 });
		expect((await documents.getProject(created.projectId)).zoomRanges).toHaveLength(autoZoomsAdded);

		const restored = await call("restoreCheckpoint", {
			projectId: created.projectId,
			checkpointId: created.checkpointId,
		});
		expect(restored.isError).toBeFalsy();
		expect(await sidecarFile(videoPath)).toBeNull();
		expect((await documents.getProject(created.projectId)).zoomRanges).toHaveLength(0);
	});

	it("puts the client's recordingStartedAt before the take's own", async () => {
		await fs.rm(`${videoPath}.cursor.json`);
		const take = await recordTake();
		await call("setPointerTrack", {
			projectId: take.projectId,
			events: clickAt(take, 0.5),
			recordingStartedAt: take.recordingStartedAt + 1_000,
		});
		const click = (await readSidecar(take.videoPath)).find((s) => s.interactionType === "click");
		expect(click?.timeMs).toBe(4_000);
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

describe("exportAudio", () => {
	it("renders the project's audio, or one track of it, to the path asked for", async () => {
		const { projectId } = await recordTake();
		const outPath = path.join(dir, "voice.m4a");
		runners.results.export = { success: true, outputPath: outPath, format: "m4a" };
		const exported = await call("exportAudio", { projectId, path: outPath, audioId: "audio_1" });
		expect(exported.isError).toBeFalsy();
		expect(JSON.parse(textOf(exported))).toEqual({ path: outPath, format: "m4a" });
		expect(runners.started.at(-1)).toMatchObject({
			kind: "export",
			projectPath: documents.filePathFor(projectId),
			projectId,
			outPath,
			format: "m4a",
			mp4FrameRate: 60,
			audioTrackId: "audio_1",
		});
		await call("exportAudio", { projectId, path: path.join(dir, "mix.wav") });
		expect(runners.started.at(-1)).toMatchObject({ format: "wav", audioTrackId: null });
		expect(runners.open).toBe(0);
	});

	it("refuses a path that is not audio or an unknown project, and reports a failed render", async () => {
		const { projectId } = await recordTake();
		const exports = () => runners.started.filter((request) => request.kind === "export").length;
		const before = exports();
		expect((await call("exportAudio", { projectId, path: "out.mp3" })).isError).toBe(true);
		const unknown = await call("exportAudio", { projectId: "proj_x", path: "out.wav" });
		expect(textOf(unknown)).toContain('No project has the id "proj_x"');
		expect(exports()).toBe(before);
		runners.results.export = { success: false, error: "no audio track" };
		const failed = await call("exportAudio", { projectId, path: "out.wav" });
		expect(textOf(failed)).toContain("no audio track");
	});
});

describe("exportCaptions", () => {
	/** The take with two spoken lines in its transcript. */
	async function spokenTake() {
		const { projectId } = await recordTake();
		const project = await documents.getProject(projectId);
		const assetId = project.project.primaryAssetId as string;
		const word = (
			id: string,
			segmentId: string,
			startSec: number,
			endSec: number,
			text: string,
		) => ({
			id,
			segmentId,
			startSec,
			endSec,
			text,
		});
		await documents.saveProject({
			...project,
			transcripts: [
				{
					assetId,
					language: "en",
					segments: [
						{
							id: "s1",
							kind: "speech",
							startSec: 1,
							endSec: 2,
							text: "hello there",
							wordIds: ["w1", "w2"],
						},
						{ id: "s2", kind: "speech", startSec: 4, endSec: 5, text: "goodbye", wordIds: ["w3"] },
					],
					words: [
						word("w1", "s1", 1, 1.5, "hello"),
						word("w2", "s1", 1.5, 2, "there"),
						word("w3", "s2", 4, 5, "goodbye"),
					],
				},
			],
		});
		return projectId;
	}

	it("writes the captions to the subtitle file the extension names", async () => {
		const projectId = await spokenTake();
		const srt = path.join(dir, "demo.srt");
		const written = await call("exportCaptions", { projectId, path: srt });
		expect(written.isError).toBeFalsy();
		expect(JSON.parse(textOf(written))).toEqual({
			path: srt,
			format: "srt",
			language: null,
			entries: 2,
		});
		expect(await fs.readFile(srt, "utf8")).toBe(
			"1\n00:00:01,000 --> 00:00:02,000\nhello there\n\n2\n00:00:04,000 --> 00:00:05,000\ngoodbye\n",
		);
		const vtt = path.join(dir, "demo.vtt");
		await call("exportCaptions", { projectId, path: vtt });
		expect((await fs.readFile(vtt, "utf8")).startsWith("WEBVTT\n\n00:00:01.000")).toBe(true);
		// Nothing is rendered for it.
		expect(runners.started.filter((request) => request.kind === "export")).toHaveLength(0);
	});

	it("refuses a project with no words, a layer it lacks, another extension or an unknown project", async () => {
		const { projectId } = await recordTake();
		const empty = await call("exportCaptions", { projectId, path: path.join(dir, "none.srt") });
		expect(empty.isError).toBe(true);
		expect(textOf(empty)).toContain("transcribe");
		await expect(fs.access(path.join(dir, "none.srt"))).rejects.toThrow();

		const spoken = await spokenTake();
		const layer = await call("exportCaptions", {
			projectId: spoken,
			path: path.join(dir, "fr.srt"),
			language: "fr",
		});
		expect(textOf(layer)).toContain('no "fr" caption translation');
		expect((await call("exportCaptions", { projectId: spoken, path: "out.txt" })).isError).toBe(
			true,
		);
		const unknown = await call("exportCaptions", { projectId: "proj_x", path: "out.srt" });
		expect(textOf(unknown)).toContain('No project has the id "proj_x"');
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

/** What a frame result says of each frame, without its opening line. */
const captionsOf = (result: CallToolResult) =>
	result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).slice(1);

/** The picture of a result, as the stand-in codec wrote it. */
const pictureOf = (result: CallToolResult) => {
	const image = result.content.find((part) => part.type === "image");
	return image?.type === "image" ? Buffer.from(image.data, "base64").toString() : null;
};

describe("frameTimes over a span", () => {
	it("runs from one end of the span to the other, both shown", () => {
		expect(frameTimes(12, null, 3, { startSec: 2, endSec: 4 })).toEqual([2, 3, 4]);
		expect(frameTimes(12, null, 1, { startSec: 2, endSec: 4 })).toEqual([3]);
		expect(frameTimes(12, null, 2, { endSec: 6 })).toEqual([0, 6]);
		// An open end is the video's own, one frame short of it.
		const toTheEnd = frameTimes(12, null, 2, { startSec: 10 });
		expect(toTheEnd[0]).toBe(10);
		expect(toTheEnd[1]).toBeGreaterThan(11.9);
		expect(toTheEnd[1]).toBeLessThan(12);
		// A span past the end shows the last frame, never a time the video does not have.
		const past = frameTimes(12, null, 2, { startSec: 20, endSec: 30 });
		expect(past).toHaveLength(2);
		for (const t of past) expect(t).toBeCloseTo(12 - 1 / 60, 6);
	});
});

describe("getFrames over a span and on a region", () => {
	it("spreads the frames from startSec to endSec", async () => {
		const result = await call("getFrames", {
			path: "take.mp4",
			startSec: 2,
			endSec: 4,
			count: 3,
		});
		expect(captionsOf(result)).toEqual(["2.00s", "3.00s", "4.00s"]);
		expect(capturedWidths).toEqual([1280, 1280, 1280]);
	});

	it("takes times or a span, not both, and a span that runs forward", async () => {
		const both = await call("getFrames", { path: "take.mp4", atSec: [1], startSec: 0 });
		expect(both.isError).toBe(true);
		expect(textOf(both)).toContain("not both");
		const backwards = await call("getFrames", { path: "take.mp4", startSec: 4, endSec: 2 });
		expect(backwards.isError).toBe(true);
		expect(textOf(backwards)).toContain("endSec must be after startSec");
	});

	it("crops each frame to the region, out of the video at its own size", async () => {
		const result = await call("getFrames", {
			path: "take.mp4",
			atSec: [1],
			region: { x: 0.5, y: 0, width: 0.5, height: 0.5 },
		});
		expect(pictureOf(result)).toBe("frame@1 cropped to 0.5,0 0.5x0.5 within 1280");
		// Asked wider than any video, so the crop is cut from every pixel the frame has.
		expect(capturedWidths).toEqual([16_384]);
	});

	it("renders a project's frames at full size before it crops them", async () => {
		const { projectId } = await recordTake();
		const widths: number[] = [];
		renderFrames = async (_clips, _scene, _fps, frames, maxWidth) => {
			widths.push(maxWidth);
			return frames.map((index) => ({
				index,
				width: 1920,
				height: 1080,
				jpeg: Buffer.from(`render@${index}`),
			}));
		};
		const result = await call("getFrames", {
			projectId,
			atSec: [1],
			region: { x: 0, y: 0, width: 0.25, height: 0.25 },
		});
		expect(pictureOf(result)).toBe("render@60 cropped to 0,0 0.25x0.25 within 1280");
		expect(widths).toEqual([16_384]);
	});
});

describe("getContactSheet", () => {
	it("makes the rows as tall as the tallest frame, so none is cut", async () => {
		const { projectId } = await recordTake();
		renderFrames = async (_clips, _scene, _fps, frames, maxWidth) =>
			frames.map((index, i) => ({
				index,
				width: maxWidth,
				height: 359,
				jpeg: Buffer.from(i === 1 ? `render@${index} tall` : `render@${index}`),
			}));
		const result = await call("getContactSheet", { projectId, atSec: [1, 2], columns: 2 });
		// The second frame decodes 639 px square, taller than the first: the row takes its height.
		expect(pictureOf(result)).toBe(`sheet ${2 * 639 + 2}x639`);
	});

	it("lays a video's frames out on one image, and says the times in reading order", async () => {
		const result = await call("getContactSheet", {
			path: "take.mp4",
			startSec: 0,
			endSec: 10,
			count: 6,
			columns: 3,
		});
		expect(result.isError).toBeFalsy();
		expect(result.content).toHaveLength(2);
		expect(textOf(result)).toContain(
			"3 across, in reading order: 0.00s, 2.00s, 4.00s, 6.00s, 8.00s, 10.00s.",
		);
		// Three tiles of 425 px and two gaps wide; two rows of 239 px and one gap high.
		expect(pictureOf(result)).toBe("sheet 1279x480");
		// Each frame is asked for at the width of its tile, never larger.
		expect(capturedWidths).toEqual(Array(6).fill(425));
		expect(closed).toBe(1);
	});

	it("shows twelve moments of the whole film, four across, rendered from a project with no export", async () => {
		const { projectId } = await recordTake();
		const asked: Array<{ frames: number; maxWidth: number }> = [];
		renderFrames = async (_clips, _scene, _fps, frames, maxWidth) => {
			asked.push({ frames: frames.length, maxWidth });
			return frames.map((index) => ({
				index,
				width: maxWidth,
				height: 179,
				jpeg: Buffer.from(`render@${index}`),
			}));
		};
		const result = await call("getContactSheet", { projectId });
		expect(asked).toEqual([{ frames: 12, maxWidth: 318 }]);
		expect(textOf(result)).toContain("rendered from the project");
		expect(textOf(result)).toContain("4 across");
		// Three rows of four tiles, 318 by 179.
		expect(pictureOf(result)).toBe(`sheet ${4 * 318 + 3 * 2}x${3 * 179 + 2 * 2}`);
	});

	it("keeps the place and the time of a frame the video does not have", async () => {
		const { projectId } = await recordTake();
		renderFrames = async (_clips, _scene, _fps, frames, maxWidth) =>
			frames.slice(0, 1).map((index) => ({
				index,
				width: maxWidth,
				height: 360,
				jpeg: Buffer.from("the only frame"),
			}));
		const partial = await call("getContactSheet", { projectId, atSec: [1, 2], columns: 2 });
		expect(textOf(partial)).toContain("in reading order: 1.00s, 2.00s.");
		expect(pictureOf(partial)).toBe(`sheet ${2 * 639 + 2}x359`);

		renderFrames = async () => [];
		const none = await call("getContactSheet", { projectId, atSec: [1] });
		expect(none.isError).toBe(true);
		expect(textOf(none)).toContain("No frame to show");
	});

	it("cuts the region out of the full-size frame before it makes a tile of it", async () => {
		const result = await call("getContactSheet", {
			path: "take.mp4",
			atSec: [1],
			columns: 2,
			region: { x: 0, y: 0, width: 0.5, height: 0.5 },
		});
		expect(result.isError).toBeFalsy();
		expect(capturedWidths).toEqual([16_384]);
	});

	it("labels a file's frame with the time it was taken at, not a time past the end", async () => {
		const result = await call("getContactSheet", { path: "take.mp4", atSec: [20], columns: 2 });
		expect(textOf(result)).toContain("in reading order: 11.98s.");
	});

	it("puts more frames across as there are more of them, unless told how many", async () => {
		const many = await call("getContactSheet", { path: "take.mp4", count: 30 });
		expect(textOf(many)).toContain("6 across");
		const some = await call("getContactSheet", { path: "take.mp4", count: 20 });
		expect(textOf(some)).toContain("5 across");
		const asked = await call("getContactSheet", { path: "take.mp4", count: 30, columns: 3 });
		expect(textOf(asked)).toContain("3 across");
	});

	it("takes a project or a file like getFrames, and refuses the same mistakes", async () => {
		expect((await call("getContactSheet", {})).isError).toBe(true);
		const both = await call("getContactSheet", { path: "take.mp4", atSec: [1], endSec: 3 });
		expect(textOf(both)).toContain("not both");
	});
});

describe("getBeforeAfter", () => {
	const momentsOf = (result: CallToolResult) => {
		const report = result.content[1];
		return report?.type === "text" ? JSON.parse(report.text).moments : null;
	};
	/** What each render was asked for: how many clips, which frames, how wide. */
	let asked: Array<{ clips: number; frames: number[]; maxWidth: number }>;
	// The project's frames hold a box once it is cut in two: somewhere known to differ.
	beforeEach(() => {
		asked = [];
		renderFrames = async (clips, _scene, _fps, frames, maxWidth) => {
			asked.push({ clips: clips.length, frames, maxWidth });
			return frames.map((index) => ({
				index,
				width: maxWidth,
				height: 359,
				jpeg: Buffer.from(
					clips.length > 1 ? `render@${index} box 64,36 128x72` : `render@${index}`,
				),
			}));
		};
	});

	it("pairs each moment at the checkpoint with the same moment now, and says where they differ", async () => {
		const { projectId, checkpointId } = await recordTake();
		const untouched = await call("getBeforeAfter", { projectId, checkpointId, atSec: [1, 6] });
		expect(momentsOf(untouched)).toEqual([
			{ sec: 1, changed: false },
			{ sec: 6, changed: false },
		]);

		// A cut of 2 s: ruler 6 s was frame 360 of the export, and is now frame 240.
		await call("addTrim", { projectId, startSec: 2, endSec: 4 });
		const edited = await documents.getProject(projectId);
		asked = [];
		const result = await call("getBeforeAfter", { projectId, checkpointId, atSec: [1, 6] });
		expect(result.isError).toBeFalsy();
		expect(textOf(result)).toContain("left, at the checkpoint; right, as it is now");
		// The checkpoint first, then the project as it is, each at the width of its tile.
		expect(asked).toEqual([
			{ clips: 1, frames: [60, 360], maxWidth: 639 },
			{ clips: 2, frames: [60, 240], maxWidth: 639 },
		]);
		// Two rows of two tiles, 639 by 359, and the gaps between them.
		expect(pictureOf(result)).toBe(`sheet ${2 * 639 + 2}x${2 * 359 + 2}`);
		const box = { x: 0.1002, y: 0.1003, width: 0.2003, height: 0.2006 };
		expect(momentsOf(result)).toEqual([
			{ sec: 1, changed: true, changedShare: 0.0402, region: box },
			{ sec: 6, changed: true, changedShare: 0.0402, region: box },
		]);
		// Looking changed nothing: the edit is still there, and so is the checkpoint.
		expect(await documents.getProject(projectId)).toEqual(edited);
		const restored = await call("restoreCheckpoint", { projectId, checkpointId });
		expect(restored.isError).toBeFalsy();
	});

	it("compares one part of the frame at full size, and places the change in the whole frame", async () => {
		const { projectId, checkpointId } = await recordTake();
		await call("addTrim", { projectId, startSec: 2, endSec: 4 });
		asked = [];
		const result = await call("getBeforeAfter", {
			projectId,
			checkpointId,
			atSec: [1],
			region: { x: 0.5, y: 0, width: 0.5, height: 1 },
		});
		expect(asked.map((render) => render.maxWidth)).toEqual([16_384, 16_384]);
		// The box sits at a tenth of the right half: just past the middle of the frame.
		expect(momentsOf(result)).toEqual([
			{
				sec: 1,
				changed: true,
				changedShare: 0.0402,
				region: { x: 0.5501, y: 0.1003, width: 0.1002, height: 0.2006 },
			},
		]);
	});

	it("says a side that has no frame changed, without pointing anywhere", async () => {
		const { projectId, checkpointId } = await recordTake();
		await call("addTrim", { projectId, startSec: 2, endSec: 4 });
		// The checkpoint renders nothing; the project as it is, its frame.
		renderFrames = async (clips, _scene, _fps, frames, maxWidth) =>
			clips.length > 1
				? frames.map((index) => ({ index, width: maxWidth, height: 359, jpeg: Buffer.from("now") }))
				: [];
		const result = await call("getBeforeAfter", { projectId, checkpointId, atSec: [1] });
		expect(momentsOf(result)).toEqual([{ sec: 1, changed: true, missing: "checkpoint" }]);
		expect(pictureOf(result)).toBe(`sheet ${2 * 639 + 2}x359`);
	});

	it("keeps each moment where it was asked, and says which side's film ends before it", async () => {
		const { projectId, checkpointId } = await recordTake();
		// The take is 12 s; the project now plays its first 8 s only.
		const [clip] = (await documents.getProject(projectId)).timeline.clips;
		await call("setClipRange", { projectId, clipId: clip.id, sourceStartSec: 0, sourceEndSec: 8 });
		asked = [];
		const result = await call("getBeforeAfter", { projectId, checkpointId, atSec: [2, 10] });
		// The checkpoint shows 10 s; the project, which ends at 8, is not asked for it at all.
		expect(asked).toEqual([
			{ clips: 1, frames: [120, 600], maxWidth: 639 },
			{ clips: 1, frames: [120], maxWidth: 639 },
		]);
		expect(momentsOf(result)).toEqual([
			{ sec: 2, changed: false },
			{ sec: 10, changed: true, missing: "now" },
		]);
		// Spread over the longer film when no time is asked: 0 to 12 s, not 0 to 8.
		asked = [];
		await call("getBeforeAfter", { projectId, checkpointId, count: 2, startSec: 0 });
		expect(asked[0].frames.at(-1)).toBeGreaterThan(700);
	});

	it("keeps a moment just before the end as asked through a slowed end, and has none at the end", async () => {
		const { projectId, checkpointId } = await recordTake();
		// The take's last second now plays at half speed: the film ends at 13 s of output.
		await call("addSpeed", { projectId, startSec: 11, endSec: 12, speed: 0.5 });
		asked = [];
		const result = await call("getBeforeAfter", { projectId, checkpointId, atSec: [11.995, 12] });
		// 11.995 s is output frame 719 at the checkpoint, and 779 now: the last of 13 s, not
		// the one a clamp to a 60th of a ruler second before the end would give. 12 s is the end.
		expect(asked).toEqual([
			{ clips: 1, frames: [719], maxWidth: 639 },
			{ clips: 1, frames: [779], maxWidth: 639 },
		]);
		expect(momentsOf(result)).toEqual([
			{ sec: 11.99, changed: false },
			{ sec: 12, changed: false, missing: "both" },
		]);
	});

	it("shows a checkpoint taken before the first clip as missing, and still renders the project", async () => {
		const empty = await documents.createProject("Empty");
		const projectId = empty.project.id;
		const checkpoint = await call("createCheckpoint", { projectId });
		const { checkpointId } = JSON.parse(textOf(checkpoint));
		// The take's clip laid into the project the checkpoint saw empty.
		const take = await documents.getProject((await recordTake()).projectId);
		await documents.saveProject({ ...take, project: { ...take.project, id: projectId } });
		asked = [];
		const result = await call("getBeforeAfter", { projectId, checkpointId, atSec: [1] });
		expect(result.isError).toBeFalsy();
		expect(asked).toHaveLength(1);
		expect(momentsOf(result)).toEqual([{ sec: 1, changed: true, missing: "checkpoint" }]);
	});

	it("places a change found on a region cut at the frame's edge inside the frame", async () => {
		const { projectId, checkpointId } = await recordTake();
		await call("addTrim", { projectId, startSec: 2, endSec: 4 });
		// A region that runs past the right edge: only the frame's last tenth is compared.
		const result = await call("getBeforeAfter", {
			projectId,
			checkpointId,
			atSec: [1],
			region: { x: 0.9, y: 0, width: 0.5, height: 1 },
		});
		const [moment] = momentsOf(result);
		expect(moment.changed).toBe(true);
		expect(moment.region.x).toBeGreaterThanOrEqual(0.9);
		expect(moment.region.x + moment.region.width).toBeLessThanOrEqual(1.0001);
	});

	it("refuses what it cannot compare, and says why", async () => {
		const take = await recordTake();
		const unknown = await call("getBeforeAfter", {
			projectId: take.projectId,
			checkpointId: "cp_nope",
		});
		expect(unknown.isError).toBe(true);
		expect(textOf(unknown)).toContain("Unknown checkpointId");

		const other = await documents.createProject("Other");
		const foreign = await call("getBeforeAfter", {
			projectId: other.project.id,
			checkpointId: take.checkpointId,
		});
		expect(foreign.isError).toBe(true);
		expect(textOf(foreign)).toContain("belongs to another project");

		const nowhere = await call("getBeforeAfter", { projectId: "proj_nope", checkpointId: "cp" });
		expect(textOf(nowhere)).toContain('No project has the id "proj_nope"');

		const { projectId, checkpointId } = take;
		const both = await call("getBeforeAfter", { projectId, checkpointId, atSec: [1], startSec: 0 });
		expect(textOf(both)).toContain("not both");

		renderFrames = async () => null;
		const noAddon = await call("getBeforeAfter", { projectId, checkpointId, atSec: [1] });
		expect(noAddon.isError).toBe(true);
		expect(textOf(noAddon)).toContain("cannot render");
	});
});

/** A 16-bit stereo WAV: each part is a 1 kHz tone at `db` dBFS, or silence when `db` is null. */
function wavOf(parts: Array<[db: number | null, seconds: number]>): Buffer {
	const sampleRate = 48_000;
	const frames = parts.reduce((total, [, seconds]) => total + Math.round(seconds * sampleRate), 0);
	const file = Buffer.alloc(44 + frames * 4);
	file.write("RIFF", 0, "latin1");
	file.writeUInt32LE(36 + frames * 4, 4);
	file.write("WAVEfmt ", 8, "latin1");
	file.writeUInt32LE(16, 16);
	file.writeUInt16LE(1, 20);
	file.writeUInt16LE(2, 22);
	file.writeUInt32LE(sampleRate, 24);
	file.writeUInt32LE(sampleRate * 4, 28);
	file.writeUInt16LE(4, 32);
	file.writeUInt16LE(16, 34);
	file.write("data", 36, "latin1");
	file.writeUInt32LE(frames * 4, 40);
	let at = 44;
	let n = 0;
	for (const [db, seconds] of parts) {
		const amplitude = db === null ? 0 : 10 ** (db / 20);
		for (let i = 0; i < Math.round(seconds * sampleRate); i++, n++) {
			const value = Math.round(
				amplitude * Math.sin((2 * Math.PI * 1_000 * n) / sampleRate) * 32767,
			);
			file.writeInt16LE(value, at);
			file.writeInt16LE(value, at + 2);
			at += 4;
		}
	}
	return file;
}

describe("getAudioReport", () => {
	const reportOf = async (args: Record<string, unknown>) =>
		JSON.parse(textOf(await call("getAudioReport", args))) as {
			durationSec: number;
			integratedLufs: number | null;
			truePeakDbtp: number | null;
			silences: Array<{ startSec: number; endSec: number }>;
		};

	it("measures the project's sound, and places its silences on the ruler", async () => {
		const { projectId } = await recordTake();
		// A cut of 2 s early in the take: what the export plays at 5 s is ruler second 7.
		await call("addTrim", { projectId, startSec: 2, endSec: 4 });
		runners.wav = wavOf([
			[-20, 5],
			[null, 1],
			[-20, 4],
		]);
		const report = await reportOf({ projectId });
		expect(report.durationSec).toBe(10);
		expect(report.integratedLufs).toBeCloseTo(-20, 0);
		expect(report.truePeakDbtp).toBeCloseTo(-20, 0);
		expect(report.silences).toEqual([{ startSec: 7, endSec: 8 }]);

		const request = runners.started.at(-1);
		expect(request).toMatchObject({ kind: "export", format: "wav", audioTrackId: null });
		// Rendered to a file of its own, gone once it is measured.
		const rendered = (request?.kind === "export" && request.outPath) || "";
		expect(path.dirname(rendered)).toBe(os.tmpdir());
		await expect(fs.access(rendered)).rejects.toThrow();
		expect(media.isBusy()).toBe(false);
	});

	it("keeps a silence that touches a cut clear of the cut, and follows a speed region", async () => {
		const { projectId } = await recordTake();
		// Ruler 2 to 4 is cut, and ruler 6 to 10 plays twice as fast: the export lasts 8 s.
		await call("addTrim", { projectId, startSec: 2, endSec: 4 });
		expect(
			(await call("addSpeed", { projectId, startSec: 6, endSec: 10, speed: 2 })).isError,
		).toBeFalsy();
		// Quiet for the second right after the cut, then again from 5 s to 5.5 s of the export.
		runners.wav = wavOf([
			[-20, 2],
			[null, 1],
			[-20, 2],
			[null, 0.5],
			[-20, 2.5],
		]);
		const { silences } = await reportOf({ projectId });
		expect(silences).toEqual([
			// It starts after the cut, never inside it.
			{ startSec: 4, endSec: 5 },
			// One export second past ruler 6 is two ruler seconds.
			{ startSec: 8, endSec: 9 },
		]);
	});

	it("leaves a cut inside a silence out of it: the export never played the cut", async () => {
		const { projectId } = await recordTake();
		await call("addTrim", { projectId, startSec: 2, endSec: 4 });
		// Quiet from 1 s to 3 s of the export: ruler 1 to 2, then ruler 4 to 5, the cut between.
		runners.wav = wavOf([
			[-20, 1],
			[null, 2],
			[-20, 5],
		]);
		const { silences } = await reportOf({ projectId });
		expect(silences).toEqual([
			{ startSec: 1, endSec: 2 },
			{ startSec: 4, endSec: 5 },
		]);
	});

	it("measures one imported track alone", async () => {
		const { projectId } = await recordTake();
		runners.wav = wavOf([[-30, 2]]);
		const report = await reportOf({ projectId, audioId: "music" });
		expect(report.integratedLufs).toBeCloseTo(-30, 0);
		expect(runners.started.at(-1)).toMatchObject({ audioTrackId: "music" });
	});

	it("says a silent film is silent, rather than give it a loudness", async () => {
		const { projectId } = await recordTake();
		runners.wav = wavOf([[null, 2]]);
		const report = await reportOf({ projectId });
		expect(report).toMatchObject({ integratedLufs: null, truePeakDbtp: null });
		expect(report.silences).toEqual([{ startSec: 0, endSec: 2 }]);
	});

	it("says why it has nothing to give: no such project, a failed render, a file it cannot read", async () => {
		expect(textOf(await call("getAudioReport", { projectId: "nope" }))).toContain(
			'No project has the id "nope"',
		);
		const { projectId } = await recordTake();
		runners.results.export = { success: false, error: "no audio track" };
		const failed = await call("getAudioReport", { projectId });
		expect(failed.isError).toBe(true);
		expect(textOf(failed)).toContain("could not be rendered: no audio track");

		runners.results.export = { success: true };
		runners.wav = Buffer.from("not a wav");
		const unreadable = await call("getAudioReport", { projectId });
		expect(unreadable.isError).toBe(true);
		expect(textOf(unreadable)).toContain("could not be measured: Not a WAV file");
		expect(media.isBusy()).toBe(false);
	});

	it("gives no silences when the project was saved while its sound was measured", async () => {
		const { projectId } = await recordTake();
		runners.wav = wavOf([[-20, 2]]);
		const held = runners.holdExports();
		const measuring = call("getAudioReport", { projectId });
		await held;
		// The runner may have rendered either version: the ruler seconds would be a guess.
		await call("addTrim", { projectId, startSec: 2, endSec: 4 });
		runners.releaseExport();
		const answer = await measuring;
		expect(answer.isError).toBe(true);
		expect(textOf(answer)).toContain("changed while its sound was measured");
		expect(media.isBusy()).toBe(false);
	});

	it("waits for a take to end", async () => {
		const { projectId } = await recordTake();
		await call("startRecording", { window: "My App" });
		const during = await call("getAudioReport", { projectId });
		expect(during.isError).toBe(true);
		expect(textOf(during)).toContain("A recording is running");
		await call("stopRecording", { title: "Second" });
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
			"startRecording, exportVideo, exportAudio, exportCaptions and createProject are refused too while 'MCP edits'",
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

describe("waitForRecording through MCP", () => {
	const clients: Client[] = [];
	afterEach(async () => {
		for (const client of clients.splice(0)) await client.close();
	});
	async function observing(
		completion: RecordingCompletion,
		overrides: Partial<MediaToolDeps> = {},
	) {
		const deps: McpToolDeps = {
			transport: "http",
			host: { snapshot: async () => null, apply: async () => "no-editor" },
			projects: documents,
			editsAllowed: () => false,
			version: "test",
		};
		let subscribed: () => void = () => undefined;
		const subscription = new Promise<void>((resolve) => {
			subscribed = resolve;
		});
		const media = createMediaTools({
			...stdioDeps,
			transport: "http",
			recordingActive: () => completion.isActive(),
			editsAllowed: () => false,
			waitForRecording: (timeout, signal) => {
				const waiting = completion.wait(timeout, signal);
				subscribed();
				return waiting;
			},
			...overrides,
		});
		const server = createOpenScreenMcpServer(deps, createToolRunner(deps), media);
		const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
		await server.connect(serverSide);
		const observer = new Client({ name: "observer", version: "1" });
		await observer.connect(clientSide);
		clients.push(observer);
		return { observer, subscription };
	}

	it("renders no sound while the user records from the HUD, and does once the take is saved", async () => {
		const { projectId } = await recordTake();
		const completion = new RecordingCompletion();
		completion.started(7, 1_000);
		const { observer } = await observing(completion);
		const during = (await observer.callTool({
			name: "getAudioReport",
			arguments: { projectId },
		})) as CallToolResult;
		expect(during.isError).toBe(true);
		expect(textOf(during)).toContain("A recording is running");
		expect(runners.started.filter((request) => request.kind === "export")).toEqual([]);

		completion.saved(7, videoPath);
		completion.completed(7, { projectId, videoPath, durationSec: 12, autoZooms: 0 });
		runners.wav = wavOf([[-20, 2]]);
		const after = (await observer.callTool({
			name: "getAudioReport",
			arguments: { projectId },
		})) as CallToolResult;
		expect(after.isError).toBeFalsy();
		expect(JSON.parse(textOf(after))).toMatchObject({ durationSec: 2, silences: [] });
		expect(runners.started.filter((request) => request.kind === "export")).toHaveLength(1);
	});

	it("returns the stopRecording fields for a user take while MCP edits is off, without recording commands", async () => {
		const project = await documents.createProject("User take");
		const completion = new RecordingCompletion();
		completion.started(42, 1_000);
		const { observer, subscription } = await observing(completion);
		const waiting = observer.callTool({ name: "waitForRecording", arguments: {} });
		await subscription;
		completion.saved(42, videoPath);
		completion.completed(42, {
			projectId: project.project.id,
			videoPath,
			durationSec: 12,
			autoZooms: 2,
		});
		const result = await waiting;
		expect(result.isError).toBeFalsy();
		expect(JSON.parse(textOf(result as CallToolResult))).toEqual({
			projectId: project.project.id,
			videoPath,
			durationSec: 12,
			autoZooms: 2,
			recordingStartedAt: 1_000,
			checkpointId: expect.any(String),
		});
		expect(runners.started).toEqual([]);
	});

	it("gives setPointerTrack the waited-for take's start, as stopRecording does", async () => {
		const project = await documents.createProject("User take");
		const completion = new RecordingCompletion();
		completion.started(42, 1_000);
		const sent: unknown[] = [];
		const { observer, subscription } = await observing(completion, {
			runTool: async (_name, args) => {
				sent.push(args);
				return { content: [{ type: "text", text: "ok" }] };
			},
		});
		const waiting = observer.callTool({ name: "waitForRecording", arguments: {} });
		await subscription;
		completion.saved(42, videoPath);
		completion.completed(42, {
			projectId: project.project.id,
			videoPath,
			durationSec: 12,
			autoZooms: 0,
		});
		await waiting;
		await observer.callTool({
			name: "setPointerTrack",
			arguments: { projectId: project.project.id, events: [{ at: 1, x: 0.5, y: 0.5 }] },
		});
		expect(sent).toContainEqual(expect.objectContaining({ takes: { [videoPath]: 1_000 } }));
	});

	it("releases a client take after the user finishes it, so startRecording can record again", async () => {
		const completion = new RecordingCompletion();
		let id = 0;
		const recorder: TakeRecorder = {
			start: async () => {
				completion.started(++id);
				return {
					startedAt: id,
					stop: async () => {
						throw new Error("wait must never stop the take");
					},
				};
			},
		};
		const { observer, subscription } = await observing(completion, {
			recorder,
			editsAllowed: () => true,
		});
		expect(
			(await observer.callTool({ name: "startRecording", arguments: {} })).isError,
		).toBeFalsy();
		const waiting = observer.callTool({ name: "waitForRecording", arguments: {} });
		await subscription;
		completion.saved(1, videoPath);
		completion.completed(1, { projectId: "proj_take", videoPath, durationSec: 12, autoZooms: 0 });
		await waiting;
		expect(
			(await observer.callTool({ name: "startRecording", arguments: {} })).isError,
		).toBeFalsy();
		expect(id).toBe(2);
	});

	it("keeps a take that is still starting claimed when a wait finds nothing to observe", async () => {
		const completion = new RecordingCompletion();
		let begin: () => void = () => undefined;
		const countdown = new Promise<void>((resolve) => {
			begin = resolve;
		});
		let starts = 0;
		const recorder: TakeRecorder = {
			start: async () => {
				starts++;
				await countdown;
				completion.started(1);
				return {
					startedAt: 1,
					stop: async () => ({ projectId: "p", videoPath, durationSec: 1, autoZooms: 0 }),
				};
			},
		};
		const { observer } = await observing(completion, { recorder, editsAllowed: () => true });
		const starting = observer.callTool({ name: "startRecording", arguments: {} });
		const waited = await observer.callTool({ name: "waitForRecording", arguments: {} });
		expect(textOf(waited as CallToolResult)).toContain("No recording");
		const second = await observer.callTool({ name: "startRecording", arguments: {} });
		expect(textOf(second as CallToolResult)).toContain("already running");
		begin();
		expect((await starting).isError).toBeFalsy();
		expect(starts).toBe(1);
	});

	it.each([
		0,
		-1,
		1.5,
		3601,
		"10",
	])("validates timeoutSec=%s before observing", async (timeoutSec) => {
		const completion = new RecordingCompletion();
		const { observer } = await observing(completion);
		const result = await observer.callTool({ name: "waitForRecording", arguments: { timeoutSec } });
		expect(result.isError).toBe(true);
		expect(textOf(result as CallToolResult)).toContain("validation");
	});

	it("reports no active recording as a tool error", async () => {
		const { observer } = await observing(new RecordingCompletion());
		const result = await observer.callTool({ name: "waitForRecording", arguments: {} });
		expect(result.isError).toBe(true);
		expect(textOf(result as CallToolResult)).toContain("No recording");
	});

	it("propagates MCP cancellation and leaves the user's take available", async () => {
		const completion = new RecordingCompletion();
		completion.started(42);
		const { observer, subscription } = await observing(completion);
		const abort = new AbortController();
		const waiting = expect(
			observer.callTool({ name: "waitForRecording", arguments: {} }, undefined, {
				signal: abort.signal,
			}),
		).rejects.toThrow();
		await subscription;
		abort.abort();
		await waiting;
		// Flush the MCP cancellation notification, then the same take still completes.
		await new Promise((resolve) => setTimeout(resolve, 0));
		const retry = completion.wait(1000, new AbortController().signal);
		completion.saved(42, videoPath);
		completion.completed(42, { projectId: "proj_take", videoPath, durationSec: 12, autoZooms: 0 });
		await expect(retry).resolves.toMatchObject({ projectId: "proj_take" });
	});
});
