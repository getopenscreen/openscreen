// What an agent needs around the editing DSL to make a video on its own: record a
// take, have it become a project, export the project, and look at the result.
// Served next to the document tools by both servers, the in-app one and `openscreen
// mcp`, so every edit between the recording and the export goes through the DSL like
// any other client's.
//
// One implementation, two recorders. `openscreen mcp` records in a hidden runner of its
// own process and lays the take out as a project here (`runnerRecorder`). The app
// records through its recording bar, as its own Record button does, and its editor opens
// the take (`app-recorder.ts`): the app never runs a second recorder beside its own.
//
// No `electron` import: the runners, the recorder, the decoder and the documents are
// handed in, so the tools run under plain vitest with stand-ins.

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
import type { CliDoneResult, CliRecordRequest, CliRequest } from "../../src/lib/cliContracts";
import { HIDDEN_WINDOWS_NOTE } from "../../src/lib/cliSourcePick";
import {
	GIF_SIZE_PRESETS,
	type GifSizePreset,
	MP4_FRAME_RATES,
	VALID_GIF_FRAME_RATES,
} from "../../src/lib/exporter/types";
import type {
	CompositorClipInput,
	CursorRecordingData,
	CursorRecordingSample,
} from "../../src/native/contracts";
import { buildNativeClipList, buildSceneDescription } from "../../src/native/sceneDescription";
import { runDocumentTool } from "../ai-edition/deep-agent/service";
import type { DocumentService } from "../ai-edition/document-service";
import type { RunnerHandlers } from "../cli/runnerHost";
import type { OpenedVideo } from "./hidden-video";
import {
	MCP_EDITS_SETTING,
	type McpToolRunner,
	type McpTransport,
	type RunnerEdit,
	textResult as text,
} from "./openscreen-mcp-server";
import { mediaPathProblem } from "./project-tools";

/** What startRecording asks a recorder for. */
export type RecordRequest = Pick<
	CliRecordRequest,
	| "displayIndex"
	| "windowTitle"
	| "mic"
	| "micDevice"
	| "systemAudio"
	| "camera"
	| "cameraDevice"
	| "cursorMode"
>;

/** A take turned into a project, ready for the document tools. */
export interface RecordedTake {
	projectId: string;
	/** The take's video, as the project's asset names it: setPointerTrack's key. */
	videoPath: string;
	durationSec: number;
	autoZooms: number;
	warnings?: string[];
}

export interface RunningTake {
	/** Epoch ms when capture started: the clock setPointerTrack's events are on. */
	startedAt: number;
	/** Stops the take and hands it back as a project; throws, with the whole story, when it cannot. */
	stop(title: string | undefined): Promise<RecordedTake>;
}

export interface TakeRecorder {
	/** Resolves once capture has started; throws why it did not. */
	start(request: RecordRequest): Promise<RunningTake>;
}

export interface MediaToolDeps {
	/** The server these tools are served by: their texts say what is true on it. */
	transport: McpTransport;
	/** Whether a client may record and export: the in-app server's "MCP edits". */
	editsAllowed(): boolean;
	/** Records the takes. Default: a hidden record runner, as `openscreen mcp` does. */
	recorder?: TakeRecorder;
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
		"createProject" | "addAsset" | "saveProject" | "filePathFor" | "getProject"
	>;
	openVideo(videoPath: string): Promise<OpenedVideo>;
	/** Frames of a timeline composed as its export would compose them, without exporting: the
	 *  addon's `renderFrames` (`frames` are indices on the `fps` grid, JPEG at most `maxWidth`
	 *  wide). `null`, or absent, when the addon cannot: getFrames then needs an export. */
	renderFrames?(
		clips: CompositorClipInput[],
		sceneJson: string,
		fps: number,
		frames: number[],
		maxWidth: number,
	): Promise<Array<{ index: number; width: number; height: number; jpeg: Buffer }> | null>;
	/** The pointer samples recorded with a video; empty when there are none. */
	readCursor(videoPath: string): Promise<CursorTelemetryPoint[]>;
	/** The document tools' runner: a fresh project's checkpoint and every edit go through it. */
	runTool: McpToolRunner;
	now?(): number;
}

export const MAX_FRAMES = 12;
// Wide enough to read UI text, small enough that a dozen frames stay cheap.
const FRAME_WIDTH = 1280;
/** exportVideo's frame rate when none is asked: the grid getFrames renders on without an export. */
const EXPORT_FPS = 60;
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

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

