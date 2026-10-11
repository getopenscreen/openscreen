// What an agent needs around the editing DSL to make a video on its own: record a
// take, have it become a project, export the project, and look at the result.
// Served by `openscreen mcp` next to the document tools, so every edit between the
// recording and the export goes through the DSL like any other client's.
//
// No `electron` import: the runners, the decoder and the documents are handed in,
// so the tools run under plain vitest with stand-ins.

import fs from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CursorTelemetryPoint } from "../../src/components/video-editor/types";
import {
	projectRawTimelineSecToPlayback,
	readSpeedRegions,
} from "../../src/lib/ai-edition/document/timeline";
import type { AxcutDocument } from "../../src/lib/ai-edition/schema";
import {
	appendAutoZoomSuggestions,
	collectAutoZoomSuggestionsForDocument,
} from "../../src/lib/ai-edition/timeline/apply-auto-zooms";
import type { CliDoneResult, CliRequest } from "../../src/lib/cliContracts";
import type { CursorRecordingData, CursorRecordingSample } from "../../src/native/contracts";
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
			close(): void;
		};
	};
	documents: Pick<
		DocumentService,
		| "createProject"
		| "addAsset"
		| "saveProject"
		| "filePathFor"
		| "getProject"
		| "getProjectForUpdate"
		| "saveProjectIfUnchanged"
	>;
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

export interface PointerEvent {
	/** Epoch milliseconds, from the clock the take's `recordingStartedAt` came from. */
	at: number;
	/** Fractions of the recorded window (or display), as OpenScreen records a real pointer. */
	x: number;
	y: number;
	click?: boolean;
}

// The rate OpenScreen's own pointer sampler records at.
const POINTER_STEP_MS = 33;
// A hand reaches for the next control in about this long, then the click lands.
const POINTER_TRAVEL_MS = 600;
const CLICK_HOLD_MS = 80;

/**
 * A pointer track as a real mouse would have left it: at rest, then a short eased
 * glide that arrives on each event when it happened, then at rest until the end.
 * Times are milliseconds into the take; sampled until `durationMs`, because the
 * zoom planner discards a click that comes with the last sample (the click on Stop).
 */
export function pointerSamples(
	events: readonly PointerEvent[],
	startedAt: number,
	durationMs: number,
): CursorRecordingSample[] {
	const sorted = [...events].sort((a, b) => a.at - b.at);
	if (sorted.length === 0) return [];
	const sample = (
		timeMs: number,
		cx: number,
		cy: number,
		interactionType: CursorRecordingSample["interactionType"] = "move",
	): CursorRecordingSample => ({
		timeMs: Math.round(timeMs),
		cx,
		cy,
		visible: true,
		assetId: null,
		cursorType: null,
		interactionType,
	});
	const samples: CursorRecordingSample[] = [];
	let from = { t: 0, x: sorted[0].x, y: sorted[0].y };
	for (const event of sorted) {
		const t = Math.min(Math.max(event.at - startedAt, from.t), durationMs);
		const glideStart = Math.max(from.t, t - POINTER_TRAVEL_MS);
		for (let s = from.t; s < glideStart; s += POINTER_STEP_MS)
			samples.push(sample(s, from.x, from.y));
		for (let s = glideStart; s < t; s += POINTER_STEP_MS) {
			const k = (s - glideStart) / (t - glideStart);
			const eased = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
			samples.push(
				sample(s, from.x + (event.x - from.x) * eased, from.y + (event.y - from.y) * eased),
			);
		}
		samples.push(sample(t, event.x, event.y, event.click ? "click" : "move"));
		if (event.click) samples.push(sample(t + CLICK_HOLD_MS, event.x, event.y, "mouseup"));
		from = { t: event.click ? t + CLICK_HOLD_MS : t, x: event.x, y: event.y };
	}
	for (let s = from.t + POINTER_STEP_MS; s <= durationMs; s += POINTER_STEP_MS) {
		samples.push(sample(s, from.x, from.y));
	}
	return samples;
}

