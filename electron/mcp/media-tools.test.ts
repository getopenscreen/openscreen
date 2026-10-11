// The media tools through the SDK's own client, beside the document tools they
// hand projects to: a real DocumentService on a temp directory, the real tool
// runner, and stand-ins for the runner windows and the video decoder.

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
import { frameTimes, MEDIA_PREAMBLE, type MediaToolDeps, registerMediaTools } from "./media-tools";
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

	constructor(private readonly videoPath: string) {}

	start(request: CliRequest, handlers: RunnerHandlers = {}) {
		this.started.push(request);
		let finish: (result: CliDoneResult) => void = () => undefined;
		const done = new Promise<CliDoneResult>((resolve) => {
			finish = resolve;
		});
		const window = {
			webContents: {
				send: (channel: string) => {
					if (channel === "cli-stop-recording") {
						finish({ success: true, screenVideoPath: this.videoPath });
					}
				},
			},
		};
		if (request.kind !== "record") {
			finish(this.results[request.kind] ?? { success: true });
		} else if (this.recordStarts) {
			queueMicrotask(() => handlers.onLog?.("info", "Recording started"));
		} else {
			finish({ success: false, error: "Recording did not start within 30s" });
		}
		return { window, done };
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
let documents: DocumentService;
let runners: FakeRunners;
let closed: number;
let client: Client;

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "media-tools-"));
	documents = new DocumentService(path.join(dir, "projects"), path.join(dir, "recordings"));
	const videoPath = path.join(dir, "recordings", "take.mp4");
	runners = new FakeRunners(videoPath);
	closed = 0;

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
		openVideo: async () => ({
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
		}),
		readCursor: async (path) => (path === videoPath ? clickTrack() : []),
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

	it("says why a recording did not start, and holds no take", async () => {
		runners.recordStarts = false;
		const started = await call("startRecording", { display: 1 });
		expect(started.isError).toBe(true);
		expect(textOf(started)).toContain("did not start within 30s");
		expect((await call("stopRecording")).isError).toBe(true);
	});

	it("runs one take at a time, and no export during it", async () => {
		await call("startRecording", {});
		expect((await call("startRecording", {})).isError).toBe(true);
		const exported = await call("exportVideo", { projectId: "proj_x", path: "out.mp4" });
		expect(exported.isError).toBe(true);
		expect(textOf(exported)).toContain("recording is running");
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

	it("refuses a path that is not a video, and reports a failed render", async () => {
		expect((await call("exportVideo", { projectId: "proj_x", path: "out.mov" })).isError).toBe(
			true,
		);
		runners.results.export = { success: false, error: "compositor exploded" };
		const failed = await call("exportVideo", { projectId: "proj_x", path: "out.gif" });
		expect(failed.isError).toBe(true);
		expect(textOf(failed)).toContain("compositor exploded");
		expect(runners.started.at(-1)).toMatchObject({ format: "gif" });
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