const GIF_SIZES = Object.keys(GIF_SIZE_PRESETS) as [GifSizePreset, ...GifSizePreset[]];
const MP4_OPTIONS = ["quality", "fps"] as const;
const GIF_OPTIONS = ["gifFrameRate", "gifSize", "gifLoop"] as const;

/** Where a take is made and where it lands, on each server. */
const TAKE_NOTES: Record<McpTransport, string> = {
	http: "Recording is the app's own: startRecording hands over to OpenScreen's recording bar, as the editor's Record button does, so the editor closes for the take, and stopRecording opens the take in the editor, where the user sees each edit land and can undo it. Its zooms on the clicks follow Record mode's Auto-zoom after recording, as for any take.",
	stdio:
		"These projects are in the OpenScreen app's project list, so the user can open one in its editor.",
};

/** The media tools' capability block, placed before the projects-and-checkpoints rules
 *  (`mcpInstructions`) on the server that registers them. */
export function mediaPreamble(transport: McpTransport): string {
	return [
		"OpenScreen records the screen, turns each take into a project you edit with the document tools, and exports it as a video.",
		"A demo goes: listSources, then startRecording, then drive the app, then stopRecording. It returns the projectId and a checkpointId. Edit with the document tools, always passing that projectId: every edit is saved to the project straight away, and restoreCheckpoint with the checkpointId takes the project back to the raw take in one step. Then exportVideo, and getFrames with the projectId to check the export before you hand it over: it takes the same ruler seconds as the document tools, so a trim or a speed region never shifts what you look at.",
		"To edit a video you already have instead, createProject with its videoPath; importMedia adds a video or an audio file to a project.",
		"Drive the app with the real mouse when you can: OpenScreen records the pointer, draws a clean cursor and zooms on the clicks as the editor does: clicks close in time and on screen share one zoom, and the first seconds and the end stay on the whole screen. If you drive it from a script instead (Playwright, CDP), the screen pointer never moves: log each action as the script runs it, then hand the log to setPointerTrack after stopRecording.",
		TAKE_NOTES[transport],
	].join("\n");
}

/** What a client reads of the media tools: their preamble, and the tools themselves. */
export interface MediaTools {
	preamble: string;
	/** Adds the tools to a server. Their state (the take, the exports) is shared by every
	 *  server they are added to: the in-app server builds one per request. */
	register(server: McpServer): void;
}

const START_RECORDING_NOTES: Record<McpTransport, string> = {
	http: "It goes through OpenScreen's recording bar, as the editor's Record button does: the editor closes for the take, so this is refused while the editor has unsaved changes, and the bar's countdown applies. On Linux the system's portal asks the user what to record, whatever window or display says. On macOS the take records the window or display named here, even where the bar otherwise asks in Apple's picker (macOS 15.2 or later); that needs OpenScreen's Screen Recording permission, and without it the call is refused. The bar records with these settings, and gets the user's own back once the take ends.",
	stdio: "On Linux the desktop's own picker asks the user which window to record.",
};

const STOP_RECORDING_DESCRIPTIONS: Record<McpTransport, string> = {
	http: "Stop the recording. OpenScreen's editor opens the take as a new project, as it does after any recording: one clip, plus the zooms planned from the recorded clicks when Record mode's Auto-zoom after recording is on, and autoZooms says how many. Returns the projectId to edit, now open in the editor, a checkpointId that restores the take as it opened, and the take's videoPath.",
	stdio:
		"Stop the recording and turn the take into a new project, laid out as the editor lays out a fresh recording: one clip, plus the zooms planned from the recorded clicks. Not one per click: clicks close in time and on screen share one zoom, a click in the first seconds or the one that stopped the take gets none, and autoZooms says how many there are. Returns the projectId to edit, a checkpointId that restores the raw take, and the take's videoPath.",
};

const CREATE_PROJECT_NOTES: Record<McpTransport, string> = {
	http: "The editor keeps the project it has open: the new one is in OpenScreen's project list, for the user to open.",
	stdio: "It is in the OpenScreen app's project list, so the user can open it in its editor.",
};

const EXPORT_PATH_DESCRIPTIONS: Record<McpTransport, string> = {
	http: "Where to write the video: an absolute path ending in .mp4 or .gif. This server runs inside the app, so it has no working directory of yours to resolve a relative one against.",
	stdio:
		"Where to write the video: an absolute path, or one relative to this server's working directory, ending in .mp4 or .gif.",
};

