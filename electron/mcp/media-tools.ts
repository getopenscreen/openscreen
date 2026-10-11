// What an agent needs around the editing DSL to make a video on its own: record a
// take, have it become a project, export the project, and look at the result.
// Served by `openscreen mcp` next to the document tools, so every edit between the
// recording and the export goes through the DSL like any other client's.
//
// No `electron` import: the runners, the decoder and the documents are handed in,
// so the tools run under plain vitest with stand-ins.

import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CursorTelemetryPoint } from "../../src/components/video-editor/types";
import type { AxcutDocument } from "../../src/lib/ai-edition/schema";
import {
	appendAutoZoomSuggestions,
	collectAutoZoomSuggestionsForDocument,
} from "../../src/lib/ai-edition/timeline/apply-auto-zooms";
import type { CliDoneResult, CliRequest } from "../../src/lib/cliContracts";
import { runDocumentTool } from "../ai-edition/deep-agent/service";
import type { DocumentService } from "../ai-edition/document-service";
import type { RunnerHandlers } from "../cli/runnerHost";
import type { OpenedVideo } from "./hidden-video";

export interface MediaToolDeps {
	runners: {
		start(
			request: CliRequest,
			handlers?: RunnerHandlers,
		): {
			window: { webContents: { send(channel: string): void } };
			done: Promise<CliDoneResult>;
		};
	};
	documents: Pick<DocumentService, "createProject" | "addAsset" | "saveProject" | "filePathFor">;
	openVideo(videoPath: string): Promise<OpenedVideo>;
	/** The pointer samples recorded with a video; empty when there are none. */
	readCursor(videoPath: string): Promise<CursorTelemetryPoint[]>;
	/** The document tools' runner: a fresh project's checkpoint goes through it. */
	runTool(name: string, args: unknown): Promise<CallToolResult>;
	now?(): number;
}

export const MAX_FRAMES = 12;
// Wide enough to read UI text, small enough that a dozen frames stay cheap.
const FRAME_WIDTH = 1280;
// A seek to the exact end shows no frame in Chromium; stop one frame short of it.
const END_MARGIN_SEC = 1 / 60;

/** The times to grab: `atSec` clamped inside the video, else `count` centred in equal slices. */
export function frameTimes(durationSec: number, atSec: number[] | null, count: number): number[] {
	const last = Math.max(0, durationSec - END_MARGIN_SEC);
	if (atSec) return atSec.map((t) => Math.min(t, last));
	return Array.from({ length: count }, (_, i) => Math.min(((i + 0.5) * durationSec) / count, last));
}