function text(body: string, isError = false): CallToolResult {
	return { content: [{ type: "text", text: body }], ...(isError ? { isError: true } : {}) };
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

export const MEDIA_PREAMBLE = [
	"OpenScreen records the screen, turns each take into a project you edit with the document tools, and exports it as a video.",
	"A demo goes: listSources, then startRecording, then drive the app, then stopRecording. It returns the projectId and a checkpointId. Edit with the document tools, always passing that projectId: every edit is saved to the project straight away, and restoreCheckpoint with the checkpointId takes the project back to the raw take in one step. Then exportVideo, and getFrames with the projectId to check the export before you hand it over: it takes the same ruler seconds as the document tools, so a trim or a speed region never shifts what you look at.",
	"Drive the app with the real mouse when you can: OpenScreen records the pointer, draws a clean cursor and zooms on each click. If you drive it from a script instead (Playwright, CDP), the screen pointer never moves: log each action as the script runs it, then hand the log to setPointerTrack after stopRecording.",
	"These projects are in the OpenScreen app's project list, so the user can open one in the editor. Do not edit a project while the user has it open there: the editor would keep its own copy.",
	"",
].join("\n");

export function registerMediaTools(server: McpServer, deps: MediaToolDeps): void {
	const now = deps.now ?? Date.now;
	/** The take being recorded, then saved: held until it is a project. */
	let take: {
		run: ReturnType<MediaToolDeps["runners"]["start"]>;
		startedAt: number;
		stopping: boolean;
	} | null = null;
	// One pointer track at a time: each reads the project, rewrites the sidecar and saves.
	let pointerQueue: Promise<unknown> = Promise.resolve();
	// An export loads its project into the slot a finishing take reads its files from.
	let exporting = false;
	/** When each take of this session started, by its video: setPointerTrack's clock. */
	const startedAtByVideo = new Map<string, number>();
	/** Each project's last export of this session, and when it was made: what getFrames reads. */
	const lastExports = new Map<string, { path: string; at: string }>();

	/** A runner's result, its hidden window closed: this server outlives every runner. */
	async function finish(run: ReturnType<MediaToolDeps["runners"]["start"]>) {
		try {
			return await run.done;
		} finally {
			run.close();
		}
	}

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
			const result = await finish(deps.runners.start({ kind: "sources" }));
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
			if (take?.stopping) {
				return text("The last take is still being saved. Try again in a moment.", true);
			}
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
				run.close();
				return text(`The recording did not start: ${outcome.error ?? "unknown error"}`, true);
			}
			take = { run, startedAt: now(), stopping: false };
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
			if (current.stopping) return text("This recording is already being stopped.", true);
			// Claimed before the first await, so a second call cannot save the same take twice.
			current.stopping = true;
			try {
				return await stopTake(current, args.title);
			} finally {
				take = null;
			}
		},
	);

	/** Stops the take, then turns it into a project with its checkpoint. */
	async function stopTake(
		current: NonNullable<typeof take>,
		requestedTitle: string | undefined,
	): Promise<CallToolResult> {
		try {
			current.run.window.webContents.send("cli-stop-recording");
		} catch {
			// The runner already went away; its result says why.
		}
		const result = await finish(current.run);
		if (!result.success || !result.screenVideoPath) {
			return text(`The recording failed: ${result.error ?? "unknown error"}`, true);
		}
		const title =
			requestedTitle?.trim() || `Recording ${new Date(current.startedAt).toLocaleString()}`;
		let project: Awaited<ReturnType<typeof createProjectFromVideo>>;
		try {
			project = await createProjectFromVideo(result.screenVideoPath, title);
		} catch (error) {
			// The take is on disk all the same: say where, so it can still be looked at.
			return text(
				`The take was saved to ${result.screenVideoPath}, but it could not be turned into a project: ${error instanceof Error ? error.message : String(error)}`,
				true,
			);
		}
		startedAtByVideo.set(result.screenVideoPath, current.startedAt);
		const projectId = project.document.project.id;
		const checkpoint = await deps.runTool("createCheckpoint", { projectId });
		const checkpointText = checkpoint.content[0]?.type === "text" ? checkpoint.content[0].text : "";
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
	}

	server.registerTool(
		"setPointerTrack",
		{
			description: [
				"For a take driven by a script (Playwright, CDP, a browser extension) rather than the real mouse: the screen pointer never moved, so the video has no cursor and no zoom. Give the pointer's path here and OpenScreen draws it, gliding between your actions, and zooms on its clicks as for a real mouse. It replaces the pointer recorded with the take, then adds a zoom on each new click. Only for a take recorded by this server.",
				"events, one per action: `at` is Date.now() when your script did it (log it as it runs; the take's recordingStartedAt is on the same clock). `x` and `y` are fractions (0 to 1) of the recorded window. For a point (clientX, clientY) of a page shown in that window, from inside the page: border = (outerWidth - innerWidth) / 2; x = (border + clientX) / outerWidth; y = (outerHeight - innerHeight - border + clientY) / outerHeight.",
			].join("\n"),
			inputSchema: z.object({
				projectId: z.string(),
				events: z
					.array(
						z.object({
							at: z.number().describe("Epoch milliseconds, from Date.now()."),
							x: z.number().min(0).max(1),
							y: z.number().min(0).max(1),
							click: z.boolean().optional().describe("The action clicked here."),
						}),
					)
					.min(1),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
		},
		(args) => {
			const next = pointerQueue.then(() => setPointerTrack(args));
			pointerQueue = next.catch(() => undefined);
			return next;
		},
	);

	async function setPointerTrack(args: {
		projectId: string;
		events: PointerEvent[];
	}): Promise<CallToolResult> {
		const { document, version } = await deps.documents.getProjectForUpdate(args.projectId);
		const asset = document.assets.find((a) => a.id === document.project.primaryAssetId);
		const startedAt = asset ? startedAtByVideo.get(asset.originalPath) : undefined;
		if (!asset || startedAt === undefined || !asset.durationSec) {
			return text(
				"This project's take was not recorded by this server, so its start time is unknown. setPointerTrack only works on a take from stopRecording.",
				true,
			);
		}
		const sidecar: CursorRecordingData = {
			version: 2,
			provider: "native",
			samples: pointerSamples(args.events, startedAt, asset.durationSec * 1000),
			assets: [],
		};
		await fs.writeFile(`${asset.originalPath}.cursor.json`, JSON.stringify(sidecar), "utf8");
		const suggestions = await collectAutoZoomSuggestionsForDocument(
			document,
			deps.readCursor,
			(candidate) => candidate.id === asset.id,
		);
		const saved = await deps.documents.saveProjectIfUnchanged(
			appendAutoZoomSuggestions(document, suggestions),
			version,
		);
		if (!saved) {
			return text(
				"The pointer track was written, but the zooms were NOT added: the project changed while this call ran. Call setPointerTrack again.",
				true,
			);
		}
		return text(
			JSON.stringify({ samples: sidecar.samples.length, autoZoomsAdded: suggestions.length }),
		);
	}

	server.registerTool(
		"exportVideo",
		{
			description:
				"Render a project to an MP4 (H.264, 60 fps) or a GIF with OpenScreen's compositor: the background, cursor, zooms, cuts, speed changes and annotations as edited. Returns the file's path; call getFrames with the projectId to check it at the ruler seconds you edited with. The video's shape follows the project's format (setAspectRatio).",
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
					.describe(
						"The height: medium is 720 pixels, good is 1080 (default), source keeps the recording's. The width follows the format.",
					),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args, extra) => {
			if (take) return text("A recording is running. Stop it before exporting.", true);
			if (exporting)
				return text("An export is already running. Wait for it, then try again.", true);
			const outPath = path.resolve(args.path);
			const extension = path.extname(outPath).toLowerCase();
			if (extension !== ".mp4" && extension !== ".gif") {
				return text(`The path must end in .mp4 or .gif, got "${args.path}".`, true);
			}
			const progressToken = extra._meta?.progressToken;
			exporting = true;
			try {
				const run = deps.runners.start(
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
				);
				const result = await finish(run);
				if (!result.success) {
					return text(`The export failed: ${result.error ?? "unknown error"}`, true);
				}
				lastExports.set(args.projectId, {
					path: result.outputPath ?? outPath,
					at: new Date().toISOString(),
				});
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
			description: [
				`Look at a video as still images, at most ${MAX_FRAMES} per call. Ask for the moments you need to check, such as each zoom and each callout.`,
				"To check an edit, pass projectId: you get the project's last export, and atSec are the ruler seconds the document tools use, mapped through the trims and speed regions to the moment the export plays them. With path instead, you get any video file (a take's videoPath, say) and atSec are that file's own seconds.",
			].join("\n"),
			inputSchema: z.object({
				projectId: z.string().optional().describe("Look at this project's last export."),
				path: z.string().optional().describe("Or look at this video file."),
				atSec: z
					.array(z.number().nonnegative())
					.max(MAX_FRAMES)
					.optional()
					.describe("Times in seconds: ruler seconds with projectId, the file's own with path."),
				count: z
					.number()
					.int()
					.min(1)
					.max(MAX_FRAMES)
					.optional()
					.describe("Frames spread evenly, when atSec is not given. Default 6."),
			}),
			annotations: READ_ONLY,
		},
		async (args) => {
			if ((args.projectId === undefined) === (args.path === undefined)) {
				return text("Pass either projectId or path.", true);
			}
			let videoPath: string;
			/** Ruler seconds → seconds of the exported file, when looking at a project. */
			let toVideoSec = (sec: number) => sec;
			let rulerEndSec: number | null = null;
			let note = "";
			if (args.projectId !== undefined) {
				const exported = lastExports.get(args.projectId);
				if (!exported) {
					return text("This project has no export yet: call exportVideo first.", true);
				}
				const document = await deps.documents.getProject(args.projectId);
				videoPath = exported.path;
				toVideoSec = (sec) => programmeSecOf(document, sec);
				rulerEndSec = Math.max(0, ...document.timeline.clips.map((clip) => clip.timelineEndSec));
				if (document.project.updatedAt > exported.at) {
					note = " The project changed after this export: export it again to see the changes.";
				}
			} else {
				videoPath = path.resolve(args.path ?? "");
			}

			const video = await deps.openVideo(videoPath);
			try {
				const asked =
					args.atSec ??
					(rulerEndSec === null ? null : frameTimes(rulerEndSec, null, args.count ?? 6));
				const times = asked
					? asked.map((sec) => ({
							asked: sec,
							at: frameTimes(video.durationSec, [toVideoSec(sec)], 1)[0],
						}))
					: frameTimes(video.durationSec, null, args.count ?? 6).map((at) => ({ asked: at, at }));
				const content: CallToolResult["content"] = [
					{
						type: "text",
						text: `${times.length} frame(s) of a ${video.width}x${video.height} video lasting ${video.durationSec.toFixed(2)}s.${note}`,
					},
				];
				for (const { asked: askedSec, at } of times) {
					const frame = await video.capture(at, FRAME_WIDTH);
					content.push({
						type: "text",
						text:
							rulerEndSec === null
								? `${at.toFixed(2)}s`
								: `${askedSec.toFixed(2)}s on the ruler, ${at.toFixed(2)}s into the video`,
					});
					content.push({ type: "image", data: frame.data, mimeType: frame.mimeType });
				}
				return { content };
			} finally {
				video.close();
			}
		},
	);
}

/**
 * Where a ruler second plays in the export: the exporter's own projection, through the trims
 * (holes in the ruler that the export skips) and the speed regions (spans it plays faster).
 */
function programmeSecOf(document: AxcutDocument, rulerSec: number): number {
	return projectRawTimelineSecToPlayback(
		document.timeline.clips,
		document.timeline.trimRanges,
		rulerSec,
		readSpeedRegions(document),
	);
}