const GATED_MESSAGE = `Nothing was recorded or exported: OpenScreen lets MCP clients record and export only while the user allows it. Ask the user to turn on ${MCP_EDITS_SETTING}.`;

/** A path a client passed, resolved; `null` for a relative one the in-app server cannot place. */
function clientPath(transport: McpTransport, value: string): string | null {
	if (transport === "http" && !path.isAbsolute(value)) return null;
	return path.resolve(value);
}

export const POINTER_TRACK_TOOL = "setPointerTrack";

const POINTER_EVENTS = z
	.array(
		z.object({
			at: z.number().describe("Epoch milliseconds, from Date.now()."),
			x: z.number().min(0).max(1),
			y: z.number().min(0).max(1),
			click: z.boolean().optional().describe("The action clicked here."),
		}),
	)
	.min(1);

/** setPointerTrack as `openscreen mcp` forwards it to the app: with its takes' start times. */
export const FORWARDED_POINTER_TRACK_SCHEMA = z.object({
	projectId: z.string(),
	events: POINTER_EVENTS,
	/** When each take of the session started, by its video path. */
	takes: z.record(z.string(), z.number()),
});

/**
 * setPointerTrack's change: the new sidecar, and the zooms planned on its clicks. Computed
 * by the runner's process (the app's, when it runs), and written by that runner.
 */
export async function pointerTrackEdit(
	document: AxcutDocument,
	events: PointerEvent[],
	takes: Readonly<Record<string, number>>,
): ReturnType<RunnerEdit> {
	const asset = document.assets.find((a) => a.id === document.project.primaryAssetId);
	const startedAt = asset ? takes[asset.originalPath] : undefined;
	if (!asset || startedAt === undefined || !asset.durationSec) {
		return {
			ok: false,
			resultJson:
				"This project's take was not recorded by this server, so its start time is unknown. setPointerTrack only works on a take from stopRecording.",
		};
	}
	const samples = pointerSamples(events, startedAt, asset.durationSec * 1000);
	const sidecar: CursorRecordingData = { version: 2, provider: "native", samples, assets: [] };
	// Planned from the new track before it is on disk, as readCursor would read it back.
	const suggestions = await collectAutoZoomSuggestionsForDocument(
		document,
		async () =>
			samples.map(({ timeMs, cx, cy, visible, interactionType }) => ({
				timeMs,
				cx,
				cy,
				visible,
				interactionType,
			})),
		(candidate) => candidate.id === asset.id,
	);
	return {
		ok: true,
		resultJson: JSON.stringify({ samples: samples.length, autoZoomsAdded: suggestions.length }),
		document: appendAutoZoomSuggestions(document, suggestions),
		sidecars: [{ path: `${asset.originalPath}.cursor.json`, content: JSON.stringify(sidecar) }],
	};
}

type Run = ReturnType<MediaToolDeps["runners"]["start"]>;

/** A runner's result, its hidden window closed: the server outlives every runner. */
async function finish(run: Run): Promise<CliDoneResult> {
	try {
		return await run.done;
	} finally {
		run.close();
	}
}

/** The webcam recorded with a take, as the editor links it to the take's asset. */
interface TakeCamera {
	path: string;
	offsetMs: number;
}

/** The take as a project, laid out as the editor lays out a fresh recording. */
async function createProjectFromVideo(
	deps: MediaToolDeps,
	videoPath: string,
	title: string,
	camera: TakeCamera | null,
) {
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
	// Its size decides the picture-in-picture's box, as the editor stamps it when it links the
	// camera (projectStore.ts). A camera that cannot be read costs the box its size, not the take.
	const cameraSize = camera
		? await deps.openVideo(camera.path).then(
				(opened) => {
					opened.close();
					return opened.width > 0 && opened.height > 0
						? { width: opened.width, height: opened.height }
						: {};
				},
				() => ({}),
			)
		: {};
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
						...(camera
							? {
									cameraTrack: {
										sourcePath: camera.path,
										startMs: 0,
										// An integer, as the schema wants: the native paths measure it in fractions.
										offsetMs: Math.round(camera.offsetMs),
										visible: true,
										...cameraSize,
									},
								}
							: {}),
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
	// The zooms a recording made in the app starts with, planned from its clicks (zoom-suggestions.ts).
	const suggestions = await collectAutoZoomSuggestionsForDocument(seeded.document, deps.readCursor);
	const saved = await deps.documents.saveProject(
		appendAutoZoomSuggestions(seeded.document, suggestions),
	);
	return { document: saved, durationSec, autoZooms: suggestions.length };
}