function text(body: string, isError = false): CallToolResult {
	return { content: [{ type: "text", text: body }], ...(isError ? { isError: true } : {}) };
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

export const MEDIA_PREAMBLE = [
	"OpenScreen records the screen, turns each take into a project you edit with the document tools, and exports it as a video.",
	"A demo goes: listSources, then startRecording, then drive the app, then stopRecording. It returns the projectId and a checkpointId. Edit with the document tools, always passing that projectId: every edit is saved to the project straight away, and restoreCheckpoint with the checkpointId takes the project back to the raw take in one step. Then exportVideo, and getFrames on the export to check it before you hand it over.",
	"These projects are in the OpenScreen app's project list, so the user can open one in the editor. Do not edit a project while the user has it open there: the editor would keep its own copy.",
	"",
].join("\n");

export function registerMediaTools(server: McpServer, deps: MediaToolDeps): void {
	const now = deps.now ?? Date.now;
	let take: { run: ReturnType<MediaToolDeps["runners"]["start"]>; startedAt: number } | null = null;
	// An export loads its project into the slot a finishing take reads its files from.
	let exporting = false;

	/** The take as a project, laid out as the editor lays out a fresh recording. */
	async function createProjectFromVideo(videoPath: string, title: string) {
		const video = await deps.openVideo(videoPath);
		video.close();
		const { durationSec, width, height } = video;
		if (!Number.isFinite(durationSec) || durationSec <= 0) {
			throw new Error(`Could not read the duration of ${videoPath}`);
		}
		const created = await deps.documents.createProject(title);
		let document: AxcutDocument = await deps.documents.addAsset(created.project.id, {
			path: videoPath,
		});
		const assetId = document.project.primaryAssetId;
		document = {
			...document,
			assets: document.assets.map((asset) =>
				asset.id === assetId
					? {
							...asset,
							durationSec,
							video: {
								codec: asset.video?.codec ?? "unknown",
								width,
								height,
								fps: asset.video?.fps ?? 0,
							},
						}
					: asset,
			),
		};
		const seeded = await runDocumentTool(
			document,
			"replaceTimeline",
			{ intervals: [{ startSec: 0, endSec: durationSec }], reason: "The recorded take" },
			true,
			{},
		);
		if (!seeded.ok || !seeded.document) throw new Error(seeded.resultJson);
		// The zooms a recording made in the app starts with: one on each recorded click.
		const suggestions = await collectAutoZoomSuggestionsForDocument(
			seeded.document,
			deps.readCursor,
		);
		const saved = await deps.documents.saveProject(
			appendAutoZoomSuggestions(seeded.document, suggestions),
		);
		return { document: saved, durationSec, autoZooms: suggestions.length };
	}

	server.registerTool(
		"listSources",
		{
			description:
				"List the displays and windows OpenScreen can record, and the microphones. Pass a display's index or part of a window's title to startRecording.",
			inputSchema: z.object({}),
			annotations: READ_ONLY,
		},
		async () => {
			const result = await deps.runners.start({ kind: "sources" }).done;
			if (!result.success || !result.sources) {
				return text(`Could not list the sources: ${result.error ?? "unknown error"}`, true);
			}
			const { displays, windows, microphones } = result.sources;
			return text(
				JSON.stringify({
					displays: displays.map(({ index, name }) => ({ index, name })),
					windows: windows.map((window) => window.name),
					microphones: microphones.map((mic) => mic.label),
				}),
			);
		},
	);

	server.registerTool(
		"startRecording",
		{
			description:
				"Start recording one window (preferred: nothing else on the desktop is captured) or one display. Returns once capture has started; then drive the app and call stopRecording. The pointer is recorded as data, so the export draws a clean cursor and zooms on the clicks. On Linux the desktop's own picker asks the user which window to record.",
			inputSchema: z.object({
				window: z
					.string()
					.optional()
					.describe("Part of the title of the window to record, ignoring case. Wins over display."),
				display: z
					.number()
					.int()
					.min(0)
					.optional()
					.describe("Index of the display to record, from listSources. Default 0."),
				systemAudio: z.boolean().optional().describe("Also record the computer's sound."),
				microphone: z
					.union([z.boolean(), z.string()])
					.optional()
					.describe("true for the default microphone, or part of a microphone's name."),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args) => {
			if (take) return text("A recording is already running. Call stopRecording first.", true);
			if (exporting) return text("An export is running. Wait for it, then try again.", true);
			let markStarted: () => void = () => undefined;
			const started = new Promise<"started">((resolve) => {
				markStarted = () => resolve("started");
			});
			const run = deps.runners.start(
				{
					kind: "record",
					displayIndex: args.display ?? 0,
					windowTitle: args.window ?? null,
					mic: args.microphone !== undefined && args.microphone !== false,
					micDevice: typeof args.microphone === "string" ? args.microphone : null,
					systemAudio: args.systemAudio === true,
					cursorMode: "editable-overlay",
					durationMs: null,
					projectOut: null,
				},
				{
					onLog: (_level, message) => {
						if (message === "Recording started") markStarted();
					},
				},
			);
			const outcome = await Promise.race([started, run.done]);
			if (outcome !== "started") {
				return text(`The recording did not start: ${outcome.error ?? "unknown error"}`, true);
			}
			take = { run, startedAt: now() };
			return text(
				JSON.stringify({ recording: true, startedAt: take.startedAt }) +
					"\nRecording. Drive the app now, pausing about a second after each result appears, then call stopRecording.",
			);
		},
	);

	server.registerTool(
		"stopRecording",
		{
			description:
				"Stop the recording and turn the take into a new project, laid out as the editor lays out a fresh recording: one clip, plus a zoom on each recorded click. Returns the projectId to edit, a checkpointId that restores the raw take, and the take's videoPath.",
			inputSchema: z.object({
				title: z.string().optional().describe("The project's title in OpenScreen."),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args) => {
			const current = take;
			if (!current) return text("No recording is running.", true);
			try {
				current.run.window.webContents.send("cli-stop-recording");
			} catch {
				// The runner already went away; its result says why.
			}
			const result = await current.run.done;
			take = null;
			if (!result.success || !result.screenVideoPath) {
				return text(`The recording failed: ${result.error ?? "unknown error"}`, true);
			}
			const title =
				args.title?.trim() || `Recording ${new Date(current.startedAt).toLocaleString()}`;
			const project = await createProjectFromVideo(result.screenVideoPath, title);
			const projectId = project.document.project.id;
			const checkpoint = await deps.runTool("createCheckpoint", { projectId });
			const checkpointText =
				checkpoint.content[0]?.type === "text" ? checkpoint.content[0].text : "";
			const checkpointId = checkpoint.isError
				? null
				: (JSON.parse(checkpointText) as { checkpointId?: string }).checkpointId;
			return text(
				JSON.stringify({
					projectId,
					checkpointId,
					videoPath: result.screenVideoPath,
					durationSec: project.durationSec,
					recordingStartedAt: current.startedAt,
					autoZooms: project.autoZooms,
					...(result.warnings?.length ? { warnings: result.warnings } : {}),
				}),
			);
		},
	);

	server.registerTool(
		"exportVideo",
		{
			description:
				"Render a project to an MP4 (H.264, 60 fps) or a GIF with OpenScreen's compositor: the background, cursor, zooms, cuts, speed changes and annotations as edited. Returns the file's path; call getFrames on it to check the result.",
			inputSchema: z.object({
				projectId: z.string(),
				path: z
					.string()
					.describe(
						"Where to write the video: an absolute path, or one relative to this server's working directory, ending in .mp4 or .gif.",
					),
				quality: z
					.enum(["medium", "good", "source"])
					.optional()
					.describe("medium is 720p, good is 1080p (default), source keeps the recording's size."),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args, extra) => {
			if (take) return text("A recording is running. Stop it before exporting.", true);
			const outPath = path.resolve(args.path);
			const extension = path.extname(outPath).toLowerCase();
			if (extension !== ".mp4" && extension !== ".gif") {
				return text(`The path must end in .mp4 or .gif, got "${args.path}".`, true);
			}
			const progressToken = extra._meta?.progressToken;
			exporting = true;
			try {
				const result = await deps.runners.start(
					{
						kind: "export",
						projectPath: deps.documents.filePathFor(args.projectId),
						outPath,
						format: extension === ".gif" ? "gif" : "mp4",
						quality: args.quality ?? "good",
						gifFrameRate: null,
						gifSizePreset: null,
						autoZoom: false,
						audioPath: null,
						audioMode: "mix",
						audioOffsetSec: 0,
					},
					{
						onProgress: (progress) => {
							if (progressToken === undefined) return;
							void extra
								.sendNotification({
									method: "notifications/progress",
									params: { progressToken, progress: progress.percentage, total: 100 },
								})
								.catch(() => undefined);
						},
					},
				).done;
				if (!result.success) {
					return text(`The export failed: ${result.error ?? "unknown error"}`, true);
				}
				return text(
					JSON.stringify({
						path: result.outputPath,
						format: result.format,
						width: result.width,
						height: result.height,
					}),
				);
			} finally {
				exporting = false;
			}
		},
	);

	server.registerTool(
		"getFrames",
		{
			description: `Look at a video: still frames of a take (videoPath from stopRecording) or of an export, as images. Ask for the moments you need to check, such as each zoom and each callout. At most ${MAX_FRAMES} frames per call.`,
			inputSchema: z.object({
				path: z.string().describe("The video file."),
				atSec: z
					.array(z.number().nonnegative())
					.max(MAX_FRAMES)
					.optional()
					.describe("Times in seconds of that video. A time past the end gives the last frame."),
				count: z
					.number()
					.int()
					.min(1)
					.max(MAX_FRAMES)
					.optional()
					.describe("Frames spread evenly across the video, when atSec is not given. Default 6."),
			}),
			annotations: READ_ONLY,
		},
		async (args) => {
			const video = await deps.openVideo(path.resolve(args.path));
			try {
				const times = frameTimes(video.durationSec, args.atSec ?? null, args.count ?? 6);
				const content: CallToolResult["content"] = [
					{
						type: "text",
						text: `${times.length} frame(s) of a ${video.width}x${video.height} video lasting ${video.durationSec.toFixed(2)}s.`,
					},
				];
				for (const timeSec of times) {
					const frame = await video.capture(timeSec, FRAME_WIDTH);
					content.push({ type: "text", text: `${timeSec.toFixed(2)}s` });
					content.push({ type: "image", data: frame.data, mimeType: frame.mimeType });
				}
				return { content };
			} finally {
				video.close();
			}
		},
	);
}