/** `openscreen mcp`'s recorder: a hidden record runner, and the take laid out as a project here. */
function runnerRecorder(deps: MediaToolDeps): TakeRecorder {
	const now = deps.now ?? Date.now;
	return {
		async start(request) {
			let markStarted: () => void = () => undefined;
			const started = new Promise<"started">((resolve) => {
				markStarted = () => resolve("started");
			});
			const run = deps.runners.start(
				{
					kind: "record",
					...request,
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
				throw new Error(outcome.error ?? "unknown error");
			}
			const startedAt = now();
			return {
				startedAt,
				async stop(title) {
					try {
						run.window.webContents.send("cli-stop-recording");
					} catch {
						// The runner already went away; its result says why.
					}
					const result = await finish(run);
					if (!result.success || !result.screenVideoPath) {
						throw new Error(`The recording failed: ${result.error ?? "unknown error"}`);
					}
					try {
						const project = await createProjectFromVideo(
							deps,
							result.screenVideoPath,
							title || `Recording ${new Date(startedAt).toLocaleString()}`,
							result.webcamVideoPath
								? { path: result.webcamVideoPath, offsetMs: result.webcamOffsetMs ?? 0 }
								: null,
						);
						return {
							projectId: project.document.project.id,
							videoPath: result.screenVideoPath,
							durationSec: project.durationSec,
							autoZooms: project.autoZooms,
							...(result.warnings?.length ? { warnings: result.warnings } : {}),
						};
					} catch (error) {
						// The take is on disk all the same: say where, so it can still be looked at.
						throw new Error(
							`The take was saved to ${result.screenVideoPath}, but it could not be turned into a project: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
				},
			};
		},
	};
}

/** The take startRecording claimed: `running` once capture has started. */
interface TakeSlot {
	running: RunningTake | null;
	stopping: boolean;
}

export function createMediaTools(deps: MediaToolDeps): MediaTools {
	const { transport } = deps;
	const recorder = deps.recorder ?? runnerRecorder(deps);
	/** The take being recorded, then saved: held until it is a project. */
	let take: TakeSlot | null = null;
	// A take and an export never run together: each is a heavy job of its own, and a
	// take's capture must not lose frames to an export.
	let exporting = false;
	/** When each take of this session started, by its video: setPointerTrack's clock. */
	const startedAtByVideo = new Map<string, number>();
	/** Each project's last export of this session, and when it was made: what getFrames reads. */
	const lastExports = new Map<string, { path: string; at: Date; rendered: AxcutDocument }>();

	/** getFrames when no export shows the project as it is (`docs/shader-effects.md`, E.4): its
	 *  frames composed as its export would compose them, on the export's default frame grid,
	 *  without encoding a video. `null` when the addon cannot render them: the export decides. */
	async function renderProjectFrames(
		document: AxcutDocument,
		atSec: number[] | null,
		count: number,
		why: string,
	): Promise<CallToolResult | null> {
		if (!deps.renderFrames) return null;
		// The frame grid below counts every clip, the render only those with media: past a clip
		// without one, the two would disagree on which frame a moment is.
		const paths = new Map(document.assets.map((asset) => [asset.id, asset.originalPath]));
		if (document.timeline.clips.some((clip) => !paths.get(clip.assetId))) {
			return text("A clip on this timeline has no media file: its frames cannot be placed.", true);
		}
		const clips = buildNativeClipList(document);
		if (clips.length === 0) return text("This project's timeline has no clip to show.", true);
		const rulerEndSec = Math.max(0, ...document.timeline.clips.map((clip) => clip.timelineEndSec));
		const times = frameTimes(rulerEndSec, atSec, count);
		// The output frame showing at that moment: the last one that starts at or before it.
		const indices = times.map((sec) =>
			Math.floor(programmeSecOf(document, sec) * EXPORT_FPS + 1e-6),
		);
		let frames: Awaited<ReturnType<NonNullable<MediaToolDeps["renderFrames"]>>>;
		try {
			const scene = JSON.stringify(buildSceneDescription(document));
			frames = await deps.renderFrames(clips, scene, EXPORT_FPS, indices, FRAME_WIDTH);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return text(`The frames could not be rendered: ${message}`, true);
		}
		if (!frames) return null;
		const byIndex = new Map(frames.map((frame) => [frame.index, frame]));
		const content: CallToolResult["content"] = [
			{
				type: "text",
				text: `${times.length} frame(s) rendered from the project as its export would show them: ${why}.`,
			},
		];
		times.forEach((sec, i) => {
			content.push({ type: "text", text: `${sec.toFixed(2)}s on the ruler` });
			const frame = byIndex.get(indices[i]);
			content.push(
				frame
					? { type: "image", data: frame.jpeg.toString("base64"), mimeType: "image/jpeg" }
					: { type: "text", text: "No frame here: the rendered video ends before it." },
			);
		});
		return { content };
	}

	/** A fresh project's checkpoint, so a client can edit it at once and take it back in one step. */
	async function checkpointOf(projectId: string): Promise<string | null> {
		// Never fails the call: the project exists either way, and its id is the answer.
		try {
			const checkpoint = await deps.runTool("createCheckpoint", { projectId });
			const checkpointText =
				checkpoint.content[0]?.type === "text" ? checkpoint.content[0].text : "";
			return checkpoint.isError
				? null
				: ((JSON.parse(checkpointText) as { checkpointId?: string }).checkpointId ?? null);
		} catch {
			return null;
		}
	}

	/** Stops the take, then hands back its project with a checkpoint of it. */
	async function stopTake(
		running: RunningTake,
		requestedTitle: string | undefined,
	): Promise<CallToolResult> {
		let recorded: RecordedTake;
		try {
			recorded = await running.stop(requestedTitle?.trim() || undefined);
		} catch (error) {
			return text(error instanceof Error ? error.message : String(error), true);
		}
		startedAtByVideo.set(recorded.videoPath, running.startedAt);
		const { projectId } = recorded;
		return text(
			JSON.stringify({
				projectId,
				checkpointId: await checkpointOf(projectId),
				videoPath: recorded.videoPath,
				durationSec: recorded.durationSec,
				recordingStartedAt: running.startedAt,
				autoZooms: recorded.autoZooms,
				...(recorded.warnings?.length ? { warnings: recorded.warnings } : {}),
			}),
		);
	}

	function register(server: McpServer): void {
		server.registerTool(
			"listSources",
			{
				description: `List the displays and windows OpenScreen can record, the microphones and the cameras. Pass startRecording a display's index or part of a window's title, and part of a microphone's or a camera's name. microphoneLabelsUnavailable or cameraLabelsUnavailable true means their names need a permission the user has not granted, so the list is empty: ask the user to allow it. ${HIDDEN_WINDOWS_NOTE}`,
				inputSchema: z.object({}),
				annotations: READ_ONLY,
			},
			async () => {
				const result = await finish(deps.runners.start({ kind: "sources" }));
				if (!result.success || !result.sources) {
					return text(`Could not list the sources: ${result.error ?? "unknown error"}`, true);
				}
				const { displays, windows, microphones, cameras } = result.sources;
				return text(
					JSON.stringify({
						displays: displays.map(({ index, name }) => ({ index, name })),
						windows: windows.map((window) => window.name),
						microphones: microphones.map((mic) => mic.label),
						cameras: cameras.map((camera) => camera.label),
						// An empty list is not "none" when the names need a permission: say which.
						microphoneLabelsUnavailable: result.sources.microphoneLabelsUnavailable,
						cameraLabelsUnavailable: result.sources.cameraLabelsUnavailable,
					}),
				);
			},
		);

		server.registerTool(
			"startRecording",
			{
				description: `Start recording one window (preferred: nothing else on the desktop is captured) or one display. Returns once capture has started; then drive the app and call stopRecording. By default the pointer is recorded as data, so the export draws a clean cursor and the zooms planned from the clicks. A webcam recorded with it shows as a picture-in-picture in the project. Hiding the desktop icons follows the user's own Record mode setting. ${START_RECORDING_NOTES[transport]}`,
				inputSchema: z.object({
					window: z
						.string()
						.optional()
						.describe(
							"Part of the title of the window to record, ignoring case. Wins over display.",
						),
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
					camera: z
						.union([z.boolean(), z.string()])
						.optional()
						.describe(
							"Also record the webcam: true for the default camera, or part of a camera's name.",
						),
					cursor: z
						.enum(["editable-overlay", "system"])
						.optional()
						.describe(
							"editable-overlay (default): the pointer is recorded as data, drawn clean by the export, with zooms on its clicks. system: the system's own pointer is burned into the video, with no zooms on clicks and no setPointerTrack.",
						),
				}),
				annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			},
			async (args) => {
				if (!deps.editsAllowed()) return text(GATED_MESSAGE, true);
				if (take?.stopping) {
					return text("The last take is still being saved. Try again in a moment.", true);
				}
				if (take) return text("A recording is already running. Call stopRecording first.", true);
				if (exporting) return text("An export is running. Wait for it, then try again.", true);
				// Claimed before the first await, so a second call cannot start a second take.
				const claimed: TakeSlot = { running: null, stopping: false };
				take = claimed;
				try {
					claimed.running = await recorder.start({
						displayIndex: args.display ?? 0,
						windowTitle: args.window ?? null,
						mic: args.microphone !== undefined && args.microphone !== false,
						micDevice: typeof args.microphone === "string" ? args.microphone : null,
						systemAudio: args.systemAudio === true,
						camera: args.camera !== undefined && args.camera !== false,
						cameraDevice: typeof args.camera === "string" ? args.camera : null,
						cursorMode: args.cursor ?? "editable-overlay",
					});
				} catch (error) {
					take = null;
					return text(
						`The recording did not start: ${error instanceof Error ? error.message : String(error)}`,
						true,
					);
				}
				return text(
					JSON.stringify({ recording: true, startedAt: claimed.running.startedAt }) +
						"\nRecording. Drive the app now, pausing about a second after each result appears, then call stopRecording.",
				);
			},
		);

		server.registerTool(
			"stopRecording",
			{
				description: STOP_RECORDING_DESCRIPTIONS[transport],
				inputSchema: z.object({
					title: z.string().optional().describe("The project's title in OpenScreen."),
				}),
				annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			},
			async (args) => {
				const current = take;
				if (!current?.running) {
					return text(
						current ? "The recording is still starting." : "No recording is running.",
						true,
					);
				}
				if (current.stopping) return text("This recording is already being stopped.", true);
				// Claimed before the first await, so a second call cannot save the same take twice.
				current.stopping = true;
				try {
					return await stopTake(current.running, args.title);
				} finally {
					take = null;
				}
			},
		);

		server.registerTool(
			"setPointerTrack",
			{
				description: [
					"For a take driven by a script (Playwright, CDP, a browser extension) rather than the real mouse: the screen pointer never moved, so the video has no cursor and no zoom. Give the pointer's path here and OpenScreen draws it, gliding between your actions, and zooms on its clicks as for a real mouse. It replaces the pointer recorded with the take, then plans zooms on the new clicks as stopRecording does, clear of the zooms already there; autoZoomsAdded says how many. Only for a take recorded by this server. It is an edit like any other: on a project that is not open in the editor it needs a checkpoint (stopRecording made one), and restoreCheckpoint undoes it, the pointer track included.",
					"events, one per action: `at` is Date.now() when your script did it (log it as it runs; the take's recordingStartedAt is on the same clock). `x` and `y` are fractions (0 to 1) of the recorded window. For a point (clientX, clientY) of a page shown in that window, from inside the page: border = (outerWidth - innerWidth) / 2; x = (border + clientX) / outerWidth; y = (outerHeight - innerHeight - border + clientY) / outerHeight.",
				].join("\n"),
				inputSchema: z.object({ projectId: z.string(), events: POINTER_EVENTS }),
				annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
			},
			// Through the document tools' runner, like any edit: the same queue, the same refusals
			// (edits turned off, a project open in the app's editor, one with no checkpoint) before
			// anything is written, and the sidecar kept by the checkpoints so restoreCheckpoint puts
			// it back. The args carry what the edit needs, so a running app can compute it
			// (app-channel.ts).
			(args) => {
				const takes = Object.fromEntries(startedAtByVideo);
				return deps.runTool(
					POINTER_TRACK_TOOL,
					{ projectId: args.projectId, events: args.events, takes },
					{ edit: (document) => pointerTrackEdit(document, args.events, takes) },
				);
			},
		);

		server.registerTool(
			"exportVideo",
			{
				description:
					"Render a project to an MP4 (H.264) or a GIF with OpenScreen's compositor: the background, cursor, zooms, cuts, speed changes and annotations as edited. Returns the file's path; call getFrames with the projectId to check it at the ruler seconds you edited with. The video's shape follows the project's format (setAspectRatio). The options are the Export dialog's: quality and fps for an MP4; gifFrameRate, gifSize and gifLoop for a GIF.",
				inputSchema: z.object({
					projectId: z.string(),
					path: z.string().describe(EXPORT_PATH_DESCRIPTIONS[transport]),
					quality: z
						.enum(["medium", "good", "source"])
						.optional()
						.describe(
							"MP4 only. The height: medium is 720 pixels, good is 1080 (default), source keeps the recording's. The width follows the format.",
						),
					fps: z
						.literal(MP4_FRAME_RATES)
						.optional()
						.describe("MP4 only. Frames per second. Default 60."),
					gifFrameRate: z
						.literal(VALID_GIF_FRAME_RATES)
						.optional()
						.describe("GIF only. Frames per second. Default 15."),
					gifSize: z
						.enum(GIF_SIZES)
						.optional()
						.describe(
							`GIF only. The largest height in pixels, never upscaled: ${GIF_SIZES.map((size) => `${size} ${Number.isFinite(GIF_SIZE_PRESETS[size].maxHeight) ? GIF_SIZE_PRESETS[size].maxHeight : "keeps the recording's"}`).join(", ")}. Default medium.`,
						),
					gifLoop: z
						.boolean()
						.optional()
						.describe("GIF only. Loop forever (default) or play once."),
				}),
				annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			},
			async (args, extra) => {
				if (!deps.editsAllowed()) return text(GATED_MESSAGE, true);
				if (take) return text("A recording is running. Stop it before exporting.", true);
				if (exporting)
					return text("An export is already running. Wait for it, then try again.", true);
				const outPath = clientPath(transport, args.path);
				if (!outPath) return text(`The path must be absolute, got "${args.path}".`, true);
				const extension = path.extname(outPath).toLowerCase();
				if (extension !== ".mp4" && extension !== ".gif") {
					return text(`The path must end in .mp4 or .gif, got "${args.path}".`, true);
				}
				const gif = extension === ".gif";
				// The dialog offers each format its own options only: one for the other would do nothing.
				const misplaced = (gif ? MP4_OPTIONS : GIF_OPTIONS).filter(
					(option) => args[option] !== undefined,
				);
				if (misplaced.length > 0) {
					return text(
						`${misplaced.join(", ")}: not for ${gif ? "a GIF" : "an MP4"}. The path's extension picks the format.`,
						true,
					);
				}
				const progressToken = extra._meta?.progressToken;
				exporting = true;
				try {
					// The project as the export reads it, and when: getFrames maps ruler seconds through
					// THIS document's cuts and speeds, and calls anything saved after `at` a change the
					// video does not have.
					const at = new Date();
					const rendered = await deps.documents.getProject(args.projectId).catch(() => null);
					if (!rendered) return text(`No project has the id "${args.projectId}".`, true);
					const run = deps.runners.start(
						{
							kind: "export",
							projectPath: deps.documents.filePathFor(args.projectId),
							// Read by id, as the editor opens a project: nothing of the app's own state moves.
							projectId: args.projectId,
							outPath,
							format: gif ? "gif" : "mp4",
							// The Export dialog's defaults, not whatever an older editor stored.
							// A GIF carries no quality: the export runner refuses one, and gifSize sizes it.
							quality: gif ? null : (args.quality ?? "good"),
							mp4FrameRate: args.fps ?? EXPORT_FPS,
							gifFrameRate: args.gifFrameRate ?? 15,
							gifSizePreset: args.gifSize ?? "medium",
							gifLoop: args.gifLoop ?? true,
							// No zooms or voiceover added at export: they are edits of the project
							// (addZoom, setPointerTrack, addAudio), or the video is not what getFrames reads.
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
					const written = result.outputPath ?? outPath;
					// The file now holds this video: no other project's record may still point at it.
					for (const [id, record] of lastExports) {
						if (id !== args.projectId && record.path === written) lastExports.delete(id);
					}
					// The runner read the project file itself. Unless nothing was saved since `rendered`
					// was read, it may have rendered another version, so this video gets no record.
					const after = await deps.documents.getProject(args.projectId).catch(() => null);
					if (after?.project.updatedAt !== rendered.project.updatedAt) {
						lastExports.delete(args.projectId);
						return text(
							`${JSON.stringify({ path: result.outputPath, format: result.format, width: result.width, height: result.height })}\nThe project changed while it exported, so this video may not match it: export again before checking it with getFrames.`,
						);
					}
					lastExports.set(args.projectId, { path: written, at, rendered });
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
					"To check an edit, pass projectId: atSec are the ruler seconds the document tools use, mapped through the trims and speed regions to the moment the export plays them. You get the project's last export, or, when it has none or has changed since, the frames its export would show, rendered from the project without exporting it. With path instead, you get any video file (a take's videoPath, say) and atSec are that file's own seconds.",
				].join("\n"),
				inputSchema: z.object({
					projectId: z
						.string()
						.optional()
						.describe("Look at this project: its last export, or the frames an export would show."),
					path: z
						.string()
						.optional()
						.describe(
							transport === "http"
								? "Or look at this video file, by its absolute path."
								: "Or look at this video file.",
						),
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
					// A project deleted since still left its export on disk: show it, unflagged.
					const current = await deps.documents.getProject(args.projectId).catch(() => null);
					const stale =
						exported !== undefined &&
						current !== null &&
						Date.parse(current.project.updatedAt) > exported.at.getTime();
					// No export shows the project as it is: render its frames as an export would.
					if (current && (!exported || stale)) {
						const why = exported ? "it changed after its last export" : "it has no export yet";
						const rendered = await renderProjectFrames(
							current,
							args.atSec ?? null,
							args.count ?? 6,
							why,
						);
						if (rendered) return rendered;
					}
					if (!exported) {
						return text("This project has no export yet: call exportVideo first.", true);
					}
					// Mapped through the document the export rendered, so a cut made since cannot shift
					// which frame of this video is shown; the current one only says whether it is stale.
					const { rendered } = exported;
					videoPath = exported.path;
					toVideoSec = (sec) => programmeSecOf(rendered, sec);
					rulerEndSec = Math.max(0, ...rendered.timeline.clips.map((clip) => clip.timelineEndSec));
					if (stale) {
						note = " The project changed after this export: export it again to see the changes.";
					}
				} else {
					const resolved = clientPath(transport, args.path ?? "");
					if (!resolved) return text(`The path must be absolute, got "${args.path}".`, true);
					videoPath = resolved;
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

		server.registerTool(
			"createProject",
			{
				description: [
					"Create a new project, in the look new projects start with in OpenScreen (the style preset marked for them, else the last edited project's), as the editor's New does. Empty, or from a video file laid out as one clip, as the editor lays out an opened video, with zooms planned from the clicks when the video is an OpenScreen recording with its pointer track; autoZooms says how many.",
					`Returns the projectId to edit and a checkpointId that restores the project as it was created. Fill an empty one with importMedia. ${CREATE_PROJECT_NOTES[transport]}`,
				].join("\n"),
				inputSchema: z.object({
					title: z
						.string()
						.optional()
						.describe(
							"The project's title in OpenScreen. Default: the video's file name, or Untitled Project.",
						),
					videoPath: z
						.string()
						.optional()
						.describe(
							"Absolute path of a video (.mp4, .mov, .m4v, .webm, .mkv, .avi, .wmv) to start from. Omit it for an empty project.",
						),
				}),
				annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			},
			async (args) => {
				if (!deps.editsAllowed()) {
					return text(
						`No project was created: OpenScreen lets MCP clients create projects only while the user allows it. Ask the user to turn on ${MCP_EDITS_SETTING}.`,
						true,
					);
				}
				const title = args.title?.trim();
				if (args.videoPath === undefined) {
					let projectId: string;
					try {
						projectId = (await deps.documents.createProject(title ?? "")).project.id;
					} catch (error) {
						return text(
							`No project was created: ${error instanceof Error ? error.message : String(error)}`,
							true,
						);
					}
					return text(JSON.stringify({ projectId, checkpointId: await checkpointOf(projectId) }));
				}
				const videoPath = args.videoPath;
				const problem = await mediaPathProblem(videoPath, "video");
				if (problem) return text(problem, true);
				let project: Awaited<ReturnType<typeof createProjectFromVideo>>;
				try {
					project = await createProjectFromVideo(
						deps,
						videoPath,
						title || path.parse(videoPath).name,
						// A video from elsewhere: no webcam recorded beside it here.
						null,
					);
				} catch (error) {
					return text(
						`No project was created: ${error instanceof Error ? error.message : String(error)}`,
						true,
					);
				}
				const projectId = project.document.project.id;
				return text(
					JSON.stringify({
						projectId,
						checkpointId: await checkpointOf(projectId),
						durationSec: project.durationSec,
						autoZooms: project.autoZooms,
					}),
				);
			},
		);
	}

	return { preamble: mediaPreamble(transport), register };
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
